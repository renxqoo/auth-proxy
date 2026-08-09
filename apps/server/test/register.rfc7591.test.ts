import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * RFC 7591 动态客户端注册测试。
 *
 * 验证 /register 对齐 RFC 7591:
 * - 请求体含 client_metadata(client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method)
 * - 保留 registrationToken 准入
 * - 响应 snake_case:client_id, client_secret, client_id_issued_at, client_secret_expires_at(=0), + 回显 metadata
 * - 错误用 invalid_client_metadata(RFC 7591 §3.2.1)
 */

const redisMock = {
  eval: vi.fn(async () => [1, 60]),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  multi: () => ({ set: () => {}, exec: async () => [] }),
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisMock }));

// tokenRepo mock:consumeSingleUse 返回 tokenId(成功)或 null(失败)
const tokenRepoRef = vi.hoisted(() => ({
  consumeResult: 1 as number | null,
}));
vi.mock("../src/repos/index.js", () => ({
  getTokenRepo: () => ({
    consumeSingleUse: vi.fn(async () => tokenRepoRef.consumeResult),
  }),
  getAppRepo: () => ({
    create: vi.fn(async () => {}),
  }),
}));

import { register } from "../src/routes/register.js";

beforeEach(() => {
  vi.clearAllMocks();
  tokenRepoRef.consumeResult = 1; // 默认注册令牌有效
});

async function postRegister(body: unknown, ip = "1.1.1.1") {
  return register.request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("RFC 7591: POST /register 标准 client_metadata", () => {
  it("带 registrationToken + client_metadata → 201 + snake_case 响应", async () => {
    const res = await postRegister({
      registrationToken: "rt_valid",
      client_name: "my-web-app",
      redirect_uris: ["https://app.example.com/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "orders:read offline_access",
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // snake_case 必需字段
    expect(body.client_id).toMatch(/^cli_/);
    expect(body.client_secret).toBeTruthy();
    expect(body.client_id_issued_at).toBeGreaterThan(0);
    expect(body.client_secret_expires_at).toBe(0); // 0 = 永不过期(RFC 7591)
    // 回显 metadata
    expect(body.client_name).toBe("my-web-app");
    expect(body.redirect_uris).toEqual(["https://app.example.com/callback"]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.scope).toBe("orders:read offline_access");
    expect(body.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("缺 registrationToken → 401(准入失败)", async () => {
    const res = await postRegister({
      client_name: "no-token-app",
    });
    expect(res.status).toBe(401);
  });

  it("无效 registrationToken → 401", async () => {
    tokenRepoRef.consumeResult = null;
    const res = await postRegister({
      registrationToken: "rt_invalid",
      client_name: "test",
    });
    expect(res.status).toBe(401);
  });

  it("缺 client_name → 400 invalid_client_metadata", async () => {
    const res = await postRegister({
      registrationToken: "rt_valid",
      redirect_uris: ["https://app.example.com/cb"],
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_client_metadata");
  });

  it("redirect_uris 非数组 → 400 invalid_client_metadata", async () => {
    const res = await postRegister({
      registrationToken: "rt_valid",
      client_name: "test",
      redirect_uris: "not-an-array",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });

  it("redirect_uris 含非 URL → 400 invalid_client_metadata", async () => {
    const res = await postRegister({
      registrationToken: "rt_valid",
      client_name: "test",
      redirect_uris: ["not-a-url"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });
});
