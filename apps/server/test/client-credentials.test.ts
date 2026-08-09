import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * client_credentials grant(RFC 6749 §4.4)测试。
 *
 * 机器对机器:无用户参与,用 client_id + client_secret 换 token。
 * session 标记为 "machine",不需要 company token。
 */

const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({
  getRedis: () => redisMock,
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => [{ id: 1, companyUserId: "__system_client_credentials__", name: "System", scopes: [] }] }) }),
  }),
}));

vi.mock("../src/repos/index.js", () => ({
  getAppRepo: () => ({
    verifyClient: vi.fn(async (cid: string) => (cid === "cli_machine" ? cid : null)),
    findByClientId: vi.fn(async () => ({
      id: 1, clientId: "cli_machine", name: "machine", createdAt: new Date(),
      revoked: false, createdFromTokenId: null, lastUsedAt: null,
      allowedScopes: [], redirectUris: [], grantTypes: ["client_credentials"],
      tokenEndpointAuthMethod: "client_secret_basic",
    })),
  }),
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({
      names: new Set(["orders:read", "offline_access", "products:read"]),
      systemNames: new Set(["offline_access"]),
    })),
  }),
  getAuditRepo: () => ({ writeLoginLog: vi.fn(async () => {}), writeApiLog: vi.fn(async () => {}) }),
}));

// sessionStore mock
vi.mock("../src/sessionStore.js", () => ({
  createMachineSession: vi.fn(async () => ({
    sessionId: "sid_machine",
    refreshId: "idrt_machine",
    data: {
      sessionId: "sid_machine", refreshId: "idrt_machine", scope: "orders:read offline_access",
      userId: 1, clientId: "cli_machine",
      user: { id: "__system__", name: "System", scopes: [] },
      companyAccessToken: "__none__", companyRefreshToken: "__none__",
      companyTokenExpiresAt: Date.now() + 365 * 86400 * 1000,
      revoked: false, sessionType: "machine",
    },
  })),
}));

vi.mock("../src/jwt.js", () => ({
  verifyAccessToken: vi.fn(async () => null),
  verifyRefreshToken: vi.fn(async () => null),
  signAccessToken: vi.fn(async (_sid: string, scope: string, _cid: string) => `access.${scope}`),
  signRefreshToken: vi.fn(async (_sid: string, rid: string) => `refresh.${rid}`),
  bearerOf: (h?: string) => h?.replace(/^Bearer\s+/, ""),
}));

import { token } from "../src/routes/token.js";

function basicAuth(cid: string, secret: string): string {
  return "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("client_credentials grant(RFC 6749 §4.4)", () => {
  it("正确 client 凭证 → 200 + access_token + refresh_token", async () => {
    const res = await token.request("http://localhost/", {
      method: "POST",
      headers: {
        authorization: basicAuth("cli_machine", "secret"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "orders:read",
      }).toString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toContain("orders:read");
    expect(body.refresh_token).toBeTruthy();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it("无效 client 凭证 → 401 invalid_client", async () => {
    const res = await token.request("http://localhost/", {
      method: "POST",
      headers: {
        authorization: basicAuth("wrong", "wrong"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("非法 scope → 400 invalid_scope", async () => {
    const res = await token.request("http://localhost/", {
      method: "POST",
      headers: {
        authorization: basicAuth("cli_machine", "secret"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "evil:scope",
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_scope");
  });

  it("不传 scope → 200(默认 offline_access)", async () => {
    const res = await token.request("http://localhost/", {
      method: "POST",
      headers: {
        authorization: basicAuth("cli_machine", "secret"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toContain("offline_access");
  });
});
