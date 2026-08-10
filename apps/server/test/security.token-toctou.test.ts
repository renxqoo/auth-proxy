import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 攻击场景:一次性注册令牌的 TOCTOU 竞态。
 *
 * 漏洞:/register 流程是两步:
 *   1. tokenRepo.verify(token) → 读 used=false → 返回 tokenId
 *   2. tokenRepo.recordUse(id) → 写 used=true
 * 两步之间无原子保护。两个并发 /register 请求都执行步骤 1(都看到 used=false),
 * 都拿到 tokenId,然后各自步骤 2 → 生成两个 client。
 *
 * 安全后果:本应"单次使用"的邀请/注册令牌被复制消费,绕过准入控制。
 *
 * 修复:verify 和 consume 必须原子。最干净的方式是把"校验+标记已用"合并成
 * 一条带条件的 UPDATE...RETURNING:
 *   UPDATE registration_tokens SET used=true, use_count=use_count+1
 *   WHERE id=$1 AND single_use=true AND used=false AND revoked=false AND ...
 *   RETURNING id
 * 只有抢到这行的那个请求 RETURNING 非空,其余返回空 → 拒绝。
 */

// 模拟 PG 行为:支持原子条件 UPDATE
function makeTokenStore() {
  const tokens = new Map<number, {
    id: number;
    token: string;
    singleUse: boolean;
    used: boolean;
    revoked: boolean;
    expiresAt: Date;
    useCount: number;
  }>();
  return {
    tokens,
    seed(t: { id: number; token: string; singleUse?: boolean; used?: boolean; revoked?: boolean; expiresAt?: Date }) {
      tokens.set(t.id, {
        id: t.id,
        token: t.token,
        singleUse: t.singleUse ?? true,
        used: t.used ?? false,
        revoked: t.revoked ?? false,
        expiresAt: t.expiresAt ?? new Date(Date.now() + 86400_000),
        useCount: 0,
      });
    },
  };
}
const store = makeTokenStore();

// 持有当前 tokenRepo 实现(测试切换 old/new)
const tokenRepoRef: {
  verify: (t: string) => Promise<number | null>;
  recordUse: (id: number) => Promise<void>;
  consumeSingleUse: (t: string) => Promise<number | null>;
} = {
  verify: async () => null,
  recordUse: async () => {},
  consumeSingleUse: async () => null,
};

const appCreateSpy = vi.fn(async () => {});
// Redis mock:让限流总是通过(本测试聚焦 token TOCTOU,不测限流)
const redisRef: { redis: unknown } = {
  redis: {
    eval: async () => [1, 60], // count=1,总不触发限流
  },
};

vi.mock("../src/repos/index.js", () => ({
  getTokenRepo: () => tokenRepoRef,
  getAppRepo: () => ({ create: appCreateSpy }),
}));
vi.mock("../src/infra.js", () => ({ getRedis: () => redisRef.redis }));

beforeEach(() => {
  store.tokens.clear();
  appCreateSpy.mockClear();
  appCreateSpy.mockResolvedValue(undefined);
});

import { register } from "../src/routes/register.js";

async function postRegister(token: string, ip = "1.1.1.1") {
  return register.request("http://localhost/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ registrationToken: token, client_name: "toctou-test" }),
  });
}

/** 安装"旧实现"(有 TOCTOU 漏洞):verify 只读,recordUse 只写。 */
function installVulnerableImpl() {
  tokenRepoRef.verify = async (token: string) => {
    for (const t of store.tokens.values()) {
      if (t.token !== token) continue;
      if (t.revoked) return null;
      if (t.expiresAt.getTime() <= Date.now()) return null;
      if (t.singleUse && t.used) return null;
      return t.id; // 只读,不修改 used
    }
    return null;
  };
  tokenRepoRef.recordUse = async (id: number) => {
    const t = store.tokens.get(id);
    if (!t) return;
    t.useCount++;
    if (t.singleUse) t.used = true;
  };
  tokenRepoRef.consumeSingleUse = async () => null; // 旧实现不用
}

/** 安装"修复实现":原子条件 UPDATE。 */
function installFixedImpl() {
  tokenRepoRef.verify = async () => null; // 修复路径不用单独 verify
  tokenRepoRef.recordUse = async () => {}; // 修复路径不用单独 recordUse
  tokenRepoRef.consumeSingleUse = async (token: string) => {
    // 模拟原子 UPDATE...WHERE used=false RETURNING id
    for (const t of store.tokens.values()) {
      if (t.token !== token) continue;
      if (t.revoked) return null;
      if (t.expiresAt.getTime() <= Date.now()) return null;
      if (!t.singleUse) {
        // 多次令牌:直接 +1(允许多次)
        t.useCount++;
        return t.id;
      }
      // 一次性:原子抢占
      if (t.used) return null; // 已被抢
      t.used = true;
      t.useCount++;
      return t.id;
    }
    return null;
  };
}

describe("根因文档化:旧的两步(verify 只读 + recordUse 后写)有竞态窗口", () => {
  beforeEach(() => {
    installVulnerableImpl();
    store.seed({ id: 1, token: "rt_single", singleUse: true });
  });

  it("两个并发调用 verify 都返回 id(都看到 used=false)→ 证明竞态存在", async () => {
    // 直接调 repo 层的两步,不经过路由
    const t1 = await tokenRepoRef.verify("rt_single");
    const t2 = await tokenRepoRef.verify("rt_single");
    // 两个都拿到 tokenId(因为 verify 只读,没改 used)
    expect(t1).toBe(1);
    expect(t2).toBe(1);
    // 这就是漏洞根因:两次 verify 都通过,之后各自 recordUse
    await tokenRepoRef.recordUse(1);
    await tokenRepoRef.recordUse(1);
    const t = store.tokens.get(1)!;
    expect(t.useCount).toBe(2); // 被消费两次,本应只一次
  });
});

describe("SECURITY(修复):单次令牌并发只能被消费一次", () => {
  beforeEach(() => {
    installFixedImpl();
    store.seed({ id: 1, token: "rt_single", singleUse: true });
  });

  it("并发请求:只有一个 201,其余 401", async () => {
    const results = await Promise.all([
      postRegister("rt_single", "1.1.1.1"),
      postRegister("rt_single", "2.2.2.2"),
      postRegister("rt_single", "3.3.3.3"),
      postRegister("rt_single", "4.4.4.4"),
      postRegister("rt_single", "5.5.5.5"),
    ]);
    const ok = results.filter((r) => r.status === 201);
    const fail = results.filter((r) => r.status === 401);
    expect(ok.length).toBe(1); // 只有一个成功
    expect(fail.length).toBe(4);
    expect(appCreateSpy).toHaveBeenCalledTimes(1); // 只创建一个 client
    const t = store.tokens.get(1)!;
    expect(t.useCount).toBe(1);
    expect(t.used).toBe(true);
  });

  it("已使用的单次令牌再注册 → 401", async () => {
    const first = await postRegister("rt_single", "1.1.1.1");
    expect(first.status).toBe(201);
    const second = await postRegister("rt_single", "9.9.9.9");
    expect(second.status).toBe(401);
  });

  it("多次令牌(singleUse=false)仍可多次使用", async () => {
    store.tokens.clear();
    store.seed({ id: 2, token: "rt_multi", singleUse: false });
    const a = await postRegister("rt_multi", "1.1.1.1");
    const b = await postRegister("rt_multi", "2.2.2.2");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const t = store.tokens.get(2)!;
    expect(t.useCount).toBe(2);
    expect(t.used).toBe(false); // 多次令牌不标 used
  });

  it("已吊销的令牌 → 401(即便没用过)", async () => {
    store.tokens.clear();
    store.seed({ id: 3, token: "rt_revoked", singleUse: true, revoked: true });
    const r = await postRegister("rt_revoked", "1.1.1.1");
    expect(r.status).toBe(401);
  });

  it("已过期令牌 → 401", async () => {
    store.tokens.clear();
    store.seed({
      id: 4,
      token: "rt_expired",
      singleUse: true,
      expiresAt: new Date(Date.now() - 1000),
    });
    const r = await postRegister("rt_expired", "1.1.1.1");
    expect(r.status).toBe(401);
  });
});
