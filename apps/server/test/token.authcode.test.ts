import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /token grant_type=authorization_code + PKCE 测试。
 *
 * OAuth 2.1 核心:授权码换 token,PKCE S256 校验 code_verifier。
 * 验证:
 * - 正确 code_verifier → 200 token
 * - code_verifier 不匹配 → 400 invalid_grant
 * - code 已消费 → invalid_grant
 * - 缺 code_verifier → invalid_request
 * - redirect_uri 不匹配 → invalid_grant
 */

const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));

// PKCE fixture:RFC 7636 附录 B 的标准示例值
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
// base64url(sha256(CODE_VERIFIER)) = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

// authCodeStore mock:可控的授权码记录(challenge 用固定值,避免 hoisted 时序问题)
const authCodeRef = vi.hoisted(() => ({
  record: {
    code: "ac_valid",
    clientId: "cli_test",
    redirectUri: "https://app.example.com/callback",
    scope: "orders:read offline_access",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    status: "authorized" as const,
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    companyToken: {
      access_token: "ct_x",
      refresh_token: "cr_x",
      token_type: "Bearer",
      expires_in: 3600,
      user: { id: "u_alice", name: "alice", scopes: ["orders:read"] },
    },
  },
  consumeResult: true,
}));
vi.mock("../src/authCodeStore.js", () => ({
  findAuthCode: vi.fn(async (code: string) =>
    code === authCodeRef.record.code ? { ...authCodeRef.record } : null,
  ),
  consumeAuthCode: vi.fn(async () =>
    authCodeRef.consumeResult ? { ...authCodeRef.record, status: "consumed" } : null,
  ),
}));

// sessionStore mock
vi.mock("../src/sessionStore.js", () => ({
  createSession: vi.fn(async () => ({
    sessionId: "sid_new",
    refreshId: "idrt_new",
    data: {
      sessionId: "sid_new",
      refreshId: "idrt_new",
      scope: "orders:read offline_access",
      userId: 1,
      clientId: "cli_test",
      user: { id: "u_alice", name: "alice", scopes: ["orders:read"] },
      companyAccessToken: "ct_x",
      companyRefreshToken: "cr_x",
      companyTokenExpiresAt: Date.now() + 3600_000,
      revoked: false,
    },
  })),
}));

// jwt mock
vi.mock("../src/jwt.js", () => ({
  verifyAccessToken: vi.fn(async () => null),
  verifyRefreshToken: vi.fn(async () => null),
  signAccessToken: vi.fn(async (_sid: string, scope: string, _cid: string) => `access.${scope}`),
  signRefreshToken: vi.fn(async (_sid: string, rid: string) => `refresh.${rid}`),
  bearerOf: (h?: string) => h?.replace(/^Bearer\s+/, ""),
}));

vi.mock("../src/repos/index.js", () => ({
  getAuditRepo: () => ({ writeLoginLog: vi.fn(async () => {}), writeApiLog: vi.fn(async () => {}) }),
  getAppRepo: () => ({ verifyClient: vi.fn(async () => null), touchLastUsed: vi.fn(async () => {}) }),
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({
      names: new Set(["orders:read", "offline_access"]),
      systemNames: new Set(["offline_access"]),
    })),
  }),
}));

import { token } from "../src/routes/token.js";

beforeEach(() => {
  vi.clearAllMocks();
  authCodeRef.record.status = "authorized";
  authCodeRef.record.codeChallenge = CODE_CHALLENGE;
  authCodeRef.consumeResult = true;
});

async function postAuthCode(body: Record<string, string>) {
  return token.request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

const VALID_EXCHANGE = {
  grant_type: "authorization_code",
  code: "ac_valid",
  redirect_uri: "https://app.example.com/callback",
  client_id: "cli_test",
  code_verifier: CODE_VERIFIER,
};

describe("authorization_code grant + PKCE:正确换 token", () => {
  it("正确 code_verifier → 200 + access_token + refresh_token", async () => {
    const res = await postAuthCode(VALID_EXCHANGE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("scope 从授权码继承(orders:read offline_access)", async () => {
    const res = await postAuthCode(VALID_EXCHANGE);
    const body = await res.json();
    expect(body.access_token).toContain("orders:read");
  });
});

describe("authorization_code grant:PKCE 校验", () => {
  it("code_verifier 不匹配 → 400 invalid_grant", async () => {
    const res = await postAuthCode({ ...VALID_EXCHANGE, code_verifier: "wrong-verifier" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("缺 code_verifier → 400 invalid_request", async () => {
    const { code_verifier: _cv, ...rest } = VALID_EXCHANGE;
    const res = await postAuthCode(rest);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });
});

describe("authorization_code grant:错误状态", () => {
  it("code 不存在 → 400 invalid_grant", async () => {
    const res = await postAuthCode({ ...VALID_EXCHANGE, code: "ac_nonexistent" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("redirect_uri 不匹配 → 400 invalid_grant", async () => {
    const res = await postAuthCode({
      ...VALID_EXCHANGE,
      redirect_uri: "https://evil.example.com/cb",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("code 已消费(status=consumed)→ invalid_grant", async () => {
    authCodeRef.record.status = "consumed";
    const res = await postAuthCode(VALID_EXCHANGE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("code 未授权(status=pending,用户还没登录确认)→ invalid_grant", async () => {
    authCodeRef.record.status = "pending";
    const res = await postAuthCode(VALID_EXCHANGE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});
