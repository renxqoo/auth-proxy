import {
  SignJWT,
  jwtVerify,
  createLocalJWKSet,
  exportJWK,
  importSPKI,
  importPKCS8,
} from "jose";
import { config } from "./config.js";
import { getSigningKeyRepo } from "./repos/index.js";

/**
 * 中间层 JWT(RS256)—— 签发给 CLI 的 token。
 *
 * - 私钥从 SigningKeyRepo(PG signing_keys 表)取,签发时 kid 进 header
 * - 校验用本地 JWKS(从 repo 拉所有未 retired 公钥)
 * - sub = sessionId;company_token 不进 JWT,只靠 sub 反查 sessionStore
 *
 * 密钥轮转:新增 active + 旧标 retired;校验时旧公钥仍可用直到 retired。
 */

export interface AccessClaims {
  sub: string; // sessionId
  scope: string;
  aud: string; // 资源服务器标识(RFC 9068 §3)
  client_id: string; // 请求该 token 的 client(RFC 9068 §3,审计/细粒度校验用)
  typ: "access";
}

export interface RefreshClaims {
  sub: string; // sessionId
  jti: string; // refreshId(与 sessionStore 的 refreshId 对应)
  typ: "refresh";
}

// JWKS 缓存:首次校验时构建,定期刷新(轮转后新公钥生效)
let jwksCache: {
  jwks: ReturnType<typeof createLocalJWKSet>;
  expiresAt: number;
} | null = null;
const JWKS_TTL_MS = 60_000;

async function getVerifier() {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) {
    return jwksCache.jwks;
  }
  const verifiers = await getSigningKeyRepo().listVerifiers();
  // 各公钥互相独立,可并行转换
  const keys = await Promise.all(
    verifiers.map(async (v) => {
      const keyLike = await exportJWK(await importSPKI(v.publicPem, "RS256"));
      Object.assign(keyLike, { kid: v.kid, use: "sig", alg: "RS256" });
      return keyLike;
    }),
  );
  const jwks = createLocalJWKSet({ keys });
  jwksCache = { jwks, expiresAt: now + JWKS_TTL_MS };
  return jwks;
}

export async function signAccessToken(
  sessionId: string,
  scope: string,
  clientId: string,
  ttlSec?: number,
): Promise<string> {
  const key = await getSigningKeyRepo().getActive();
  const privateKey = await importPKCS8(key.privatePem, "RS256");
  return new SignJWT({ scope, typ: "access", client_id: clientId })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setSubject(sessionId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec ?? config.jwtAccessTtlSec}s`)
    .sign(privateKey);
}

export async function signRefreshToken(
  sessionId: string,
  refreshId: string,
): Promise<string> {
  const key = await getSigningKeyRepo().getActive();
  const privateKey = await importPKCS8(key.privatePem, "RS256");
  return new SignJWT({ jti: refreshId, typ: "refresh" })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(config.jwtIssuer)
    .setSubject(sessionId)
    .setIssuedAt()
    .setExpirationTime(`${config.jwtRefreshTtlSec}s`)
    .sign(privateKey);
}

/** 校验 access token;返回 claims 或 null。无效/过期/类型不符都返回 null。 */
export async function verifyAccessToken(
  token: string | undefined,
): Promise<AccessClaims | null> {
  if (!token) return null;
  try {
    const verifier = await getVerifier();
    const { payload } = await jwtVerify(token, verifier, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    if (payload.typ !== "access") return null;
    return {
      sub: payload.sub ?? "",
      scope: (payload.scope as string | undefined) ?? "",
      aud: (payload.aud as string | undefined) ?? "",
      client_id: (payload.client_id as string | undefined) ?? "",
      typ: "access",
    };
  } catch {
    return null; // 过期/签名错/格式错都收敛成 null
  }
}

/** 校验 refresh token;返回 claims 或 null。 */
export async function verifyRefreshToken(
  token: string,
): Promise<RefreshClaims | null> {
  try {
    const verifier = await getVerifier();
    const { payload } = await jwtVerify(token, verifier, {
      issuer: config.jwtIssuer,
    });
    if (payload.typ !== "refresh") return null;
    return {
      sub: payload.sub ?? "",
      jti: (payload.jti as string | undefined) ?? "",
      typ: "refresh",
    };
  } catch {
    return null;
  }
}

export function bearerOf(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  return m?.[1];
}
