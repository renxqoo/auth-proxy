import { Hono } from "hono";
import { exportJWK, importSPKI } from "jose";
import { getSigningKeyRepo } from "../repos/index.js";

/**
 * GET /.well-known/jwks.json —— 暴露验签公钥集合(RFC 7517)。
 *
 * 供外部服务/CLI 自行校验中间层签发的 JWT。中间层自身校验用本地 JWKS
 * (jwt.ts 的 getVerifier,带缓存),不依赖此 HTTP 端点。
 *
 * 返回所有"未 retired"的公钥(支持轮转期平滑切换)。
 */
export const jwks = new Hono();

jwks.get("/", async (c) => {
  const verifiers = await getSigningKeyRepo().listVerifiers();
  const keys = await Promise.all(
    verifiers.map(async (v) => {
      const keyLike = await exportJWK(await importSPKI(v.publicPem, "RS256"));
      Object.assign(keyLike, { kid: v.kid, use: "sig", alg: "RS256" });
      return keyLike;
    }),
  );
  return c.json({ keys });
});
