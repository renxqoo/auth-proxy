import type { MiddlewareHandler } from "hono";
import { getRedis } from "../infra.js";

/**
 * 基于 Redis 的固定窗口限流。
 *
 * INCR + EXPIRE 实现固定窗口:首次 INCR 时设过期(=窗口长度)。
 * 跨实例共享(Redis 是中心化计数器)。
 *
 * 提供两种用法:
 * 1. rateLimit(opts)  —— hono 中间件(挂路由,按 keyGenerator 限流)
 * 2. enforceRateLimit(key, opts) —— 路由内调用,返回是否允许(适合需先解析请求体/JWT 的场景)
 */

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  prefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * 原子限流 Lua 脚本。
 *
 * 安全动机:原实现 `INCR` 后单独 `EXPIRE`,两条命令非原子。
 * 若在两者之间进程崩溃(OOM/部署重启)或 Redis 短暂不可用,
 * key 会"存在但无 TTL" → 计数器永不过期 → 该 IP/client 被永久锁死,
 * 构成 DoS。攻击者也可通过制造并发/抖动主动触发。
 *
 * Lua 脚本在 Redis 单线程内原子执行:INCR + 条件 EXPIRE 要么一起成功
 * 要么一起不生效,绝不会留下无 TTL 的计数 key。
 *
 * 返回:{ count, ttl_sec }
 * - count:当前窗口计数
 * - ttl_sec:key 的 TTL(供 debug/响应头)
 */
const RATELIMIT_LUA = `local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return { count, redis.call('TTL', KEYS[1]) }`;

/** 路由内调用:检查并计数。返回 { allowed, remaining, retryAfterSec }。 */
export async function enforceRateLimit(
  key: string,
  opts: RateLimitOptions,
): Promise<RateLimitResult> {
  const prefix = opts.prefix ?? "rl";
  const windowSec = Math.ceil(opts.windowMs / 1000);
  const redisKey = `${prefix}:${key}`;
  // 原子 INCR + EXPIRE:Lua 脚本保证不会出现"key 存在但无 TTL"
  const result = (await getRedis().eval(
    RATELIMIT_LUA,
    1,
    redisKey,
    String(windowSec),
  )) as number[];
  const count = result[0] ?? 0;

  const remaining = Math.max(0, opts.limit - count);
  return {
    allowed: count <= opts.limit,
    remaining,
    retryAfterSec: windowSec,
  };
}

/** hono 中间件形式。keyGenerator 决定限流维度。 */
export function rateLimit(
  opts: RateLimitOptions & {
    keyGenerator: (c: {
      req: { header: (n: string) => string | undefined };
    }) => string | Promise<string>;
  },
): MiddlewareHandler {
  return async (c, next) => {
    const key = await opts.keyGenerator(c);
    const r = await enforceRateLimit(key, opts);
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(r.remaining));
    if (!r.allowed) {
      return c.json(
        {
          error: "too_many_requests",
          error_description: "rate limit exceeded",
        },
        429,
        { "Retry-After": String(r.retryAfterSec) },
      );
    }
    await next();
  };
}

export function getClientIp(c: {
  req: { header: (n: string) => string | undefined };
}): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("remote-address") ??
    "unknown"
  );
}
