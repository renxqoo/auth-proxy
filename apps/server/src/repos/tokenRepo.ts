import { randomBytes } from "node:crypto";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { registrationTokens } from "@auth-proxy/db";
import { getDb } from "../infra.js";

/**
 * 注册令牌仓储 —— 管理动态客户端注册用的令牌。
 *
 * 令牌由管理员生成,限时多次(有效期 N 天,不限次数)。
 * 团队成员用它调 /register 换取独立 clientId/secret。
 */

const TOKEN_PREFIX = "rt_";

export interface TokenRecord {
  id: number;
  token: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  revoked: boolean;
  singleUse: boolean;
  used: boolean;
  useCount: number;
  lastUsedAt: Date | null;
}

/** 生成新令牌(rt_ + 32 hex)。 */
function newToken(): string {
  return TOKEN_PREFIX + randomBytes(16).toString("hex");
}

export class TokenRepo {
  /** 创建令牌。expiresDays 天后过期。返回完整记录(含明文 token,仅此一次)。 */
  async create(params: {
    name: string;
    expiresDays: number;
    singleUse: boolean;
  }): Promise<TokenRecord> {
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + params.expiresDays * 24 * 60 * 60 * 1000,
    );
    const token = newToken();
    const [row] = await db
      .insert(registrationTokens)
      .values({
        token,
        name: params.name,
        expiresAt,
        revoked: false,
        singleUse: params.singleUse,
        used: false,
      })
      .returning();
    return this.toRecord(row!);
  }

  /** 列出所有令牌。 */
  async list(): Promise<TokenRecord[]> {
    const db = getDb();
    const rows = await db.select().from(registrationTokens);
    return rows.map((r) => this.toRecord(r));
  }

  /** 吊销令牌。 */
  async revoke(id: number): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(registrationTokens)
      .set({ revoked: true })
      .where(eq(registrationTokens.id, id))
      .returning();
    return rows.length > 0;
  }

  /**
   * 校验令牌有效性(注册端点用),有效则返回令牌 id(供记录 createdFromTokenId)。
   * 有效 = 存在 + 未吊销 + 未过期 + (一次性令牌未被使用)。
   */
  async verify(token: string): Promise<number | null> {
    const db = getDb();
    const rows = await db
      .select({
        id: registrationTokens.id,
        revoked: registrationTokens.revoked,
        expiresAt: registrationTokens.expiresAt,
        singleUse: registrationTokens.singleUse,
        used: registrationTokens.used,
      })
      .from(registrationTokens)
      .where(eq(registrationTokens.token, token));
    if (rows.length === 0) return null;
    const r = rows[0]!;
    if (r.revoked) return null;
    if (new Date(r.expiresAt).getTime() <= Date.now()) return null;
    // 一次性令牌:已用过 → 拒绝
    if (r.singleUse && r.used) return null;
    return r.id;
  }

  /** 记录令牌被使用一次(use_count+1, last_used_at=now)。一次性令牌同时标 used=true。 */
  async recordUse(id: number): Promise<void> {
    const db = getDb();
    await db
      .update(registrationTokens)
      .set({
        useCount: sql`${registrationTokens.useCount} + 1`,
        lastUsedAt: new Date(),
        // 一次性令牌用过后标记 used(下次 verify 拒绝)
        used: sql`CASE WHEN ${registrationTokens.singleUse} THEN true ELSE ${registrationTokens.used} END`,
      })
      .where(eq(registrationTokens.id, id));
  }

  /**
   * 原子校验并消费注册令牌(防 TOCTOU 竞态)。
   *
   * 安全动机:原 verify() + recordUse() 两步非原子。并发 /register 请求
   * 都能在步骤 1 看到 used=false,各自拿到 tokenId,步骤 2 才标记 used=true
   * → 单次令牌被多次消费,绕过准入控制。
   *
   * 修复:用单条带条件的 UPDATE...RETURNING 把"校验有效 + 标记已用 + 计数"
   * 合并成一次原子操作。只有抢到这行的请求 RETURNING 非空,其余返回 null。
   *
   * 条件(同时满足才消费):
   *   token 匹配 + 未吊销 + 未过期 + (非一次性 OR 未用过)
   * 返回:消费成功的 tokenId;否则 null。
   */
  async consumeSingleUse(token: string): Promise<number | null> {
    const db = getDb();
    const rows = await db
      .update(registrationTokens)
      .set({
        useCount: sql`${registrationTokens.useCount} + 1`,
        lastUsedAt: new Date(),
        // 一次性令牌原子标记 used(本次 UPDATE 内完成,无竞态窗口)
        used: sql`CASE WHEN ${registrationTokens.singleUse} THEN true ELSE ${registrationTokens.used} END`,
      })
      .where(
        and(
          eq(registrationTokens.token, token),
          eq(registrationTokens.revoked, false),
          gt(registrationTokens.expiresAt, new Date()),
          // 一次性令牌:必须还没用过;多次令牌:无此约束
          or(
            eq(registrationTokens.singleUse, false),
            eq(registrationTokens.used, false),
          ),
        ),
      )
      .returning({ id: registrationTokens.id });
    return rows.length > 0 ? rows[0]!.id : null;
  }

  private toRecord(row: typeof registrationTokens.$inferSelect): TokenRecord {
    return {
      id: row.id,
      token: row.token,
      name: row.name,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      revoked: row.revoked,
      singleUse: row.singleUse,
      used: row.used,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt,
    };
  }
}
