import { createDb, createRedis, type Db, type Redis } from "@auth-proxy/db";
import { config } from "./config.js";

/**
 * 进程级单例:PG 连接 + Redis 连接。
 * repo 从这里取连接,避免每处各自 new。
 */

let db: Db | null = null;
let redis: Redis | null = null;

export function getDb(): Db {
  if (!db) db = createDb(config.databaseUrl);
  return db;
}

export function getRedis(): Redis {
  if (!redis) redis = createRedis(config.redisUrl);
  return redis;
}

/** 测试/优雅关闭用。 */
export async function closeInfra(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (db) {
    tasks.push(db.$client.end());
    db = null;
  }
  if (redis) {
    tasks.push(redis.quit());
    redis = null;
  }
  await Promise.all(tasks);
}
