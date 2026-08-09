import { Hono, type Context } from "hono";
import type { DeviceAuthResponse } from "@auth-proxy/shared";
import { config } from "../config.js";
import { createDeviceCode } from "../deviceCodeStore.js";
import { oauthError, verifyClient } from "../oauthHelpers.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";

/**
 * POST /device_authorization —— 申请设备码(RFC 8628 §3.1)。
 * CLI 调用此端点发起设备授权流程。
 */
export const deviceAuthorization = new Hono();

deviceAuthorization.post("/", async (c) => {
  const form = await c.req.parseBody();
  const clientId = await verifyClient(
    c.req.header("Authorization"),
    form as Record<string, string>,
  );
  if (!clientId) {
    return oauthError(c, "invalid_client", "client authentication failed");
  }

  // 按 client_id 限流:防 client_secret 泄露后无限刷 device_code
  // (每个 device_code 在 Redis 占一个带 TTL 的 key,无限刷会耗尽 Redis 内存)
  const rl = await enforceRateLimit(`device-auth:${clientId}`, {
    windowMs: config.rateLimit.deviceAuthWindowMs,
    limit: config.rateLimit.deviceAuthMax,
    prefix: "rl:device-auth",
  });
  if (!rl.allowed) {
    return c.json(
      { error: "too_many_requests", error_description: "rate limit exceeded" },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  // scope 处理:接受 CLI 传的 scope;offline_access 一定带上(中间层必发 refresh_token)
  const requestedScope = typeof form.scope === "string" ? form.scope : "";
  const scopes = requestedScope.split(/\s+/).filter((s) => s.length > 0);
  // 入口白名单校验(RFC 6749 §3.3):请求的 scope 超出允许集合 → invalid_scope。
  // offline_access 由入口自动补上,无需客户端显式请求,故不在此校验它。
  const allowed = new Set(config.allowedScopes.split(/\s+/).filter(Boolean));
  for (const s of scopes) {
    if (!allowed.has(s)) {
      return oauthError(
        c,
        "invalid_scope",
        `unknown or disallowed scope: ${s}`,
      );
    }
  }
  if (!scopes.includes("offline_access")) scopes.push("offline_access");
  const scope = scopes.join(" ");

  const rec = await createDeviceCode(clientId, scope);
  const verificationUri = `${publicBase(c)}/verify`;

  const res: DeviceAuthResponse = {
    device_code: rec.deviceCode,
    user_code: rec.userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(rec.userCode)}`,
    expires_in: config.deviceCodeTtlSec,
    interval: config.devicePollIntervalSec,
  };
  return c.json(res, 200);
});

/**
 * 推断对外可达的 base(协议 + host),供拼 verification_uri。
 *
 * 安全:优先用配置的 PUBLIC_BASE_URL(可信,生产必设)。只有未配置时
 * 才回退到 Host 头(本地开发)。绝不信任 x-forwarded-host / x-forwarded-proto ——
 * 这些是客户端可伪造的,信任它们会导致 host header injection → 钓鱼
 * (攻击者发 x-forwarded-host: evil.com,CLI 收到的登录链接指向 evil.com)。
 */
function publicBase(c: Context): string {
  if (config.publicBaseUrl) {
    // 去掉末尾斜杠,避免拼接出双斜杠
    return config.publicBaseUrl.replace(/\/+$/, "");
  }
  // 仅本地开发回退:用 Host 头(不信任 x-forwarded-*)
  const host = c.req.header("host") ?? `localhost:${config.port}`;
  return `http://${host}`;
}
