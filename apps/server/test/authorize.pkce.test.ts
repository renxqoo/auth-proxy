import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /authorize —— RFC 6749 §4.1.1 + PKCE(RFC 7636)测试。
 *
 * OAuth 2.1:authorization_code 是核心流程,PKCE 强制 S256。
 * 本测试聚焦 /authorize 端点的参数校验与授权码签发(不测登录确认页)。
 */

const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));

// client 查找:存在 cli_test(redirect_uris 含测试回调)
vi.mock("../src/repos/index.js", () => ({
  getAppRepo: () => ({
    findByClientId: vi.fn(async (cid: string) =>
      cid === "cli_test"
        ? {
            id: 1, clientId: "cli_test", name: "test", createdAt: new Date(),
            revoked: false, createdFromTokenId: null, lastUsedAt: null,
            allowedScopes: [], redirectUris: ["https://app.example.com/callback"],
            grantTypes: ["authorization_code", "refresh_token"],
            tokenEndpointAuthMethod: "none",
          }
        : null,
    ),
  }),
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({
      names: new Set(["orders:read", "offline_access", "admin"]),
      systemNames: new Set(["offline_access"]),
    })),
  }),
  getAuthCodeRepo: () => ({
    create: vi.fn(async () => {}),
  }),
}));

// authCodeStore mock:createAuthCode 返回可辨识的 code
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({
    code: "ac_testcode",
    clientId: "cli_test",
    redirectUri: "https://app.example.com/callback",
    scope: "orders:read offline_access",
    codeChallenge: "challenge123",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
  })),
}));
vi.mock("../src/authCodeStore.js", () => ({
  createAuthCode: createSpy,
}));

import { authorize } from "../src/routes/authorize.js";

beforeEach(() => {
  vi.clearAllMocks();
  createSpy.mockResolvedValue({
    code: "ac_testcode",
    clientId: "cli_test",
    redirectUri: "https://app.example.com/callback",
    scope: "orders:read offline_access",
    codeChallenge: "challenge123",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
  });
});

async function getAuthorize(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return authorize.request(`http://localhost/?${qs}`, { method: "GET" });
}

const VALID = {
  response_type: "code",
  client_id: "cli_test",
  redirect_uri: "https://app.example.com/callback",
  scope: "orders:read",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "xyz123",
};

describe("RFC 6749 §4.1.1: GET /authorize 参数校验", () => {
  it("合法请求 → 302 重定向,带 code + state", async () => {
    const res = await getAuthorize(VALID);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("https://app.example.com/callback");
    expect(loc).toContain("code=ac_testcode");
    expect(loc).toContain("state=xyz123");
  });

  it("缺 code_challenge → 400 invalid_request(PKCE 强制)", async () => {
    const { code_challenge: _cc, ...rest } = VALID;
    const res = await getAuthorize(rest);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain("code_challenge");
  });

  it("code_challenge_method ≠ S256 → 400 invalid_request(OAuth 2.1 禁止 plain)", async () => {
    const res = await getAuthorize({ ...VALID, code_challenge_method: "plain" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
  });

  it("response_type ≠ code → 400 unsupported_response_type", async () => {
    const res = await getAuthorize({ ...VALID, response_type: "token" });
    expect(res.status).toBe(400);
  });

  it("client_id 不存在 → invalid_client", async () => {
    const res = await getAuthorize({ ...VALID, client_id: "cli_unknown" });
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });

  it("redirect_uri 不在 client 注册的列表 → 400 invalid_request", async () => {
    const res = await getAuthorize({
      ...VALID,
      redirect_uri: "https://evil.example.com/callback",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid|unauthorized/);
  });

  it("scope 非法(不在全局定义)→ 400 invalid_scope", async () => {
    const res = await getAuthorize({ ...VALID, scope: "evil:scope" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_scope");
  });

  it("缺 state 仍能工作(state 可选,但回显时省略)", async () => {
    const { state: _st, ...rest } = VALID;
    const res = await getAuthorize(rest);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).not.toContain("state=");
  });
});
