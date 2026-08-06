import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 攻击场景:gateway /proxy/* 透传上游(公司应用)响应头,过滤不充分。
 *
 * 漏洞:原实现只剥 transfer-encoding/connection/keep-alive(hop-by-hop)。
 * 但上游的 set-cookie / location / server / x-powered-by 等会原样透传给 CLI:
 *   - set-cookie:泄露公司应用的会话 cookie(信息泄露;CLI 用不上)
 *   - location:可能诱导 CLI 跟随非预期跳转(开放重定向)
 *   - server / x-powered-by:暴露上游技术栈(指纹)
 *
 * 修复:白名单透传业务头(content-type 等),其余(尤其 cookie/location)剥除。
 *      透传原则针对 body;头要按最小必要原则。
 */

// mock findSessionBySessionId(返回有效 session) + refresher + jwt
const redisRef: { redis: unknown } = { redis: { eval: async () => [1, 60] } };
vi.mock("../src/infra.js", () => ({ getRedis: () => redisRef.redis }));
vi.mock("../src/sessionStore.js", () => ({
  findSessionBySessionId: vi.fn(async () => ({
    sessionId: "sid_1",
    userId: 1,
    clientId: "cli_1",
    refreshId: "idrt_1",
    user: { id: "u1", name: "alice", scopes: [] },
    companyAccessToken: "company-access-token",
    companyRefreshToken: "company-refresh-token",
    companyTokenExpiresAt: Date.now() + 3600_000,
    scope: "offline_access",
    revoked: false,
  })),
}));
vi.mock("../src/companyTokenRefresher.js", () => ({
  getRefresher: () => ({
    ensureFresh: vi.fn(async () => "fresh-company-token"),
  }),
  CompanyAuthError: class extends Error {},
}));
vi.mock("../src/jwt.js", () => ({
  bearerOf: (h?: string) => h?.replace(/^Bearer\s+/, ""),
  verifyAccessToken: vi.fn(async (t?: string) =>
    t === "valid.jwt.token"
      ? { sub: "sid_1", scope: "offline_access", typ: "access" as const }
      : null,
  ),
}));
vi.mock("../src/repos/index.js", () => ({
  getAuditRepo: () => ({
    writeApiLog: vi.fn(async () => {}),
  }),
}));

// 控制 fetch 返回(模拟上游响应)
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { gateway } from "../src/routes/gateway.js";

beforeEach(() => {
  vi.clearAllMocks();
});

async function proxyGet(path = "/orders", upstreamHeaders: Record<string, string> = {}, upstreamBody = '{"ok":true}') {
  fetchMock.mockResolvedValueOnce(
    new Response(upstreamBody, {
      status: 200,
      headers: upstreamHeaders,
    }),
  );
  const res = await gateway.request(`http://localhost/proxy${path}`, {
    method: "GET",
    headers: { Authorization: "Bearer valid.jwt.token" },
  });
  return res;
}

describe("SECURITY: gateway 不透传上游 set-cookie / location", () => {
  it("上游 set-cookie → 不透传给 CLI", async () => {
    const res = await proxyGet("/orders", {
      "content-type": "application/json",
      "set-cookie": "company_session=abc123; Path=/; HttpOnly",
    });
    const sc = res.headers.get("set-cookie");
    expect(sc).toBeNull(); // 必须剥除
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("上游多个 set-cookie → 全部剥除", async () => {
    // fetch 返回多 set-cookie(用 Headers 无法多值,这里测单条已够;补 server 头)
    const res = await proxyGet("/x", {
      "set-cookie": "a=1",
      server: "CompanyInternalApp/2.0",
      "x-powered-by": "Express",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("上游 location(重定向)→ 不透传(防开放重定向)", async () => {
    const res = await proxyGet("/old", {
      location: "https://internal.company.com/admin",
    });
    expect(res.headers.get("location")).toBeNull();
  });

  it("业务头 content-type 仍正常透传", async () => {
    const res = await proxyGet("/orders", {
      "content-type": "application/json; charset=utf-8",
    });
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("响应 body 原样透传(忠实转写契约)", async () => {
    const res = await proxyGet("/orders", {}, '{"data":[1,2,3]}');
    expect(await res.text()).toBe('{"data":[1,2,3]}');
  });

  it("上游 4xx 状态码原样透传(不包装)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"not_found"}', {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await gateway.request("http://localhost/proxy/missing", {
      method: "GET",
      headers: { Authorization: "Bearer valid.jwt.token" },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not_found"}');
  });
});

describe("SECURITY: gateway 鉴权 —— 缺/错 token 拒绝", () => {
  it("无 Authorization → invalid_grant", async () => {
    const res = await gateway.request("http://localhost/proxy/x", {
      method: "GET",
    });
    expect(res.status).toBe(400); // oauthError invalid_grant → 400
  });

  it("无效 token → invalid_grant", async () => {
    const res = await gateway.request("http://localhost/proxy/x", {
      method: "GET",
      headers: { Authorization: "Bearer invalid" },
    });
    expect(res.status).toBe(400);
  });
});
