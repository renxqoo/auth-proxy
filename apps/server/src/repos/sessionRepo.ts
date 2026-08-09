import { and, eq, desc } from "drizzle-orm";
import { sessions, users, refreshTokenHistory } from "@auth-proxy/db";
import { getDb, getRedis } from "../infra.js";

/**
 * session 仓储 —— Postgres 权威 + Redis 缓存。
 *
 * - 读路径:先查 Redis,miss 回源 PG 并回填缓存
 * - 写路径:先写 PG,再更新/失效 Redis 缓存
 *
 * company_token 只存这里(PG),永不离开中间层。
 */

export interface SessionData {
  sessionId: string;
  userId: number;
  clientId: string; // 登录时用的 OAuth client(client 吊销时级联)
  refreshId: string;
  user: { id: string; name: string; scopes: string[] }; // 来自 users 表的快照
  companyAccessToken: string;
  companyRefreshToken: string;
  companyTokenExpiresAt: number; // unix ms
  scope: string;
  revoked: boolean;
  sessionType: string; // "user" | "machine" | "agent"
}

/** company token 的最小契约(repo 不依赖 shared 的完整类型)。 */
export interface CompanyTokenFields {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const CACHE_KEY = (sid: string) => `session:${sid}`;
const CACHE_TTL = 300; // 5min

export class SessionRepo {
  /** upsert 用户(来自公司应用登录响应),返回 user.id。 */
  async upsertUser(companyUser: {
    id: string;
    name: string;
    scopes: string[];
  }): Promise<number> {
    const db = getDb();
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.companyUserId, companyUser.id));
    if (existing.length > 0) {
      await db
        .update(users)
        .set({ name: companyUser.name, scopes: companyUser.scopes })
        .where(eq(users.id, existing[0].id));
      return existing[0].id;
    }
    const [created] = await db
      .insert(users)
      .values({
        companyUserId: companyUser.id,
        name: companyUser.name,
        scopes: companyUser.scopes,
      })
      .returning({ id: users.id });
    return created!.id;
  }

  /** 创建 session(PG + 缓存)。 */
  async create(params: {
    sessionId: string;
    refreshId: string;
    userId: number;
    clientId: string;
    companyUser: { id: string; name: string; scopes: string[] };
    companyToken: CompanyTokenFields;
    companyTokenExpiresAt: number;
    scope: string;
    sessionType?: string; // 默认 "user"
  }): Promise<SessionData> {
    const db = getDb();
    const [row] = await db
      .insert(sessions)
      .values({
        sessionId: params.sessionId,
        userId: params.userId,
        clientId: params.clientId,
        refreshId: params.refreshId,
        companyAccessToken: params.companyToken.access_token,
        companyRefreshToken: params.companyToken.refresh_token,
        companyTokenExpiresAt: new Date(params.companyTokenExpiresAt),
        scope: params.scope,
        sessionType: params.sessionType ?? "user",
      })
      .returning();
    const data = await this.hydrate(row!, params.companyUser);
    await this.cacheSet(data);
    return data;
  }

  /**
   * 创建机器 session(client_credentials / agent 用)。
   * 不需要真实的 company token(company 字段存占位空值)。
   */
  async createMachine(params: {
    sessionId: string;
    refreshId: string;
    userId: number;
    clientId: string;
    companyUser: { id: string; name: string; scopes: string[] };
    scope: string;
    sessionType: string;
  }): Promise<SessionData> {
    const db = getDb();
    const [row] = await db
      .insert(sessions)
      .values({
        sessionId: params.sessionId,
        userId: params.userId,
        clientId: params.clientId,
        refreshId: params.refreshId,
        companyAccessToken: "__none__",
        companyRefreshToken: "__none__",
        companyTokenExpiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        scope: params.scope,
        sessionType: params.sessionType,
      })
      .returning();
    const data = await this.hydrate(row!, params.companyUser);
    await this.cacheSet(data);
    return data;
  }

  /** 按 sessionId 查(缓存 miss 回源)。revoked 返回 null。 */
  async findBySession(sessionId: string): Promise<SessionData | null> {
    const cached = await this.cacheGet(sessionId);
    if (cached) return cached.revoked ? null : cached;
    const db = getDb();
    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId));
    if (rows.length === 0) return null;
    const data = await this.hydrate(rows[0]!);
    await this.cacheSet(data);
    return data.revoked ? null : data;
  }

  /** 按 refreshId 查(refresh grant 用)。 */
  async findByRefresh(refreshId: string): Promise<SessionData | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.refreshId, refreshId), eq(sessions.revoked, false)),
      );
    if (rows.length === 0) return null;
    const data = await this.hydrate(rows[0]!);
    await this.cacheSet(data);
    return data;
  }

  /** 刷新公司 token 后更新(PG + 缓存失效)。 */
  async updateCompanyToken(
    sessionId: string,
    token: CompanyTokenFields,
  ): Promise<void> {
    const db = getDb();
    const expiresAt = Date.now() + token.expires_in * 1000;
    await db
      .update(sessions)
      .set({
        companyAccessToken: token.access_token,
        companyRefreshToken: token.refresh_token,
        companyTokenExpiresAt: new Date(expiresAt),
      })
      .where(eq(sessions.sessionId, sessionId));
    await this.cacheInvalidate(sessionId);
  }

  /** refresh 轮换:更新 refreshId。 */
  async rotateRefresh(
    oldRefreshId: string,
    newRefreshId: string,
  ): Promise<SessionData | null> {
    const db = getDb();
    const rows = await db
      .update(sessions)
      .set({ refreshId: newRefreshId })
      .where(
        and(eq(sessions.refreshId, oldRefreshId), eq(sessions.revoked, false)),
      )
      .returning();
    if (rows.length === 0) return null;
    const data = await this.hydrate(rows[0]!);
    await this.cacheSet(data);
    return data;
  }

  /** 吊销(/revoke 用)。 */
  async revoke(sessionId: string): Promise<void> {
    const db = getDb();
    await db
      .update(sessions)
      .set({ revoked: true })
      .where(eq(sessions.sessionId, sessionId));
    await this.cacheInvalidate(sessionId);
  }

  /**
   * 级联吊销某 client 的所有未吊销 session(client 吊销/删除时调)。
   * 返回被吊销的 sessionId 列表(用于清 Redis 缓存)。
   */
  async revokeByClient(clientId: string): Promise<string[]> {
    const db = getDb();
    const rows = await db
      .update(sessions)
      .set({ revoked: true })
      .where(and(eq(sessions.clientId, clientId), eq(sessions.revoked, false)))
      .returning({ sessionId: sessions.sessionId });
    // 清这些 session 的 Redis 缓存(并行,无依赖)
    await Promise.all(rows.map((r) => this.cacheInvalidate(r.sessionId)));
    return rows.map((r) => r.sessionId);
  }

  /**
   * 记录 refresh 轮换:旧 jti 写入 history 表。
   * 调用时机:正常轮换成功后(在 rotateRefresh 之后或之前都行,二者独立)。
   */
  async recordRefreshRotation(
    sessionId: string,
    oldJti: string,
  ): Promise<void> {
    const db = getDb();
    // INSERT ... ON CONFLICT DO NOTHING:jti 唯一,重复写入(并发)忽略
    await db
      .insert(refreshTokenHistory)
      .values({ sessionId, refreshJti: oldJti })
      .onConflictDoNothing();
  }

  /**
   * 查 refresh 历史(重用检测用)。
   * 返回该 jti 的轮换记录(sessionId + rotatedAt),没找到返回 null。
   */
  async findRefreshHistory(
    jti: string,
  ): Promise<{ sessionId: string; rotatedAt: Date } | null> {
    const db = getDb();
    const rows = await db
      .select({
        sessionId: refreshTokenHistory.sessionId,
        rotatedAt: refreshTokenHistory.rotatedAt,
      })
      .from(refreshTokenHistory)
      .where(eq(refreshTokenHistory.refreshJti, jti))
      .orderBy(desc(refreshTokenHistory.rotatedAt))
      .limit(1);
    return rows.length > 0 ? rows[0]! : null;
  }

  // ---------- helpers ----------
  /** hydrate:把 PG 行 + 可选 user 快照组装成 SessionData。 */
  private async hydrate(
    row: typeof sessions.$inferSelect,
    userOverride?: { id: string; name: string; scopes: string[] },
  ): Promise<SessionData> {
    let user = userOverride;
    if (!user) {
      const db = getDb();
      const u = await db.select().from(users).where(eq(users.id, row.userId));
      user = {
        id: u[0]!.companyUserId,
        name: u[0]!.name,
        scopes: u[0]!.scopes ?? [],
      };
    }
    return {
      sessionId: row.sessionId,
      userId: row.userId,
      clientId: row.clientId,
      refreshId: row.refreshId,
      user,
      companyAccessToken: row.companyAccessToken,
      companyRefreshToken: row.companyRefreshToken,
      companyTokenExpiresAt: row.companyTokenExpiresAt.getTime(),
      scope: row.scope,
      revoked: row.revoked,
      sessionType: row.sessionType,
    };
  }

  private async cacheGet(sessionId: string): Promise<SessionData | null> {
    const raw = await getRedis().get(CACHE_KEY(sessionId));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  private async cacheSet(data: SessionData): Promise<void> {
    await getRedis().set(
      CACHE_KEY(data.sessionId),
      JSON.stringify(data),
      "EX",
      CACHE_TTL,
    );
  }

  private async cacheInvalidate(sessionId: string): Promise<void> {
    await getRedis().del(CACHE_KEY(sessionId));
  }
}
