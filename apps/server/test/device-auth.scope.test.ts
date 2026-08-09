import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /device_authorization scope 入口校验测试 —— RFC 6749 §3.3。
 *
 * 三层模型:
 *   层 1(全局):scope 必须在全局定义内。本测试模拟 DB scopes 表为空,
 *               触发回退到 config.allowedScopes 环境变量白名单(向后兼容)。
 *   层 3(client):allowedScopes 为空 = 允许全部(默认,本测试场景)。
 *
 * 用户 scope 收窄(层 2)在 token 端点测试,这里只测入口。
 */

// 限流 mock:始终放行(scope 校验在限流之后,确保能走到校验逻辑)
const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));

const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({
    deviceCode: "dc_test",
    userCode: "ABCD-WXYZ",
    clientId: "cli_test",
    scope: "offline_access",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  })),
}));

vi.mock("../src/repos/index.js", () => ({
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
      allowedScopes: [], // 空 = 允许全部(默认)
    })),
  }),
  // DB scopes 表为空 → 触发回退到 config.allowedScopes 环境变量(测向后兼容)
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({ names: new Set<string>(), systemNames: new Set<string>() })),
  }),
}));
vi.mock("../src/deviceCodeStore.js", () => ({
  createDeviceCode: createSpy,
}));

import { deviceAuthorization } from "../src/routes/deviceAuthorization.js";

function basicAuth(cid: string, secret: string): string {
  return "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64");
}

async function postScope(scope: string) {
  return deviceAuthorization.request("http://localhost/", {
    method: "POST",
    headers: {
      authorization: basicAuth("cli_test", "secret"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `scope=${encodeURIComponent(scope)}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RFC 6749 §3.3: /device_authorization scope 入口白名单校验", () => {
  it("合法 scope(orders:read)→ 200", async () => {
    const r = await postScope("orders:read");
    expect(r.status).toBe(200);
  });

  it("多个合法 scope → 200", async () => {
    const r = await postScope("orders:read products:read");
    expect(r.status).toBe(200);
  });

  it("不传 scope → 200(默认补 offline_access)", async () => {
    const r = await deviceAuthorization.request("http://localhost/", {
      method: "POST",
      headers: {
        authorization: basicAuth("cli_test", "secret"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { scope?: string };
    // device_authorization 响应本身不含 scope,但成功即代表通过校验
    expect(body.device_code).toBeTruthy();
  });

  it("非法 scope(foo:bar)→ 400 invalid_scope", async () => {
    const r = await postScope("foo:bar");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });

  it("合法 + 非法混入 → 400 invalid_scope(不静默裁剪)", async () => {
    const r = await postScope("orders:read evil:scope");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });

  it("explicit offline_access → 200(在白名单内)", async () => {
    const r = await postScope("offline_access");
    expect(r.status).toBe(200);
  });

  it("company.api(中间层聚合 scope)→ 200", async () => {
    const r = await postScope("company.api");
    expect(r.status).toBe(200);
  });

  it("company.api + offline_access(crm 客户端实际请求)→ 200", async () => {
    const r = await postScope("company.api offline_access");
    expect(r.status).toBe(200);
  });
});
