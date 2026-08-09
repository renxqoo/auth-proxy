import { eq } from "drizzle-orm";
import { scopes } from "@auth-proxy/db";
import { getDb } from "../infra.js";

/**
 * scope 仓储 —— 全局 scope 定义(层 1)。
 *
 * 取代环境变量白名单:scope 词汇表存库,可经 admin 后台增删。
 * 带 60s 内存缓存(校验热路径 device_authorization 每次 request 都查,
 * 避免每请求打 DB)。写操作(create/delete)自动失效缓存。
 */

export interface ScopeRecord {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
}

// ---------- 缓存 ----------
let cache: { names: Set<string>; systemNames: Set<string>; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function invalidateCache(): void {
  cache = null;
}

export class ScopeRepo {
  /** 列出全部 scope 定义(admin 后台用)。 */
  async list(): Promise<ScopeRecord[]> {
    const db = getDb();
    const rows = await db.select().from(scopes).orderBy(scopes.id);
    return rows;
  }

  /**
   * 拿全部 scope 名集合(校验用)。带缓存。
   * @returns { names: 全部 scope 名, systemNames: 系统 scope 名(isSystem=true) }
   */
  async getSets(): Promise<{ names: Set<string>; systemNames: Set<string> }> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return { names: cache.names, systemNames: cache.systemNames };
    }
    const db = getDb();
    const rows = await db
      .select({ name: scopes.name, isSystem: scopes.isSystem })
      .from(scopes);
    const names = new Set<string>();
    const systemNames = new Set<string>();
    for (const r of rows) {
      names.add(r.name);
      if (r.isSystem) systemNames.add(r.name);
    }
    cache = { names, systemNames, expiresAt: now + CACHE_TTL_MS };
    return { names, systemNames };
  }

  /** 创建 scope(name 唯一,冲突返回 null)。 */
  async create(params: {
    name: string;
    description?: string;
    isSystem?: boolean;
  }): Promise<ScopeRecord | null> {
    const db = getDb();
    try {
      const [row] = await db
        .insert(scopes)
        .values({
          name: params.name,
          description: params.description ?? null,
          isSystem: params.isSystem ?? false,
        })
        .returning();
      invalidateCache();
      return row;
    } catch {
      // 唯一约束冲突 → null
      return null;
    }
  }

  /** 删除 scope(by id)。返回是否命中。 */
  async delete(id: number): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(scopes)
      .where(eq(scopes.id, id))
      .returning({ id: scopes.id });
    if (rows.length > 0) invalidateCache();
    return rows.length > 0;
  }

  /** 按 id 查(删前校验 isSystem 用)。 */
  async findById(id: number): Promise<ScopeRecord | null> {
    const db = getDb();
    const rows = await db.select().from(scopes).where(eq(scopes.id, id));
    return rows[0] ?? null;
  }
}
