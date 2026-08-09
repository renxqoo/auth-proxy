import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * scope 层 3(client 绑定)测试。
 *
 * 验证:device_authorization 校验请求的 scope 是否在该 client 的 allowedScopes 内。
 * - allowedScopes 为空 → 允许全部已定义 scope(向后兼容)
 * - allowedScopes 非空 → 只允许列出的;越界 → invalid_scope
 *
 * 本测试 mock 了 scopeRepo(DB 全局定义)和 appRepo.findByClientId(client 绑定),
 * 聚焦层 3 的逻辑,不依赖真实 DB。
 */

// 限流 mock:始终放行
const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));

// 全局 scope 定义 mock(层 1):定义了这些 scope
const scopeSetsRef = vi.hoisted(() => ({
  names: new Set([
    "orders:read",
    "orders:write",
    "products:read",
    "admin",
    "offline_access",
    "company.api",
  ]),
  systemNames: new Set(["offline_access", "company.api"]),
}));

// client 绑定 mock(层 3):可动态切换 allowedScopes
// [] = 不限制(允许全部,向后兼容默认);非空 = 只允许列出的
const appRef = vi.hoisted(() => ({
  allowedScopes: [] as string[],
}));

const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async (_clientId: string, scope: string) => ({
    deviceCode: "dc_test",
    userCode: "TEST-CODE",
    clientId: "cli_test",
    scope,
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
      allowedScopes: appRef.allowedScopes,
    })),
  }),
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({
      names: scopeSetsRef.names,
      systemNames: scopeSetsRef.systemNames,
    })),
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
  appRef.allowedScopes = []; // 默认不限制(允许全部)
});

describe("scope 层 3:client 绑定(allowedScopes)", () => {
  it("allowedScopes 为空 → 允许全部已定义 scope", async () => {
    appRef.allowedScopes = [];
    const r = await postScope("orders:read");
    expect(r.status).toBe(200);
  });

  it("allowedScopes 非空 + 请求在允许内 → 200", async () => {
    appRef.allowedScopes = ["orders:read", "products:read"];
    const r = await postScope("orders:read");
    expect(r.status).toBe(200);
  });

  it("allowedScopes 非空 + 请求超出允许 → invalid_scope", async () => {
    appRef.allowedScopes = ["orders:read"];
    const r = await postScope("admin");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_scope");
    expect(body.error_description).toContain("not allowed for this client");
  });

  it("allowedScopes 不含 admin → 即使全局有 admin 也拒绝", async () => {
    appRef.allowedScopes = ["orders:read", "products:read"];
    const r = await postScope("admin");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_scope");
  });

  it("系统 scope(offline_access)不要求在 allowedScopes 内 → 自动补", async () => {
    appRef.allowedScopes = ["orders:read"]; // 不含 offline_access
    const r = await postScope("orders:read offline_access");
    expect(r.status).toBe(200); // offline_access 自动放行
  });
});

describe("scope 层 1:全局定义(仍生效)", () => {
  it("请求未定义的 scope → invalid_scope(即使 allowedScopes 空)", async () => {
    appRef.allowedScopes = [];
    const r = await postScope("evil:scope");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_scope");
  });
});
