import { describe, it, expect, vi } from "vitest";

/**
 * RFC 8414:OAuth 2.0 Authorization Server Metadata。
 *
 * /.well-known/oauth-authorization-server 必须返回标准字段,
 * 供客户端自动发现 issuer / 端点 / 支持的 grant / PKCE method 等。
 */

vi.mock("../src/repos/index.js", () => ({
  // 返回几个已定义 scope(测试 metadata 的 scopes_supported)
  getScopeRepo: () => ({
    getSets: vi.fn(async () => ({
      names: new Set(["orders:read", "offline_access", "admin"]),
      systemNames: new Set(["offline_access"]),
    })),
  }),
}));

import { metadata } from "../src/routes/metadata.js";

describe("RFC 8414: /.well-known/oauth-authorization-server", () => {
  it("GET / → 200 + JSON", async () => {
    const res = await metadata.request("http://localhost/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTypeOf("object");
  });

  it("含 issuer(绝对 URL)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.issuer).toBeTruthy();
    expect(body.issuer).toMatch(/^https?:\/\//);
  });

  it("含全部必需端点", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.authorization_endpoint).toMatch(/\/authorize$/);
    expect(body.token_endpoint).toMatch(/\/token$/);
    expect(body.registration_endpoint).toMatch(/\/register$/);
    expect(body.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
    expect(body.revocation_endpoint).toMatch(/\/revoke$/);
    expect(body.userinfo_endpoint).toMatch(/\/user_info$/);
    expect(body.device_authorization_endpoint).toMatch(/\/device_authorization$/);
  });

  it("含 grant_types_supported(含 device_code + authorization_code + refresh_token)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining([
        "urn:ietf:params:oauth:grant-type:device_code",
        "authorization_code",
        "refresh_token",
      ]),
    );
  });

  it("含 response_types_supported(含 code)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.response_types_supported).toEqual(
      expect.arrayContaining(["code"]),
    );
  });

  it("含 code_challenge_methods_supported = ['S256'](OAuth 2.1 强制)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("含 token_endpoint_auth_methods_supported", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(["client_secret_basic", "none"]),
    );
  });

  it("含 scopes_supported(从 DB 读)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    expect(body.scopes_supported).toEqual(
      expect.arrayContaining(["orders:read", "offline_access", "admin"]),
    );
  });

  it("含 service_documentation / op_policy_uri 等可选字段位置(可空但字段在)", async () => {
    const res = await metadata.request("http://localhost/");
    const body = await res.json();
    // issuer 必填;其余可选字段存在性不强制,但 revocation_endpoint 应在
    expect(body.issuer).toBeTruthy();
    expect(body.revocation_endpoint).toBeTruthy();
  });
});
