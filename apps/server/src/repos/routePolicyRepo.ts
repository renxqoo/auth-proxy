import { eq } from "drizzle-orm";
import { routePolicies } from "@auth-proxy/db";
import { getDb } from "../infra.js";

/**
 * 路径策略仓储 —— gateway 转发前的 scope 校验(层 4)。
 *
 * 企业级纵深防御:gateway 转发前查 token.scope 是否覆盖该路径所需 scope。
 * 默认拒绝:没匹配到任何策略的路径 → gateway 直接 403。
 *
 * pattern 用简单通配符:/api/orders* 匹配 /api/orders 和 /api/orders/123。
 * scope=null 表示"只需有效 token,不要业务 scope"。
 * method=null 表示匹配所有 HTTP 方法。
 *
 * 带 60s 内存缓存(gateway 每个请求都查,避免打 DB)。写操作自动失效缓存。
 */

export interface RoutePolicyRecord {
  id: number;
  pattern: string;
  scope: string | null;
  method: string | null;
  description: string | null;
  createdAt: Date;
}

// ---------- 缓存 ----------
let cache: { policies: RoutePolicyRecord[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

function invalidateCache(): void {
  cache = null;
}

/**
 * 简单通配符匹配:pattern 末尾的 * 匹配任意后缀。
 * - "/api/orders*" 匹配 "/api/orders"、"/api/orders/123"
 * - "/me" 精确匹配 "/me"(不含子路径)
 */
export function matchPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return path === prefix || path.startsWith(prefix);
  }
  return path === pattern;
}

/**
 * 找到匹配 (path, method) 的策略。method 不区分大小写;null 策略匹配所有方法。
 * 返回第一个匹配的;无匹配返回 null(调用方按默认拒绝处理)。
 */
export function findMatchingPolicy(
  policies: RoutePolicyRecord[],
  path: string,
  method: string,
): RoutePolicyRecord | null {
  const upperMethod = method.toUpperCase();
  for (const p of policies) {
    if (!matchPattern(p.pattern, path)) continue;
    if (p.method && p.method.toUpperCase() !== upperMethod) continue;
    return p;
  }
  return null;
}

export class RoutePolicyRepo {
  /** 列出全部策略(admin 后台用)。 */
  async list(): Promise<RoutePolicyRecord[]> {
    const db = getDb();
    const rows = await db.select().from(routePolicies).orderBy(routePolicies.id);
    return rows;
  }

  /** 拿全部策略(gateway 校验用)。带缓存。 */
  async getPolicies(): Promise<RoutePolicyRecord[]> {
    const now = Date.now();
    if (cache && cache.expiresAt > now) {
      return cache.policies;
    }
    const db = getDb();
    const rows = await db.select().from(routePolicies).orderBy(routePolicies.id);
    cache = { policies: rows, expiresAt: now + CACHE_TTL_MS };
    return rows;
  }

  /** 创建策略。返回创建的记录。 */
  async create(params: {
    pattern: string;
    scope?: string | null;
    method?: string | null;
    description?: string;
  }): Promise<RoutePolicyRecord> {
    const db = getDb();
    const [row] = await db
      .insert(routePolicies)
      .values({
        pattern: params.pattern,
        scope: params.scope ?? null,
        method: params.method ? params.method.toUpperCase() : null,
        description: params.description ?? null,
      })
      .returning();
    invalidateCache();
    return row;
  }

  /** 删除策略。返回是否命中。 */
  async delete(id: number): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(routePolicies)
      .where(eq(routePolicies.id, id))
      .returning({ id: routePolicies.id });
    if (rows.length > 0) invalidateCache();
    return rows.length > 0;
  }

  /** 按 id 查(删前校验用)。 */
  async findById(id: number): Promise<RoutePolicyRecord | null> {
    const db = getDb();
    const rows = await db.select().from(routePolicies).where(eq(routePolicies.id, id));
    return rows[0] ?? null;
  }
}
