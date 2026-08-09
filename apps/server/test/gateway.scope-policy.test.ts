import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * gateway 路径-scope 策略测试(层 4,企业纵深防御)。
 *
 * 验证:
 * - token 含所需 scope + 路径有策略 → 放行
 * - token 缺所需 scope + 路径有策略 → 403 insufficient_scope
 * - 路径无任何策略 → 403(默认拒绝)
 * - 策略 scope=null → 只需有效 token,放行
 * - method 不匹配 → 不算匹配该策略 → 默认拒绝
 * - 通配符 /api/orders* 匹配 /api/orders/123
 *
 * 克隆 security.gateway-headers.test.ts 的 mock 结构。
 */

const redisRef: { redis: unknown } = { redis: { eval: async () => [1, 60] } };
vi.mock("../src/infra.js", () => ({ getRedis: () => redisRef.redis }));

vi.mock("../src/sessionStore.js", () => ({
  findSessionBySessionId: vi.fn(async () => ({
    sessionId: "sid_1",
    userId: 1,
    clientId: "cli_1",
    refreshId: "idrt_1",
    user: { id: "u1", name: "alice", scopes: ["orders:read"] },
    companyAccessToken: "ct_x",
    companyRefreshToken: "cr_x",
    companyTokenExpiresAt: Date.now() + 3600_000,
    scope: "offline_access",
    revoked: false,
  })),
}));

vi.mock("../src/companyTokenRefresher.js", () => ({
  getRefresher: () => ({
    ensureFresh: vi.fn(async () => "fresh-ct"),
  }),
  CompanyAuthError: class extends Error {},
}));

// JWT mock:可控 scope(测试切换)
const jwtRef = vi.hoisted(() => ({
  scope: "orders:read offline_access",
}));
vi.mock("../src/jwt.js", () => ({
  bearerOf: (h?: string) => h?.replace(/^Bearer\s+/, ""),
  verifyAccessToken: vi.fn(async (t?: string) =>
    t === "valid.jwt.token"
      ? { sub: "sid_1", scope: jwtRef.scope, aud: "auth-proxy", client_id: "cli_1", typ: "access" as const }
      : null,
  ),
}));

// 策略 mock:可控
const policiesRef = vi.hoisted(() => ({
  policies: [] as Array<{
    id: number;
    pattern: string;
    scope: string | null;
    method: string | null;
    description: string | null;
    createdAt: Date;
  }>,
}));
vi.mock("../src/repos/index.js", () => ({
  getAuditRepo: () => ({ writeApiLog: vi.fn(async () => {}) }),
  getRoutePolicyRepo: () => ({
    getPolicies: vi.fn(async () => policiesRef.policies),
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { gateway } from "../src/routes/gateway.js";

beforeEach(() => {
  vi.clearAllMocks();
  jwtRef.scope = "orders:read offline_access";
  policiesRef.policies = [];
});

async function proxyGet(path: string) {
  fetchMock.mockResolvedValueOnce(
    new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
  );
  return gateway.request(`http://localhost/proxy${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer valid.jwt.token" },
  });
}

describe("gateway scope 策略:有权限放行 / 无权限 403", () => {
  it("token 含 orders:read + 路径配 orders:read → 放行 200", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(200);
  });

  it("token 缺 orders:read + 路径配 orders:read → 403 insufficient_scope", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "offline_access"; // 没 orders:read
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.error_description).toContain("orders:read");
  });
});

describe("gateway 默认拒绝:无策略路径 → 403", () => {
  it("/api/unknown 无策略 → 403", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    const res = await proxyGet("/api/unknown");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
  });

  it("策略列表完全为空 → 所有路径 403", async () => {
    policiesRef.policies = [];
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(403);
  });
});

describe("gateway 策略 scope=null(只需登录)", () => {
  it("/api/profile 配 null scope → 有效 token 放行", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/profile", scope: null, method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "offline_access"; // 无业务 scope 也行
    const res = await proxyGet("/api/profile");
    expect(res.status).toBe(200);
  });
});

describe("gateway 通配符 + method 匹配", () => {
  it("/api/orders* 匹配 /api/orders/123", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    const res = await proxyGet("/api/orders/123");
    expect(res.status).toBe(200);
  });

  it("策略配 GET,POST 请求 → 不匹配 → 默认拒绝 403", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await gateway.request("http://localhost/proxy/api/orders", {
      method: "POST",
      headers: { Authorization: "Bearer valid.jwt.token" },
    });
    expect(res.status).toBe(403); // method 不匹配 → 默认拒绝
  });

  it("策略 method=null → 匹配所有方法", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: null, description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await gateway.request("http://localhost/proxy/api/orders", {
      method: "DELETE",
      headers: { Authorization: "Bearer valid.jwt.token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("gateway sessionType:agent(admin issue-token,带 company token)放行", () => {
  it("sessionType=agent + 有 company token + 路径策略放行 → 200(不应 403)", async () => {
    // 重新 mock findSessionBySessionId 返回 agent session + company token
    const { findSessionBySessionId } = await import("../src/sessionStore.js");
    vi.mocked(findSessionBySessionId).mockResolvedValueOnce({
      sessionId: "sid_agent",
      userId: 1,
      clientId: "admin-issued",
      refreshId: "idrt_agent",
      user: { id: "u_alice", name: "alice", scopes: ["orders:read"] },
      companyAccessToken: "ct_alice",
      companyRefreshToken: "cr_alice",
      companyTokenExpiresAt: Date.now() + 3600_000,
      scope: "orders:read offline_access",
      sessionType: "agent",
      revoked: false,
    } as never);
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(200);
  });

  it("sessionType=machine(client_credentials,占位 company token)→ 403", async () => {
    const { findSessionBySessionId } = await import("../src/sessionStore.js");
    vi.mocked(findSessionBySessionId).mockResolvedValueOnce({
      sessionId: "sid_machine",
      userId: 1,
      clientId: "cli_machine",
      refreshId: "idrt_machine",
      user: { id: "u_machine", name: "machine", scopes: [] },
      // 真实 createMachine 写入的占位值
      companyAccessToken: "__none__",
      companyRefreshToken: "__none__",
      companyTokenExpiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      scope: "offline_access",
      sessionType: "machine",
      revoked: false,
    } as never);
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "orders:read offline_access";
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toContain("company token");
  });
});

describe("RFC 6750 §3: WWW-Authenticate 响应头", () => {
  it("缺 token → 401 + WWW-Authenticate: Bearer realm=...", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    const res = await gateway.request("http://localhost/proxy/api/orders", {
      method: "GET",
      // 无 Authorization 头
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Bearer\s/);
    expect(wwwAuth).toContain('realm="');
  });

  it("无效 token → 401 + WWW-Authenticate", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    const res = await gateway.request("http://localhost/proxy/api/orders", {
      method: "GET",
      headers: { Authorization: "Bearer invalid.token" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer\s/);
  });

  it("insufficient_scope → 403 + WWW-Authenticate 带 error=insufficient_scope", async () => {
    policiesRef.policies = [
      { id: 1, pattern: "/api/orders*", scope: "orders:read", method: "GET", description: null, createdAt: new Date() },
    ];
    jwtRef.scope = "offline_access"; // 没 orders:read
    const res = await proxyGet("/api/orders");
    expect(res.status).toBe(403);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toContain('error="insufficient_scope"');
  });
});
