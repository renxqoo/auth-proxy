import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  getAdminRepo,
  getTokenRepo,
  getAppRepo,
  getAuditRepo,
  getScopeRepo,
  getRoutePolicyRepo,
} from "../repos/index.js";
import { revokeSessionsByClient, createSession } from "../sessionStore.js";
import { loginAsCompany } from "../companyAuth.js";
import { signAccessToken, signRefreshToken } from "../jwt.js";
import { safeError } from "../config.js";
import {
  requireAdminSession,
  issueSessionCookieValue,
  COOKIE_NAME,
  type AdminSession,
} from "../middleware/adminSession.js";
import { rateLimit, getClientIp } from "../middleware/rateLimit.js";
import { config } from "../config.js";

/**
 * /admin/web —— 后台 Web 用的 API(session cookie 鉴权,必须登录后台)。
 *
 * 鉴权:除 login 外,都要 admin session cookie(见 requireAdminSession)。
 *
 * 端点:
 *   POST   /admin/web/login          { username, password } → 签发 cookie
 *   POST   /admin/web/logout         → 清 cookie
 *   GET    /admin/web/me             → 当前管理员
 *   GET    /admin/web/overview       → 概览计数
 *   GET    /admin/web/tokens         → 令牌列表(含使用计数)
 *   POST   /admin/web/tokens         → 创建令牌 { name, expiresDays }
 *   DELETE /admin/web/tokens/:id     → 吊销令牌
 *   GET    /admin/web/apps           → client 列表
 *   POST   /admin/web/apps/:id/revoke   → 吊销 client
 *   POST   /admin/web/apps/:id/unrevoke → 恢复 client
 *   GET    /admin/web/audit/login    → 登录审计
 *   GET    /admin/web/audit/api      → API 调用审计
 *   GET    /admin/web/admins         → 管理员列表
 *   POST   /admin/web/admins         → 创建管理员 { username, password }
 *   POST   /admin/web/admins/:id/password → 改密码(改自己须带 oldPassword)
 *   POST   /admin/web/admins/:id/rename   → 改用户名(改自己后重发 cookie)
 *   DELETE /admin/web/admins/:id     → 删除管理员(至少保留一个;不能删自己)
 */

// session 注入到 context 的类型
type AdminEnv = { Variables: { adminSession: AdminSession } };

export const adminWeb = new Hono<AdminEnv>();

/**
 * 输入长度上限。
 * 安全动机:password 会进 scryptSync(同步阻塞 event loop)。
 * 不限长度时,攻击者发 10MB 密码就能让单次请求阻塞数秒 → DoS。
 * 1024 字节远超任何合理密码上限(passphrase 场景也够用)。
 */
const MAX_USERNAME_LEN = 256;
const MAX_PASSWORD_LEN = 1024;
const MAX_NAME_LEN = 256;
const MAX_EXPIRES_DAYS = 3650; // 10 年上限,防恶意设百万天

// ---------- 登录/登出/me(无需 session)----------
// admin 登录按 IP 限流(防在线爆破)。原本缺失,补齐。
adminWeb.use(
  "/login",
  rateLimit({
    windowMs: config.rateLimit.adminLoginWindowMs,
    limit: config.rateLimit.adminLoginMax,
    prefix: "rl:admin-login",
    keyGenerator: getClientIp,
  }),
);

adminWeb.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "username/password required",
      },
      400,
    );
  }
  // 长度上限:防 DoS(超长密码进 scrypt 阻塞 event loop)
  if (
    username.length > MAX_USERNAME_LEN ||
    password.length > MAX_PASSWORD_LEN
  ) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "username/password too long",
      },
      400,
    );
  }
  const admin = await getAdminRepo().verifyPassword(username, password);
  if (!admin) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  // 签发 session cookie
  const value = issueSessionCookieValue(admin.id, admin.username);
  setCookie(c, COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: config.adminSessionTtlSec,
    secure: config.tls.enabled, // TLS 启用时才 secure
  });
  return c.json({ id: admin.id, username: admin.username });
});

adminWeb.post("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// ---------- 以下都需要 session ----------
adminWeb.use("/*", requireAdminSession);

adminWeb.get("/me", (c) => {
  const s = c.get("adminSession");
  return c.json({ id: s.adminId, username: s.username });
});

// ---------- 概览 ----------
adminWeb.get("/overview", async (c) => {
  const [tokens, apps] = await Promise.all([
    getTokenRepo().list(),
    getAppRepo().list(),
  ]);
  const activeTokens = tokens.filter(
    (t) => !t.revoked && t.expiresAt.getTime() > Date.now(),
  ).length;
  const activeApps = apps.filter((a) => !a.revoked).length;
  return c.json({
    tokens: { total: tokens.length, active: activeTokens },
    apps: { total: apps.length, active: activeApps },
  });
});

// ---------- 令牌管理 ----------
adminWeb.get("/tokens", async (c) => {
  const list = await getTokenRepo().list();
  return c.json({ tokens: list });
});

adminWeb.post("/tokens", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const expiresDays = Number(body?.expiresDays);
  const singleUse = body?.singleUse !== false; // 默认一次性
  if (
    !name ||
    name.length > MAX_NAME_LEN ||
    !Number.isFinite(expiresDays) ||
    expiresDays <= 0 ||
    expiresDays > MAX_EXPIRES_DAYS
  ) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "name + expiresDays required (expiresDays <= 3650)",
      },
      400,
    );
  }
  const rec = await getTokenRepo().create({ name, expiresDays, singleUse });
  return c.json(rec, 201);
});

adminWeb.delete("/tokens/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const ok = await getTokenRepo().revoke(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---------- client 管理 ----------
adminWeb.get("/apps", async (c) => {
  const list = await getAppRepo().list();
  return c.json({ apps: list });
});

// 踢下线:吊销该 client 的所有活跃 session(旧 JWT 立即失效),但 client 仍可重新登录。
// 适合"强制某机器重新登录"的场景。
adminWeb.post("/apps/:id/kick", async (c) => {
  const id = Number(c.req.param("id"));
  const app = await getAppRepo().findById(id);
  if (!app) return c.json({ error: "not_found" }, 404);
  const n = (await revokeSessionsByClient(app.clientId)).length;
  return c.json({ ok: true, sessionsRevoked: n });
});

// 彻底删除 client:之后该 client 不能再登录(verifyClient 查不到)。
// 需要重新 register 才能用。
adminWeb.delete("/apps/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const app = await getAppRepo().findById(id);
  if (!app) return c.json({ error: "not_found" }, 404);
  await revokeSessionsByClient(app.clientId);
  await getAppRepo().delete(id);
  return c.json({ ok: true });
});

// 设置 client 允许的 scope 子集(层 3:client 绑定)。
// body: { scopes: string[] } — 每个 scope 必须在全局 scopes 表里定义过。
// 空数组 = 允许全部已定义 scope(向后兼容默认)。
adminWeb.post("/apps/:id/scopes", async (c) => {
  const id = Number(c.req.param("id"));
  const app = await getAppRepo().findById(id);
  if (!app) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const scopes = Array.isArray(body?.scopes)
    ? body.scopes.filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
    : null;
  if (scopes === null) {
    return c.json(
      { error: "invalid_request", error_description: "scopes[] required" },
      400,
    );
  }
  // 校验:每个 scope 必须在全局定义内(防注入未定义 scope)
  const { names: globalNames } = await getScopeRepo().getSets();
  if (globalNames.size > 0) {
    for (const s of scopes) {
      if (!globalNames.has(s)) {
        return c.json(
          {
            error: "invalid_request",
            error_description: `scope ${s} is not defined in global scopes`,
          },
          400,
        );
      }
    }
  }
  const ok = await getAppRepo().setAllowedScopes(id, scopes);
  return ok ? c.json({ ok: true, allowedScopes: scopes }) : c.json({ error: "not_found" }, 404);
});

// ---------- scope 定义管理(层 1:全局定义)----------
adminWeb.get("/scopes", async (c) => {
  const list = await getScopeRepo().list();
  return c.json({ scopes: list });
});

adminWeb.post("/scopes", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  const isSystem = body?.isSystem === true;
  if (!name || name.length > MAX_NAME_LEN) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "name required (<=256 chars)",
      },
      400,
    );
  }
  const rec = await getScopeRepo().create({ name, description, isSystem });
  if (!rec) {
    return c.json(
      { error: "conflict", error_description: "scope name already exists" },
      409,
    );
  }
  return c.json(rec, 201);
});

adminWeb.delete("/scopes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await getScopeRepo().findById(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.isSystem) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "system scopes cannot be deleted",
      },
      400,
    );
  }
  const ok = await getScopeRepo().delete(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---------- 路径策略管理(层 4:gateway scope 校验)----------
adminWeb.get("/route-policies", async (c) => {
  const list = await getRoutePolicyRepo().list();
  return c.json({ policies: list });
});

// body: { pattern, scope?, method?, description? }
// scope 为空/null → 只需有效登录的策略(如 /me);非空须校验 ∈ 全局定义
adminWeb.post("/route-policies", async (c) => {
  const body = await c.req.json().catch(() => null);
  const pattern = typeof body?.pattern === "string" ? body.pattern.trim() : "";
  const scopeRaw = typeof body?.scope === "string" ? body.scope.trim() : "";
  const method = typeof body?.method === "string" ? body.method.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  if (!pattern || pattern.length > MAX_NAME_LEN) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "pattern required (<=256 chars)",
      },
      400,
    );
  }
  const scope = scopeRaw || null;
  // scope 非空时校验必须在全局定义内
  if (scope) {
    const { names: globalNames } = await getScopeRepo().getSets();
    if (globalNames.size > 0 && !globalNames.has(scope)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: `scope ${scope} is not defined in global scopes`,
        },
        400,
      );
    }
  }
  const rec = await getRoutePolicyRepo().create({
    pattern,
    scope,
    method: method || null,
    description,
  });
  return c.json(rec, 201);
});

adminWeb.delete("/route-policies/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = await getRoutePolicyRepo().findById(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const ok = await getRoutePolicyRepo().delete(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---------- admin 签发 agent token(sandbox/CI 场景)----------
// 管理员为指定用户预签发 token,注入 sandbox 环境变量,无需 device flow。
// 审计:记录谁(admin)为谁(username)签发了什么 scope 的 token。
adminWeb.post("/issue-token", async (c) => {
  const adminSession = c.get("adminSession");
  const body = await c.req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const scopeRaw = typeof body?.scope === "string" ? body.scope.trim() : "";
  const expiresInSec = Number(body?.expiresInSec);

  if (!username) {
    return c.json(
      { error: "invalid_request", error_description: "username required" },
      400,
    );
  }

  // TTL 校验(防永久 token)
  const ttl =
    Number.isFinite(expiresInSec) && expiresInSec > 0
      ? Math.min(expiresInSec, config.agentTokenMaxTtlSec)
      : config.jwtAccessTtlSec;

  // 1. 通过公司应用管理端点获取该用户的 company token(不需要密码)
  let companyToken;
  try {
    companyToken = await loginAsCompany(username);
  } catch (e) {
    safeError("[admin] issue-token: loginAsCompany failed:", e);
    return c.json(
      { error: "invalid_request", error_description: `cannot issue token for '${username}'` },
      400,
    );
  }

  // 2. scope 校验(层 1 全局 + 层 2 用户权限收窄)
  const requestedScope = scopeRaw || "offline_access";
  const requestedScopes = requestedScope.split(/\s+/).filter((s: string) => s.length > 0);
  // 全局定义校验
  const { names: globalNames } = await getScopeRepo().getSets();
  if (globalNames.size > 0) {
    for (const s of requestedScopes) {
      if (!globalNames.has(s)) {
        return c.json(
          { error: "invalid_request", error_description: `unknown scope: ${s}` },
          400,
        );
      }
    }
  }
  // 用户权限收窄:请求的 scope 必须是用户实际拥有的(companyToken.user.scopes)
  const userScopeSet = new Set(companyToken.user.scopes);
  const { systemNames } = await getScopeRepo().getSets();
  const systemSet =
    systemNames.size > 0
      ? systemNames
      : new Set(config.systemScopes.split(/\s+/).filter(Boolean));
  for (const s of requestedScopes) {
    if (systemSet.has(s)) continue;
    if (!userScopeSet.has(s)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: `user '${username}' does not have scope: ${s}`,
        },
        400,
      );
    }
  }
  // offline_access 自动补
  if (!requestedScopes.includes("offline_access")) {
    requestedScopes.push("offline_access");
  }
  const finalScope = requestedScopes.join(" ");

  // 3. 创建 session(标记为 agent 类型)
  const session = await createSession(companyToken, finalScope, `admin-issued`);

  // 4. 签发 JWT + refresh token
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(session.sessionId, finalScope, `admin-issued`),
    signRefreshToken(session.sessionId, session.refreshId),
  ]);

  // 5. 审计:记录谁为谁签了什么
  void getAuditRepo().writeLoginLog({
    userCode: "",
    username: `${username} [ADMIN-ISSUED by ${adminSession.username}]`,
    clientId: "admin-issued",
    success: true,
  });

  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: refreshToken,
    scope: finalScope,
    sessionId: session.sessionId,
    user: { id: companyToken.user.id, name: companyToken.user.name },
    hint: "Inject this token into the agent's environment (e.g. RXCLI_BEARER_TOKEN or credentials file)",
  });
});

// ---------- 审计 ----------
adminWeb.get("/audit/login", async (c) => {
  const limit = clampLimit(c.req.query("limit"));
  const logs = await getAuditRepo().recentLoginLogs(limit);
  return c.json({ logs });
});

adminWeb.get("/audit/api", async (c) => {
  const limit = clampLimit(c.req.query("limit"));
  const logs = await getAuditRepo().recentApiLogs(limit);
  return c.json({ logs });
});

// ---------- 管理员管理 ----------
adminWeb.get("/admins", async (c) => {
  const list = await getAdminRepo().list();
  return c.json({ admins: list });
});

adminWeb.post("/admins", async (c) => {
  const body = await c.req.json().catch(() => null);
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !password) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "username/password required",
      },
      400,
    );
  }
  // 长度上限(同 login,防 DoS + 防 DB 写入超长值)
  if (
    username.length > MAX_USERNAME_LEN ||
    password.length > MAX_PASSWORD_LEN
  ) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "username/password too long",
      },
      400,
    );
  }
  try {
    const admin = await getAdminRepo().create({ username, password });
    return c.json(admin, 201);
  } catch (e) {
    // 记录完整错误到服务端日志,不暴露给前端
    safeError("[admin] create admin failed:", e);
    // 唯一约束冲突(用户名已存在)→ 通用消息,不泄露 SQL
    return c.json({ error: "conflict", error_description: "用户名已存在" }, 409);
  }
});

// 改密码:
//   - 改自己(id === 当前 admin):必须带 oldPassword 校验通过(防盗号洗号)
//   - 改他人:直接设新密码(管理员重置场景,不需旧密码)
adminWeb.post("/admins/:id/password", async (c) => {
  const id = Number(c.req.param("id"));
  const s = c.get("adminSession");
  const body = await c.req.json().catch(() => null);
  const newPassword =
    typeof body?.newPassword === "string" ? body.newPassword : "";
  const oldPassword =
    typeof body?.oldPassword === "string" ? body.oldPassword : "";
  if (!newPassword) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "newPassword required",
      },
      400,
    );
  }
  // 长度上限(同 login,防 DoS + 防 DB 超长值)
  if (
    newPassword.length > MAX_PASSWORD_LEN ||
    oldPassword.length > MAX_PASSWORD_LEN
  ) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "password too long",
      },
      400,
    );
  }
  // 改自己:必须验证旧密码(复用 verifyPassword,含 timing 抹平)
  if (id === s.adminId) {
    if (!oldPassword) {
      return c.json(
        {
          error: "invalid_request",
          error_description: "修改自己的密码需要 oldPassword",
        },
        400,
      );
    }
    const verified = await getAdminRepo().verifyPassword(
      s.username,
      oldPassword,
    );
    if (!verified) {
      return c.json(
        { error: "invalid_credentials", error_description: "旧密码不正确" },
        401,
      );
    }
  }
  const ok = await getAdminRepo().setPassword(id, newPassword);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// 改用户名:
//   - 唯一约束冲突 → 409 用户名已存在(不泄露 SQL 细节)
//   - 改自己后重发 cookie:cookie payload 含 username,否则 /me 显示旧名
adminWeb.post("/admins/:id/rename", async (c) => {
  const id = Number(c.req.param("id"));
  const s = c.get("adminSession");
  const body = await c.req.json().catch(() => null);
  const username =
    typeof body?.username === "string" ? body.username.trim() : "";
  if (!username) {
    return c.json(
      { error: "invalid_request", error_description: "username required" },
      400,
    );
  }
  if (username.length > MAX_USERNAME_LEN) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "username too long",
      },
      400,
    );
  }
  try {
    const ok = await getAdminRepo().setUsername(id, username);
    if (!ok) return c.json({ error: "not_found" }, 404);
    // 改自己:重发 cookie 刷新 payload 里的 username
    if (id === s.adminId) {
      const value = issueSessionCookieValue(s.adminId, username);
      setCookie(c, COOKIE_NAME, value, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: config.adminSessionTtlSec,
        secure: config.tls.enabled,
      });
    }
    return c.json({ ok: true, username });
  } catch (e) {
    safeError("[admin] rename admin failed:", e);
    return c.json(
      { error: "conflict", error_description: "用户名已存在" },
      409,
    );
  }
});

adminWeb.delete("/admins/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const s = c.get("adminSession");
  // 防自删:不能删自己
  if (s.adminId === id) {
    return c.json(
      { error: "invalid_request", error_description: "不能删除自己" },
      400,
    );
  }
  // 至少保留一个:删完无人能登录后台上
  const total = await getAdminRepo().count();
  if (total <= 1) {
    return c.json(
      { error: "invalid_request", error_description: "至少保留一个管理员" },
      400,
    );
  }
  const ok = await getAdminRepo().delete(id);
  return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

/**
 * 把 audit 接口的 limit 查询参约束到 [1, 200]。
 * 修复:原实现 Math.min(Number(undefined??50), 200) 在 limit 缺省时取 50,
 * 但 Number(undefined) = NaN,Math.min(NaN, 200) = NaN 会传到 DB .limit(NaN)。
 */
function clampLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
