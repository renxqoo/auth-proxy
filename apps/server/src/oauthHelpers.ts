import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OAuthError, OAuthErrorCode } from "@auth-proxy/shared";
import { getAppRepo } from "./repos/index.js";

/**
 * OAuth 协议辅助:client 校验、标准错误响应。
 * 所有 OAuth error 都用这套,保证 CLI 端解析一致。
 */

// RFC 6749:invalid_client 用 401,其余错误用 400
const STATUS_BY_CODE: Record<OAuthErrorCode, ContentfulStatusCode> = {
  authorization_pending: 400,
  slow_down: 400,
  expired_token: 400,
  access_denied: 400,
  invalid_grant: 400,
  invalid_client: 401,
  invalid_request: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
};

export function oauthError(
  c: Context,
  code: OAuthErrorCode,
  description?: string,
  headers?: Record<string, string>,
) {
  const body: OAuthError = { error: code };
  if (description) body.error_description = description;
  return c.json(body, STATUS_BY_CODE[code], headers);
}

/**
 * 校验 client —— 支持 RFC 6749 两种传递方式:
 * 1. Authorization: Basic base64(client_id:client_secret)
 * 2. body 里 client_id + client_secret
 *
 * 凭据从 apps 表查(见 AppRepo);不再写死在 config。
 * 返回校验通过的 clientId,或 null。
 */
export async function verifyClient(
  authHeader: string | undefined,
  body: { client_id?: string; client_secret?: string },
): Promise<string | null> {
  let cid: string | undefined;
  let csec: string | undefined;

  // 1. Basic auth
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString(
        "utf8",
      );
      const idx = decoded.indexOf(":");
      cid = idx >= 0 ? decoded.slice(0, idx) : decoded;
      csec = idx >= 0 ? decoded.slice(idx + 1) : "";
    } catch {
      return null;
    }
  } else if (body.client_id && body.client_secret) {
    // 2. body
    cid = body.client_id;
    csec = body.client_secret;
  } else {
    return null;
  }

  if (!cid || !csec) return null;
  return getAppRepo().verifyClient(cid, csec);
}
