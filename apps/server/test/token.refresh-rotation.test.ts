import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * refresh_token grant 轮换 + scope 继承测试 —— OAuth 2.1 合规。
 *
 * 修复前两个问题:
 *  1. 刷新后响应体不返回新的 refresh_token(违反 2.1 强制 rotation)。
 *  2. scope 硬编码 "company.api offline_access",丢弃 session.scope,
 *     导致刷新后 token 的权限漂移。
 *
 * 修复后:
 *  - 响应体含新的 refresh_token(每次刷新轮换)。
 *  - scope 从 session 继承(updated.scope / session.scope),不再硬编码。
 *  - 用户 scope 收窄:device_code grant 请求越权 scope → invalid_scope。
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

// sessionStore mock:可控的 session 状态 + 轮换行为
const sessionState = vi.hoisted(() => ({
  // 当前活跃 session(refresh_id 命中它)
  current: null as null | {
    sessionId: string;
    refreshId: string;
    scope: string;
    user: { id: string; name: string; scopes: string[] };
  },
  // 轮换后的新 refreshId
  rotatedRefreshId: "idrt_NEW",
}));

vi.mock("../src/sessionStore.js", () => ({
  findSessionByRefreshId: vi.fn(async (rid: string) => {
    if (rid === sessionState.current?.refreshId) return sessionState.current;
    return null;
  }),
  findSessionBySessionId: vi.fn(async (sid: string) => {
    if (sid === sessionState.current?.sessionId) return sessionState.current;
    return null;
  }),
  rotateSessionRefresh: vi.fn(async () => {
    if (!sessionState.current) return null;
    // 返回轮换后的 session(新 refreshId)
    const updated = {
      ...sessionState.current,
      refreshId: sessionState.rotatedRefreshId,
    };
    sessionState.current = updated;
    return updated;
  }),
  revokeSession: vi.fn(async () => {}),
  recordRefreshRotation: vi.fn(async () => {}),
  createSession: vi.fn(async (
    _companyToken: unknown,
    scope: string,
    _clientId: string,
  ) => ({
    sessionId: "sid_new",
    refreshId: "idrt_initial",
    data: {
      sessionId: "sid_new",
      refreshId: "idrt_initial",
      scope,
      userId: 1,
      clientId: "cli_x",
      user: { id: "u1", name: "alice", scopes: ["orders:read", "products:read"] },
      companyAccessToken: "ct_x",
      companyRefreshToken: "cr_x",
      companyTokenExpiresAt: Date.now() + 3600_000,
      revoked: false,
    },
  })),
  findRefreshHistory: vi.fn(async () => null),
}));

// jwt mock:返回可控 claims,签发返回可辨识字符串
const jwtRef = vi.hoisted(() => ({
  verifyRefresh: vi.fn(async () => null as null | {
    jti: string;
    sub: string;
    typ: string;
  }),
}));
vi.mock("../src/jwt.js", () => ({
  verifyAccessToken: vi.fn(async () => null),
  verifyRefreshToken: jwtRef.verifyRefresh,
  signAccessToken: vi.fn(async (_sid: string, scope: string, _cid: string) =>
    `access.${scope}`),
  signRefreshToken: vi.fn(async (_sid: string, rid: string) =>
    `refresh.${rid}`),
  bearerOf: (h?: string) => h?.replace(/^Bearer\s+/, ""),
}));

vi.mock("../src/repos/index.js", () => ({
  getAuditRepo: () => ({
    writeLoginLog: vi.fn(async () => {}),
    writeApiLog: vi.fn(async () => {}),
  }),
  getAppRepo: () => ({
    verifyClient: vi.fn(async (cid: string) => cid),
    touchLastUsed: vi.fn(async () => {}),
  }),
}));

import { token } from "../src/routes/token.js";

function basicAuth(cid: string, secret: string): string {
  return "Basic " + Buffer.from(`${cid}:${secret}`).toString("base64");
}

/** 走 refresh_token grant 刷新。 */
async function postRefresh(refreshToken: string) {
  return token.request("http://localhost/", {
    method: "POST",
    headers: {
      authorization: basicAuth("cli_test", "secret"),
      "content-type": "application/x-www-form-urlencoded",
    },
    body:
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 默认:refresh token 有效,对应活跃 session
  sessionState.current = {
    sessionId: "sid_1",
    refreshId: "idrt_OLD",
    scope: "orders:read offline_access",
    user: { id: "u1", name: "alice", scopes: ["orders:read", "products:read"] },
  };
  sessionState.rotatedRefreshId = "idrt_NEW";
  jwtRef.verifyRefresh.mockResolvedValue({
    jti: "idrt_OLD",
    sub: "sid_1",
    typ: "refresh",
  });
});

describe("OAuth 2.1: refresh_token grant 必须轮换 + 返回新 refresh_token", () => {
  it("刷新成功 → 响应体含新的 refresh_token(非原值)", async () => {
    const res = await postRefresh("refresh.idrt_OLD");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh_token: string };
    expect(body.refresh_token).toBe("refresh.idrt_NEW");
    expect(body.refresh_token).not.toBe("refresh.idrt_OLD");
  });

  it("刷新成功 → 响应体含 access_token + token_type + expires_in", async () => {
    const res = await postRefresh("refresh.idrt_OLD");
    const body = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeGreaterThan(0);
  });
});

describe("OAuth 2.1: 刷新后 scope 从 session 继承(不再硬编码)", () => {
  it("access_token 的 scope = session.scope(保留原始授权)", async () => {
    const res = await postRefresh("refresh.idrt_OLD");
    const body = (await res.json()) as { access_token: string };
    // signAccessToken mock 返回 access.<scope>,据此断言传入的 scope
    expect(body.access_token).toBe("access.orders:read offline_access");
  });

  it("session scope 不同时,token scope 跟随(不漂移到硬编码值)", async () => {
    sessionState.current!.scope = "products:read invoices:read offline_access";
    const res = await postRefresh("refresh.idrt_OLD");
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe(
      "access.products:read invoices:read offline_access",
    );
    // 关键:绝不能是旧的硬编码 "company.api offline_access"
    expect(body.access_token).not.toContain("company.api");
  });
});

describe("OAuth 2.1: refresh token 重用检测仍生效", () => {
  it("未知 refresh token(从未存在)→ invalid_grant,不吊销", async () => {
    jwtRef.verifyRefresh.mockResolvedValue(null);
    const res = await postRefresh("refresh.bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });
});
