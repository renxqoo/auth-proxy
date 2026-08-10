import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /device_authorization 安全测试。
 *
 * 攻击面:该端点原本无限流。虽然要求有效 client 凭据(verifyClient),
 *        但若 client_secret 泄露,攻击者可无限刷 device_code,
 *        每个 device_code 在 Redis 占一个 key(TTL 10min)→ 内存耗尽 DoS。
 *
 * 修复:按 clientId 限流(RL_DEVICE_AUTH_MAX 次/分钟)。
 */

const { rlStore, redisMock } = vi.hoisted(() => {
  const store = new Map<string, { count: number; expireAt: number }>();
  const mock = {
    incr: vi.fn(async (key: string) => {
      const now = Date.now();
      const e = store.get(key);
      if (e && e.expireAt > now) return ++e.count;
      store.set(key, { count: 1, expireAt: now + 60_000 });
      return 1;
    }),
    expire: vi.fn(async (key: string, sec: number) => {
      const e = store.get(key);
      if (e) e.expireAt = Date.now() + sec * 1000;
      return 1;
    }),
    // 原子 Lua:INCR + 首次 EXPIRE(模拟 enforceRateLimit 真实路径)
    eval: vi.fn(async (_script: string, _n: number, key: string, expireArg: string) => {
      const now = Date.now();
      const e = store.get(key);
      if (e && e.expireAt > now) {
        e.count++;
        return [e.count, Math.ceil((e.expireAt - now) / 1000)];
      }
      const ttl = Number(expireArg);
      store.set(key, { count: 1, expireAt: now + ttl * 1000 });
      return [1, ttl];
    }),
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    multi: () => ({ set: () => {}, exec: async () => [] }),
  };
  return { rlStore: store, redisMock: mock };
});

const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => {
    return {
      deviceCode: "dc_test",
      userCode: "ABCD-EFGH",
      clientId: "cli_test",
      scope: "offline_access",
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    };
  }),
}));

vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));
vi.mock("../src/repos/index.js", () => ({
  // verifyClient 通过 → 返回 clientId
  getAppRepo: () => ({
    verifyClient: vi.fn(async (cid: string) => cid),
    findByClientId: vi.fn(async () => ({
      id: 1,
      clientId: "cli_test",
      name: "test",
      createdAt: new Date(),
      revoked: false,
      createdFromTokenId: null,
      lastUsedAt: null,
      allowedScopes: [],
    })),
  }),
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({ names: new Set<string>(), systemNames: new Set<string>() })),
  }),
}));
vi.mock("../src/deviceCodeStore.js", () => ({
  createDeviceCode: createSpy,
}));

import { deviceAuthorization } from "../src/routes/deviceAuthorization.js";

const fakeDeviceCode = {
  deviceCode: "dc_test",
  userCode: "ABCD-EFGH",
  clientId: "cli_test",
  scope: "offline_access",
  status: "pending",
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  rlStore.clear();
  // 重新设定默认返回(clearAllMocks 会清掉 mockResolvedValue)
  createSpy.mockResolvedValue(fakeDeviceCode);
});

function basicAuth(cid: string, secret: string): string {
  return "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64");
}

async function postDeviceAuth(clientId = "cli_test") {
  return deviceAuthorization.request("http://localhost/", {
    method: "POST",
    headers: {
      authorization: basicAuth(clientId, "secret"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "scope=offline_access",
  });
}

describe("SECURITY: /device_authorization 必须按 client 限流", () => {
  it("前 N 次请求正常(200)", async () => {
    const max = 30; // RL_DEVICE_AUTH_MAX 默认
    for (let i = 0; i < max; i++) {
      const r = await postDeviceAuth();
      expect(r.status).toBe(200);
    }
  });

  it("超过 N 次后第 N+1 次返回 429", async () => {
    const max = 30;
    for (let i = 0; i < max; i++) {
      await postDeviceAuth();
    }
    const blocked = await postDeviceAuth();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: string };
    expect(body.error).toMatch(/too_many|slow_down|rate/);
  });

  it("限流按 clientId 隔离:不同 client 互不影响", async () => {
    // client A 打满
    for (let i = 0; i < 30; i++) {
      await postDeviceAuth("cli_A");
    }
    // client B 仍可用
    const r = await postDeviceAuth("cli_B");
    expect(r.status).toBe(200);
  });

  it("429 响应带 Retry-After 头", async () => {
    for (let i = 0; i < 30; i++) {
      await postDeviceAuth();
    }
    const blocked = await postDeviceAuth();
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
});
