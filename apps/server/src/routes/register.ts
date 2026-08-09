import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getAppRepo, getTokenRepo } from "../repos/index.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";

/**
 * POST /register —— RFC 7591 动态客户端注册。
 *
 * 准入:保留 registrationToken(管理员预生成,防任意注册)。
 * 请求体(RFC 7591 §2 client_metadata + 准入令牌):
 *   { registrationToken, client_name, redirect_uris, grant_types,
 *     response_types, scope, token_endpoint_auth_method }
 * 响应(RFC 7591 §3.2,snake_case):
 *   { client_id, client_secret, client_id_issued_at, client_secret_expires_at(=0),
 *     client_name, redirect_uris, grant_types, response_types, scope,
 *     token_endpoint_auth_method }
 * 错误用 invalid_client_metadata(RFC 7591 §3.2.1)。
 */
export const register = new Hono();

function isUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

register.post("/", async (c) => {
  // 按 IP 限流(防令牌泄露后被刷)
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("remote-address") ??
    "unknown";
  const rl = await enforceRateLimit(`register:${ip}`, {
    windowMs: 60_000,
    limit: 10,
    prefix: "rl:register",
  });
  if (!rl.allowed) {
    return c.json(
      { error: "too_many_requests", error_description: "rate limit exceeded" },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  const body = await c.req.json().catch(() => null);

  // 准入:registrationToken 必须有效(原子校验+消费)
  const registrationToken =
    typeof body?.registrationToken === "string"
      ? body.registrationToken.trim()
      : "";
  if (!registrationToken) {
    return c.json(
      { error: "invalid_client_metadata", error_description: "registrationToken required" },
      401,
    );
  }
  const tokenId = await getTokenRepo().consumeSingleUse(registrationToken);
  if (tokenId === null) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: "registration token invalid, expired, revoked, or already used",
      },
      401,
    );
  }

  // ---- RFC 7591 client_metadata 校验 ----
  const clientName =
    typeof body?.client_name === "string" ? body.client_name.trim() : "";
  if (!clientName || clientName.length > 256) {
    return c.json(
      { error: "invalid_client_metadata", error_description: "client_name required (<=256 chars)" },
      400,
    );
  }

  // redirect_uris:可选但若提供必须是 https/http URL 数组(authorization_code 流程需要)
  const redirectUris = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.filter((u: unknown): u is string => typeof u === "string")
    : [];
  if (body?.redirect_uris !== undefined) {
    if (!Array.isArray(body.redirect_uris)) {
      return c.json(
        { error: "invalid_client_metadata", error_description: "redirect_uris must be an array" },
        400,
      );
    }
    for (const u of redirectUris) {
      if (!isUrl(u)) {
        return c.json(
          { error: "invalid_client_metadata", error_description: `invalid redirect_uri: ${u}` },
          400,
        );
      }
    }
  }

  // grant_types:可选,默认 [device_code, refresh_token]
  const grantTypes = Array.isArray(body?.grant_types)
    ? body.grant_types.filter((g: unknown): g is string => typeof g === "string")
    : ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"];

  // response_types:可选,默认 ["code"](device flow 无 response_type,但保留)
  const responseTypes = Array.isArray(body?.response_types)
    ? body.response_types.filter((r: unknown): r is string => typeof r === "string")
    : ["code"];

  // scope:可选,client 声明的允许 scope
  const scope = typeof body?.scope === "string" ? body.scope.trim() : "";

  // token_endpoint_auth_method:默认 client_secret_basic
  const authMethod =
    typeof body?.token_endpoint_auth_method === "string"
      ? body.token_endpoint_auth_method
      : "client_secret_basic";

  // ---- 生成 client 凭据 ----
  const clientId = "cli_" + randomBytes(12).toString("hex");
  const clientSecret = randomBytes(24).toString("hex");
  await getAppRepo().create({
    clientId,
    clientSecret,
    name: clientName,
    createdFromTokenId: tokenId,
    redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
  });

  // ---- RFC 7591 §3.2 响应(snake_case + 回显 metadata)----
  return c.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0, // 0 = 永不过期(RFC 7591)
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      ...(scope ? { scope } : {}),
      token_endpoint_auth_method: authMethod,
    },
    201,
  );
});
