import { randomBytes } from "node:crypto";
import type { CompanyTokenResponse } from "@auth-proxy/shared";
import { config } from "./config.js";
import { getAuthCodeRepo, type AuthCodeRecord } from "./repos/index.js";

/**
 * authorization_code 状态机 —— RFC 6749 §4.1 + PKCE(RFC 7636)。
 *
 *   pending → authorized(用户登录确认)→ consumed(换 token)
 *   pending → expired / denied
 *
 * PKCE:code_challenge_method 固定 S256(OAuth 2.1 强制)。
 */

const PREFIX = "ac_";

export type { AuthCodeRecord };

/** 创建授权码;返回新记录(已落 Redis)。 */
export async function createAuthCode(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string; // S256 challenge(base64url)
}): Promise<AuthCodeRecord> {
  const now = Date.now();
  const rec: AuthCodeRecord = {
    code: PREFIX + randomBytes(18).toString("hex"),
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scope: params.scope,
    codeChallenge: params.codeChallenge,
    status: "pending",
    createdAt: now,
    expiresAt: now + config.authCodeTtlSec * 1000,
  };
  await getAuthCodeRepo().create(rec);
  return rec;
}

export async function findAuthCode(code: string): Promise<AuthCodeRecord | null> {
  const rec = await getAuthCodeRepo().findByCode(code);
  if (rec) refreshExpiry(rec);
  return rec;
}

/** 用户登录确认成功:绑定 company_token,标记 authorized。 */
export async function authorizeAuthCode(
  code: string,
  token: CompanyTokenResponse,
): Promise<AuthCodeRecord | null> {
  const rec = await getAuthCodeRepo().findByCode(code);
  if (!rec || rec.status !== "pending") return null;
  rec.companyToken = token;
  rec.status = "authorized";
  await getAuthCodeRepo().update(rec);
  return rec;
}

/** 换 token 成功:标记 consumed。 */
export async function consumeAuthCode(
  code: string,
): Promise<AuthCodeRecord | null> {
  const rec = await getAuthCodeRepo().findByCode(code);
  if (!rec || rec.status !== "authorized") return null;
  rec.status = "consumed";
  await getAuthCodeRepo().update(rec);
  return rec;
}

/** 惰性过期。 */
export function refreshExpiry(rec: AuthCodeRecord): void {
  if (rec.status === "expired" || rec.status === "consumed") return;
  if (Date.now() >= rec.expiresAt) rec.status = "expired";
}
