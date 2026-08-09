import { describe, it, expect, beforeEach } from "vitest";
import {
  generateKeyPair,
  SignJWT,
  jwtVerify,
} from "jose";

/**
 * access token 的 audience(aud)合规测试 —— RFC 9068 §3。
 *
 * 要求:JWT access token 必须含 aud,标识资源服务器;校验方必须校验 aud,
 * 防止 token confusion(为 A 签发的 token 被拿到 B 使用)。
 *
 * 本测试直接用 jose 签发/校验,模拟"配置的 audience"与"token 里的 aud"的
 * 匹配/不匹配场景,验证校验逻辑正确拒绝 aud 不符的 token。
 */

// 与 config 默认一致;模拟 verifyAccessToken 的 audience 校验参数
const ISSUER = "auth-proxy";
const AUDIENCE = "auth-proxy";

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () => {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair("RS256");
  privateKey = priv;
  publicKey = pub;
});

/** 模拟 signAccessToken:签一个带 aud 的 access token。 */
async function signAccess(aud: string, scope = "orders:read"): Promise<string> {
  return new SignJWT({ scope, typ: "access" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(ISSUER)
    .setAudience(aud)
    .setSubject("sid_test")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

/** 模拟 verifyAccessToken 的校验:要求 issuer + audience 都匹配。 */
async function verifyAccess(
  token: string,
  expectedAud: string,
): Promise<unknown | null> {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: expectedAud,
    });
    if (payload.typ !== "access") return null;
    return payload;
  } catch {
    return null;
  }
}

describe("RFC 9068: access token 必须含且校验 audience (aud)", () => {
  it("签发的 access token 含 aud claim", async () => {
    const token = await signAccess(AUDIENCE);
    const { payload } = await jwtVerify(token, publicKey, { issuer: ISSUER });
    expect(payload.aud).toBe(AUDIENCE);
  });

  it("aud 匹配 → 校验通过", async () => {
    const token = await signAccess(AUDIENCE);
    const claims = await verifyAccess(token, AUDIENCE);
    expect(claims).not.toBeNull();
  });

  it("aud 不匹配(token confusion)→ 校验拒绝", async () => {
    // 为资源 A 签发,却拿去给期望 B 的校验方
    const token = await signAccess("resource-A");
    const claims = await verifyAccess(token, "resource-B");
    expect(claims).toBeNull();
  });

  it("无 aud 的 token → 校验拒绝(audience 必填)", async () => {
    // 故意不 setAudience,模拟旧实现
    const token = await new SignJWT({ scope: "orders:read", typ: "access" })
      .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
      .setIssuer(ISSUER)
      .setSubject("sid_test")
      .setIssuedAt()
      .setExpirationTime("60s")
      .sign(privateKey);
    const claims = await verifyAccess(token, AUDIENCE);
    expect(claims).toBeNull();
  });

  it("scope claim 仍正常透传(与 aud 校验正交)", async () => {
    const token = await signAccess(AUDIENCE, "orders:read products:read");
    const claims = (await verifyAccess(token, AUDIENCE)) as {
      scope: string;
    };
    expect(claims.scope).toBe("orders:read products:read");
  });
});
