import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { getScopeRepo } from "../repos/index.js";

/**
 * GET /.well-known/oauth-authorization-server —— RFC 8414 OAuth 2.0 Metadata。
 *
 * 供客户端自动发现:issuer、各端点 URL、支持的 grant_type / response_type /
 * PKCE method / scope 等。OAuth 2.1 要求此端点存在(推荐)。
 *
 * issuer 用 config.publicBaseUrl(可信,生产必设)。未设时回退 Host 头(仅本地)。
 */

function issuerBase(c: Context): string {
  if (config.publicBaseUrl) {
    return config.publicBaseUrl.replace(/\/+$/, "");
  }
  const host = c.req.header("host") ?? `localhost:${config.port}`;
  return `http://${host}`;
}

export const metadata = new Hono();

metadata.get("/", async (c) => {
  const base = issuerBase(c);
  // 从 DB 读 scope 定义;表为空时回退环境变量
  const { names } = await getScopeRepo().getSets();
  const scopesSupported =
    names.size > 0
      ? [...names]
      : config.allowedScopes.split(/\s+/).filter(Boolean);

  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    revocation_endpoint: `${base}/revoke`,
    userinfo_endpoint: `${base}/user_info`,
    device_authorization_endpoint: `${base}/device_authorization`,
    grant_types_supported: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "authorization_code",
      "refresh_token",
    ],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    // 公开 client(PKCE,无 secret)+ 机密 client(Basic auth)
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "none",
    ],
    scopes_supported: scopesSupported,
    // RFC 8414 可选字段(声明能力)
    token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    // 暂不支持的明确不声明(introspection 等)
  });
});
