import { eq, ne } from "drizzle-orm";
import { signingKeys } from "@auth-proxy/db";
import { getDb, getRedis } from "../infra.js";

/**
 * 签名密钥仓储 —— RS256 密钥对,从 PG 读取,Redis 缓存。
 * Phase C 改 jwt.ts 时用;本文件 Phase B 先建好。
 *
 * 轮转:新增 active + 旧标 retired;校验时所有"未 retired"的公钥都可用于验签。
 */

export interface SigningKeyData {
  kid: string;
  alg: string;
  publicPem: string;
  privatePem: string;
}

const ACTIVE_CACHE_KEY = "signing:active";
const ACTIVE_CACHE_TTL = 600; // 10min

export class SigningKeyRepo {
  /** 取当前 active 密钥(含私钥,用于签名)。 */
  async getActive(): Promise<SigningKeyData> {
    const cached = await this.cacheGetActive();
    if (cached) return cached;
    const db = getDb();
    const rows = await db
      .select()
      .from(signingKeys)
      .where(eq(signingKeys.status, "active"));
    if (rows.length === 0) {
      throw new Error(
        "no active signing key; run `pnpm --filter @auth-proxy/db seed`",
      );
    }
    const data = this.toData(rows[0]!);
    await this.cacheSetActive(data);
    return data;
  }

  /** 取所有可验签的公钥(jwks 用);不含私钥。 */
  async listVerifiers(): Promise<{ kid: string; publicPem: string }[]> {
    const db = getDb();
    const rows = await db
      .select({
        kid: signingKeys.kid,
        publicPem: signingKeys.publicPem,
      })
      .from(signingKeys)
      .where(ne(signingKeys.status, "retired"));
    return rows;
  }

  private toData(row: typeof signingKeys.$inferSelect): SigningKeyData {
    return {
      kid: row.kid,
      alg: row.alg,
      publicPem: row.publicPem,
      privatePem: row.privatePem,
    };
  }

  private async cacheGetActive(): Promise<SigningKeyData | null> {
    const raw = await getRedis().get(ACTIVE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as SigningKeyData) : null;
  }
  private async cacheSetActive(data: SigningKeyData): Promise<void> {
    await getRedis().set(
      ACTIVE_CACHE_KEY,
      JSON.stringify(data),
      "EX",
      ACTIVE_CACHE_TTL,
    );
  }
}
