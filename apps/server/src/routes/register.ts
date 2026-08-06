import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getAppRepo, getTokenRepo } from "../repos/index.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";

/**
 * POST /register —— 动态客户端注册。
 *
 * CLI 用注册令牌换取独立的 clientId/clientSecret(每台机器一份)。
 * - body: { registrationToken: string, name?: string }
 * - 校验令牌有效(存在 + 未吊销 + 未过期)
 * - 生成 cli_xxx / secret_xxx,appRepo.create(hash 存 secret)
 * - 返回明文 clientId/clientSecret(仅此一次;中间层只存 hash)
 */
export const register = new Hono();

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
  const registrationToken =
    typeof body?.registrationToken === "string"
      ? body.registrationToken.trim()
      : "";
  if (!registrationToken) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "registrationToken required",
      },
      400,
    );
  }

  // 原子校验并消费令牌(防 TOCTOU 竞态):
  // 用单条 UPDATE...RETURNING 把"校验有效 + 标记已用 + 计数"合并,
  // 并发请求里只有一个 RETURNING 非空。返回 tokenId(审计用)。
  const tokenId = await getTokenRepo().consumeSingleUse(registrationToken);
  if (tokenId === null) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "registration token invalid, expired, revoked, or already used",
      },
      401,
    );
  }

  // 生成独立 client 凭据(每台机器一份)
  const clientId = "cli_" + randomBytes(12).toString("hex");
  const clientSecret = randomBytes(24).toString("hex");
  const name =
    typeof body?.name === "string" && body.name.trim()
      ? body.name.trim()
      : "dynamic-client";
  await getAppRepo().create({
    clientId,
    clientSecret,
    name,
    createdFromTokenId: tokenId,
  });

  // 明文 secret 仅此一次返回
  return c.json({ clientId, clientSecret }, 201);
});
