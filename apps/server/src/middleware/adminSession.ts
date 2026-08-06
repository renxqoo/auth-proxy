import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "../config.js";

/**
 * admin 后台 session cookie 鉴权。
 *
 * cookie 值格式:<base64url(payload)>.<base64url(hmac)>
 * - payload: { adminId, username, exp }
 * - hmac: HMAC-SHA256(payload, ADMIN_SESSION_SECRET)
 *
 * 校验:HMAC 匹配 + 未过期。防篡改、防伪造。
 */

const COOKIE_NAME = "admin_session";

export interface AdminSession {
  adminId: number;
  username: string;
  exp: number; // unix ms
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", config.adminSessionSecret)
    .update(payloadB64)
    .digest("base64url");
}

/** 签发 cookie 值(字符串形式,Set-Cookie 用)。 */
export function issueSessionCookieValue(
  adminId: number,
  username: string,
): string {
  const payload: AdminSession = {
    adminId,
    username,
    exp: Date.now() + config.adminSessionTtlSec * 1000,
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/** 从 cookie 值解析 session;有效返回 AdminSession,无效返回 null。 */
export function parseSessionCookieValue(
  value: string | undefined,
): AdminSession | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  // 校验签名(防篡改)
  const expected = sign(payloadB64);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64)) as AdminSession;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now())
      return null;
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** 鉴权中间件:校验 admin session cookie,有效放行,否则 401。 */
export const requireAdminSession: MiddlewareHandler = async (c, next) => {
  const value = getCookie(c, COOKIE_NAME);
  const session = parseSessionCookieValue(value);
  if (!session) {
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("adminSession", session);
  await next();
};

export { COOKIE_NAME };
