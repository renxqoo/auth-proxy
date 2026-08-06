import { Hono } from "hono";
import { findSessionBySessionId } from "../sessionStore.js";
import { bearerOf, verifyAccessToken } from "../jwt.js";
import { oauthError } from "../oauthHelpers.js";

/**
 * GET /user_info —— 返回当前登录用户(对齐 lark-cli getUserInfo 的 open_id/name 字段)。
 * CLI 登录后调用此端点确认身份。
 */
export const userInfo = new Hono();

userInfo.get("/", async (c) => {
  const claims = await verifyAccessToken(
    bearerOf(c.req.header("Authorization")),
  );
  if (!claims) {
    return oauthError(c, "invalid_grant", "missing or invalid access token");
  }
  const session = await findSessionBySessionId(claims.sub);
  if (!session) {
    return oauthError(c, "invalid_grant", "session not found; please re-login");
  }
  // 字段名 open_id 对齐 lark-cli 约定;值是公司用户 id
  return c.json({ open_id: session.user.id, name: session.user.name }, 200);
});
