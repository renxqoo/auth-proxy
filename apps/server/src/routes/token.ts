import { Hono, type Context } from "hono";
import type { TokenResponse } from "@auth-proxy/shared";
import { config } from "../config.js";
import {
  consumeDeviceCode,
  findDeviceCodeByDevice,
  refreshExpiry,
  updateDeviceCode,
} from "../deviceCodeStore.js";
import {
  createSession,
  findSessionByRefreshId,
  findRefreshHistory,
  recordRefreshRotation,
  revokeSession,
  rotateSessionRefresh,
  findSessionBySessionId,
} from "../sessionStore.js";
import { oauthError, verifyClient } from "../oauthHelpers.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";
import { getAuditRepo, getScopeRepo } from "../repos/index.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../jwt.js";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * POST /token —— 换 token(RFC 8628 §3.4 + RFC 6749 §6 刷新)。
 * 支持两种 grant:
 *   A. device_code   —— CLI 轮询,用户已登录则签发 JWT
 *   B. refresh_token —— CLI 续期中间层 JWT
 */
export const token = new Hono();

token.post("/", async (c) => {
  const form = await c.req.parseBody();
  const grantType = String(form.grant_type ?? "");

  const clientId = await verifyClient(
    c.req.header("Authorization"),
    form as Record<string, string>,
  );
  if (!clientId) {
    return oauthError(c, "invalid_client", "client authentication failed");
  }

  // 按 client_id 限流(防恶意刷 token)
  const rl = await enforceRateLimit(`token:${clientId}`, {
    windowMs: config.rateLimit.tokenWindowMs,
    limit: config.rateLimit.tokenMax,
    prefix: "rl:token",
  });
  if (!rl.allowed) {
    return c.json(
      { error: "slow_down", error_description: "too many token requests" },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  if (grantType === DEVICE_CODE_GRANT) {
    return handleDeviceCodeGrant(c, form as Record<string, string>);
  }
  if (grantType === "refresh_token") {
    return handleRefreshGrant(c, form as Record<string, string>);
  }
  return oauthError(
    c,
    "unsupported_grant_type",
    `unsupported grant_type: ${grantType}`,
  );
});

/**
 * scope 收窄(层 2:用户权限):把请求的 scope 限制在用户实际拥有的权限内。
 *
 * - 系统 scope(scopes 表 isSystem=true,如 offline_access / company.api)是中间层
 *   自身管理的,不属于公司应用返回的用户权限(user.scopes),不参与权限比对(自动放行)。
 *   系统 scope 从 DB 读(带缓存);表为空时回退 config.systemScopes(向后兼容)。
 * - 请求的其它 scope 必须全部 ∈ userScopes;否则返回 null(调用方返 invalid_scope)。
 * - 返回值:收窄后的 scope 字符串(保留请求顺序,含系统 scope)。
 *
 * 设计:授权边界在签发时生效 —— 即便请求了超出权限的 scope,token 里也
 * 只会包含用户实际拥有的。但为了符合 OAuth 的"最小惊讶"并避免静默降级,
 * 对越权请求直接拒绝(invalid_scope),而非悄悄裁剪。
 */
async function narrowScope(
  requested: string,
  userScopes: string[],
): Promise<string | null> {
  const requestedScopes = requested.split(/\s+/).filter((s) => s.length > 0);
  const userScopeSet = new Set(userScopes);
  // 系统 scope 从 DB 读(isSystem=true);表为空时回退环境变量
  const { systemNames } = await getScopeRepo().getSets();
  const systemScopeSet =
    systemNames.size > 0
      ? systemNames
      : new Set(config.systemScopes.split(/\s+/).filter(Boolean));
  for (const s of requestedScopes) {
    if (systemScopeSet.has(s)) continue; // 系统 scope,放行
    if (!userScopeSet.has(s)) return null; // 越权 → 拒绝
  }
  // 保留请求顺序(去重)
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of requestedScopes) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.join(" ");
}

// ---------- A. device_code grant ----------
async function handleDeviceCodeGrant(
  c: Context,
  form: Record<string, string>,
): Promise<Response> {
  const deviceCode = form.device_code;
  if (!deviceCode) {
    return oauthError(c, "invalid_request", "missing device_code");
  }

  const rec = await findDeviceCodeByDevice(deviceCode);
  if (!rec) {
    return oauthError(c, "expired_token", "unknown or expired device_code");
  }
  refreshExpiry(rec); // 惰性过期

  switch (rec.status) {
    case "pending": {
      // 节流:间隔太短返回 slow_down。
      // 关键:slow_down 也更新 lastPollAt 并持久化,防止攻击者
      // 持续高频请求绕过节流(slow_down 不推进时间戳的旧实现可被绕过)。
      const now = Date.now();
      const minIntervalMs = config.devicePollIntervalSec * 1000;
      if (rec.lastPollAt && now - rec.lastPollAt < minIntervalMs) {
        rec.lastPollAt = now;
        await updateDeviceCode(rec);
        return oauthError(c, "slow_down", "polling too fast");
      }
      rec.lastPollAt = now;
      await updateDeviceCode(rec);
      return oauthError(
        c,
        "authorization_pending",
        "user has not yet completed login",
      );
    }
    case "authorized": {
      // 用户登录成功 → 创建 session + 签发 token + consume device_code
      if (!rec.companyToken) {
        return oauthError(c, "expired_token", "device_code missing token");
      }
      // scope 收窄:请求的 scope 必须是用户实际拥有的(user.scopes,
      // 登录时公司应用返回并快照进 companyToken.user)。请求了用户没有的
      // scope → invalid_scope(防止用户拿到超出自身权限的 token)。
      // offline_access 是中间层自身所需的续期 scope,不计入用户权限比对。
      const grantedScope = await narrowScope(rec.scope, rec.companyToken.user.scopes);
      if (grantedScope === null) {
        return oauthError(
          c,
          "invalid_scope",
          "requested scope exceeds user's granted permissions",
        );
      }
      const session = await createSession(
        rec.companyToken,
        grantedScope,
        rec.clientId,
      );
      await consumeDeviceCode(deviceCode);
      return c.json(
        await issueTokenResponse(
          session.sessionId,
          session.refreshId,
          grantedScope,
        ),
      );
    }
    case "denied":
      return oauthError(
        c,
        "access_denied",
        rec.deniedReason ?? "user denied login",
      );
    case "expired":
      return oauthError(c, "expired_token", "device_code expired");
    case "consumed":
      return oauthError(c, "expired_token", "device_code already used");
    default:
      return oauthError(c, "expired_token", "invalid device_code state");
  }
}

// ---------- B. refresh_token grant ----------
async function handleRefreshGrant(
  c: Context,
  form: Record<string, string>,
): Promise<Response> {
  const refreshToken = form.refresh_token;
  if (!refreshToken) {
    return oauthError(c, "invalid_request", "missing refresh_token");
  }

  const claims = await verifyRefreshToken(refreshToken);
  if (!claims) {
    return oauthError(c, "invalid_grant", "refresh_token invalid or expired");
  }

  // 路径 1:refresh_id 仍对应当前活跃 session → 正常轮换
  const session = await findSessionByRefreshId(claims.jti);
  if (session) {
    // 旧 jti 入 history(重用检测依据),再轮换为新 jti
    await recordRefreshRotation(session.sessionId, claims.jti);
    const updated = await rotateSessionRefresh(claims.jti);
    if (!updated) {
      // 并发竞态:刚还查到,轮换时已被另一个请求转走 → 按宽限处理
      return handleGraceOrReuse(c, claims);
    }
    return c.json(
      await issueTokenResponse(
        updated.sessionId,
        updated.refreshId,
        updated.scope,
      ),
    );
  }

  // 路径 2:refresh_id 查不到(已被轮换或从未存在)→ 查 history 判断
  return handleGraceOrReuse(c, claims);
}

/**
 * 旧 refresh 的处理:查 history 判断是"宽限窗口内的合法重试"还是"重用泄露"。
 * - history 有记录 且 在宽限窗口内(≤ refreshReuseGraceSec)→ 宽限:发新 token
 * - history 有记录 但 超过窗口 → 重用!吊销 session + 记安全事件
 * - history 无记录 → 纯无效 token(瞎编的),返回 invalid_grant 不吊销
 */
async function handleGraceOrReuse(
  c: Context,
  claims: { jti: string; sub: string },
): Promise<Response> {
  const history = await findRefreshHistory(claims.jti);
  if (!history) {
    // 从未存在过 → 纯无效,不吊销
    return oauthError(c, "invalid_grant", "refresh_token no longer valid");
  }

  const ageMs = Date.now() - history.rotatedAt.getTime();
  const graceMs = config.refreshReuseGraceSec * 1000;

  if (ageMs <= graceMs) {
    // 宽限窗口内:容忍并发/重试,返回当前活跃 token
    const session = await findSessionBySessionId(history.sessionId);
    if (!session) {
      // session 已被吊销/不存在 → 不能宽限
      return oauthError(c, "invalid_grant", "session no longer active");
    }
    return c.json(
      await issueTokenResponse(
        session.sessionId,
        session.refreshId,
        session.scope,
      ),
    );
  }

  // 超过窗口 → 重用!吊销 session + 记安全事件
  await revokeSession(history.sessionId);
  void getAuditRepo().writeLoginLog({
    userCode: "",
    username: "[REUSE]",
    clientId: claims.sub,
    success: false,
  });
  return oauthError(
    c,
    "invalid_grant",
    "refresh token reuse detected; session revoked",
  );
}

// 组装标准 token 响应
async function issueTokenResponse(
  sessionId: string,
  refreshId: string,
  scope: string,
): Promise<TokenResponse> {
  const [accessToken, newRefreshToken] = await Promise.all([
    signAccessToken(sessionId, scope),
    signRefreshToken(sessionId, refreshId),
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.jwtAccessTtlSec,
    refresh_token: newRefreshToken,
    scope,
  };
}
