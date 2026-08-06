import { Hono } from "hono";
import { revokeSession } from "../sessionStore.js";
import { verifyAccessToken, verifyRefreshToken } from "../jwt.js";

/**
 * POST /revoke —— 吊销 token(RFC 7007)。
 *
 * 接受 access 或 refresh token:
 * - access → 解出 sessionId → revokeSession
 * - refresh → 解出 sessionId → revokeSession
 *
 * 响应固定 200(不泄露 token 是否存在,符合 RFC)。
 */
export const revoke = new Hono();

revoke.post("/", async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? "");
  const hint = String(form.token_type_hint ?? "");

  if (!token) {
    return c.body(null, 200);
  }

  // 优先按 hint 尝试,再回退另一种
  const tryOrder =
    hint === "refresh_token" ? ["refresh", "access"] : ["access", "refresh"];

  let revoked = false;
  for (const kind of tryOrder) {
    if (revoked) break;
    if (kind === "access") {
      const claims = await verifyAccessToken(token);
      if (claims) {
        await revokeSession(claims.sub);
        revoked = true;
      }
    } else {
      const claims = await verifyRefreshToken(token);
      if (claims) {
        await revokeSession(claims.sub);
        revoked = true;
      }
    }
  }

  // 无论是否找到都返回 200
  return c.body(null, 200);
});
