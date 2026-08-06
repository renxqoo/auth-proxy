import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Redis } from "ioredis";
import type { Redis as RedisType } from "ioredis";
import * as schema from "./schema.js";

/**
 * PG / Redis 客户端工厂。
 * - PG 用 postgres.js 驱动 + drizzle
 * - Redis 用 ioredis;默认 db=2 隔离(避免污染本机其它程序的 db0)
 */

export function createDb(url?: string) {
  const connStr =
    url ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/auth-proxy";
  const queryClient = postgres(connStr, { max: 10 });
  return drizzle(queryClient, { schema });
}

export function createRedis(url?: string): Redis {
  const connStr = url ?? process.env.REDIS_URL ?? "redis://localhost:6379/2";
  return new Redis(connStr, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}

export type Db = ReturnType<typeof createDb>;
export type { RedisType as Redis };
export { schema };
