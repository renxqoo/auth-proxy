import type { CompanyTokenResponse } from "@auth-proxy/shared";
import { config } from "../config.js";
import { getRedis } from "../infra.js";

/**
 * authorization_code 仓储 —— 纯 Redis(临时状态,短 TTL)。
 *
 * 克隆 deviceCodeRepo 模式。授权码单 key(无 user_code 反查)。
 * 状态机:
 *   pending → authorized(用户登录确认后绑定 company_token)→ consumed(换 token 时)
 *   pending → expired / denied
 *
 * Redis 结构:
 *   key = authcode:{code} → JSON 全量记录(TTL = authCodeTtlSec,默认 120s)
 *
 * PKCE:code_challenge + code_challenge_method(S256)存在记录里,
 * 换 token 时校验 code_verifier。
 */

export type AuthCodeStatus = "pending" | "authorized" | "consumed" | "expired" | "denied";

export interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string; // PKCE:S256(method 固定,OAuth 2.1 强制)
  status: AuthCodeStatus;
  createdAt: number;
  expiresAt: number;
  companyToken?: CompanyTokenResponse; // 用户登录确认后绑定
  deniedReason?: string;
}

const KEY = (code: string) => `authcode:${code}`;
const TTL = config.authCodeTtlSec;

export class AuthCodeRepo {
  async create(rec: AuthCodeRecord): Promise<void> {
    const redis = getRedis();
    await redis.set(KEY(rec.code), JSON.stringify(rec), "EX", TTL);
  }

  async findByCode(code: string): Promise<AuthCodeRecord | null> {
    const raw = await getRedis().get(KEY(code));
    return raw ? (JSON.parse(raw) as AuthCodeRecord) : null;
  }

  async update(rec: AuthCodeRecord): Promise<void> {
    const redis = getRedis();
    await redis.set(KEY(rec.code), JSON.stringify(rec), "EX", TTL);
  }
}
