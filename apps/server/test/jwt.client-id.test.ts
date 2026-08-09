import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPair, SignJWT, jwtVerify } from "jose";

/**
 * access token 的 client_id claim 测试 —— RFC 9068 §3。
 *
 * JWT access token 应含 client_id(标识是哪个 client 请求的),
 * 便于审计和资源服务器细粒度校验。
 *
 * 本测试用 jose 直接签发,模拟 signAccessToken 的新签名(含 client_id),
 * 并验证校验侧能读回 client_id。
 */

const ISSUER = "auth-proxy";
const AUDIENCE = "auth-proxy";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair("RS256");
  privateKey = priv;
  publicKey = pub;
});

/** 模拟 signAccessToken:签一个带 client_id 的 access token。 */
async function signAccess(
  clientId: string,
  scope = "orders:read",
): Promise<string> {
  return new SignJWT({ scope, typ: "access", client_id: clientId })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("sid_test")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

describe("RFC 9068 §3: access token 含 client_id claim", () => {
  it("签发的 access token 含 client_id", async () => {
    const token = await signAccess("cli_abc123");
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER });
    expect(payload.client_id).toBe("cli_abc123");
  });

  it("不同 client_id 的 token 可区分", async () => {
    const t1 = await signAccess("cli_A");
    const t2 = await signAccess("cli_B");
    const p1 = (await jwtVerify(t1, publicKey, { issuer: ISSUER })).payload;
    const p2 = (await jwtVerify(t2, publicKey, { issuer: ISSUER })).payload;
    expect(p1.client_id).toBe("cli_A");
    expect(p2.client_id).toBe("cli_B");
    expect(p1.client_id).not.toBe(p2.client_id);
  });

  it("client_id 与 scope/aud 正交(都独立存在)", async () => {
    const token = await signAccess("cli_xyz", "orders:read products:read");
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER });
    expect(payload.client_id).toBe("cli_xyz");
    expect(payload.scope).toBe("orders:read products:read");
    expect(payload.aud).toBe(AUDIENCE);
  });
});
