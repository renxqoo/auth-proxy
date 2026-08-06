import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 攻击场景:enforceRateLimit 的 INCR + EXPIRE 非原子。
 *
 * 根因(旧实现):`INCR` 后单独 `EXPIRE`,两条命令非原子。若在两者之间
 * 进程崩溃(OOM/部署重启)或 Redis 短暂不可用,key 会"存在但无 TTL"
 * → 计数器永不过期 → 该 IP/client 被永久锁死 → DoS。
 *
 * 修复:改用 Lua 脚本(单线程内原子)。本测试验证:
 * A. 旧模式(INCR + EXPIRE 分离)能被构造出无 TTL 的 key —— 文档化根因
 * B. 新 enforceRateLimit(原子)在 expire mock 抛错时不会留下无 TTL key
 * C. 正常路径计数/TTL 正确
 */

// 模拟 Redis:store 显式区分"有 TTL" vs "无 TTL(永久)"
function makeRedis(opts: {
  expireThrowsOnce?: boolean;
} = {}) {
  const store = new Map<string, { value: number; expireAt: number | null }>();
  let expireCallCount = 0;
  const redis = {
    store,
    incr: vi.fn(async (key: string) => {
      const e = store.get(key);
      if (e && (e.expireAt === null || e.expireAt > Date.now())) {
        e.value++;
        return e.value;
      }
      store.set(key, { value: 1, expireAt: null }); // 新 key 默认无 TTL
      return 1;
    }),
    expire: vi.fn(async (key: string, sec: number) => {
      expireCallCount++;
      if (opts.expireThrowsOnce && expireCallCount === 1) {
        // 模拟:INCR 已成功,EXPIRE 前连接断/进程崩
        throw new Error("Connection closed during EXPIRE");
      }
      const e = store.get(key);
      if (e) e.expireAt = Date.now() + sec * 1000;
      return 1;
    }),
    // 原子 Lua:INCR + 首次 EXPIRE 一起,绝不中间失败
    eval: vi.fn(async (_script: string, _n: number, key: string, expireArg: string) => {
      const e = store.get(key);
      if (e && e.expireAt && e.expireAt > Date.now()) {
        e.value++;
        return [e.value, Math.ceil((e.expireAt - Date.now()) / 1000)];
      }
      const ttl = Number(expireArg);
      store.set(key, { value: 1, expireAt: Date.now() + ttl * 1000 });
      return [1, ttl];
    }),
    ttl: vi.fn(async (key: string) => {
      const e = store.get(key);
      if (!e) return -2;
      if (e.expireAt === null) return -1; // 无 TTL(永久)
      const ms = e.expireAt - Date.now();
      return ms > 0 ? Math.ceil(ms / 1000) : -2;
    }),
  };
  return redis;
}
type FakeRedis = ReturnType<typeof makeRedis>;

const redisRef: { redis: FakeRedis } = { redis: makeRedis() };
vi.mock("../src/infra.js", () => ({ getRedis: () => redisRef.redis }));

beforeEach(() => {
  redisRef.redis = makeRedis();
});

import { enforceRateLimit } from "../src/middleware/rateLimit.js";

describe("根因文档化:旧的 INCR+EXPIRE 分离模式会留下无 TTL key", () => {
  it("INCR 成功后 EXPIRE 抛错 → key 永久存在(TTL=-1)", async () => {
    const r = makeRedis({ expireThrowsOnce: true });
    // 模拟旧实现的手动两步
    await r.incr("rl:x").catch(() => {});
    await r.expire("rl:x", 60).catch(() => {
      /* ignore */
    });
    expect(await r.ttl("rl:x")).toBe(-1); // 永久锁死
  });
});

describe("SECURITY: enforceRateLimit(原子 Lua)不会留下无 TTL key", () => {
  it("即便 expire 底层会抛错,原子 eval 也不走 expire → key 要么不存在要么有 TTL", async () => {
    // eval 不受 expireThrowsOnce 影响(原子路径不调 expire)
    redisRef.redis = makeRedis({ expireThrowsOnce: true });
    await enforceRateLimit("safe-ip", {
      windowMs: 60_000,
      limit: 5,
      prefix: "rl",
    });
    const ttl = await redisRef.redis.ttl("rl:safe-ip");
    // 契约:绝不能是 -1(永久)。这里应是正数(原子成功 + 有 TTL)
    expect(ttl).not.toBe(-1);
    expect(ttl).toBeGreaterThan(0);
  });

  it("enforceRateLimit 用的是 eval(原子),不是裸 incr+expire", async () => {
    redisRef.redis = makeRedis();
    await enforceRateLimit("k", { windowMs: 60_000, limit: 5, prefix: "rl" });
    expect(redisRef.redis.eval).toHaveBeenCalledTimes(1);
    expect(redisRef.redis.incr).not.toHaveBeenCalled();
    expect(redisRef.redis.expire).not.toHaveBeenCalled();
  });
});

describe("SECURITY: 正常计数 + TTL 契约", () => {
  it("首次请求:count=1, remaining=limit-1, TTL>0", async () => {
    redisRef.redis = makeRedis();
    const r = await enforceRateLimit("normal", {
      windowMs: 60_000,
      limit: 5,
      prefix: "rl",
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(await redisRef.redis.ttl("rl:normal")).toBeGreaterThan(0);
  });

  it("多次请求:count 递增,到 limit 后 allowed=false", async () => {
    redisRef.redis = makeRedis();
    for (let i = 0; i < 5; i++) {
      const r = await enforceRateLimit("cap", {
        windowMs: 60_000,
        limit: 5,
        prefix: "rl",
      });
      expect(r.allowed).toBe(true);
    }
    const blocked = await enforceRateLimit("cap", {
      windowMs: 60_000,
      limit: 5,
      prefix: "rl",
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });
});
