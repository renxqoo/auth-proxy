import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import {
  getAdminRepo,
  getTokenRepo,
  getAppRepo,
  getAuditRepo,
} from "../repos/index.js";
import { revokeSessionsByClient } from "../sessionStore.js";
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
