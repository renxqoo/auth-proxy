import { Hono } from "hono";
import { config } from "../config.js";
import { createAuthCode } from "../authCodeStore.js";
import { oauthError } from "../oauthHelpers.js";
import { getAppRepo, getScopeRepo } from "../repos/index.js";

/**
 * GET /authorize —— RFC 6749 §4.1.1 授权端点 + PKCE(RFC 7636)。
 *
 * OAuth 2.1:authorization_code 是核心交互流程。PKCE 强制 S256。
 *
 * 参数(query):
 *   response_type=code(必须)
 *   client_id(必须,须是已注册的 client)
 *   redirect_uri(必须,须 ∈ client 注册的 redirect_uris)
 *   scope(可选,三层校验)
 *   code_challenge(PKCE 必须,base64url(SHA256(code_verifier)))
 *   code_challenge_method=S256(必须,OAuth 2.1 禁止 plain)
 *   state(可选,原样回显防 CSRF)
 *
 * 成功 → 302 重定向到 redirect_uri?code=xxx&state=xxx
 * 失败 → 400 + OAuth 错误码(redirect_uri 无效时不重定向,直接返 400)
 */
export const authorize = new Hono();

authorize.get("/", async (c) => {
  const responseType = c.req.query("response_type") ?? "";
  const clientId = c.req.query("client_id") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const scope = c.req.query("scope") ?? "";
  const codeChallenge = c.req.query("code_challenge") ?? "";
  const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";
  const state = c.req.query("state") ?? "";

  // 1. response_type=code
  if (responseType !== "code") {
    return oauthError(c, "unsupported_response_type", "response_type must be 'code'");
  }

  // 2. client_id 存在
  if (!clientId) {
    return oauthError(c, "invalid_client", "client_id required");
  }
  const app = await getAppRepo().findByClientId(clientId);
  if (!app) {
    return oauthError(c, "invalid_client", "unknown client_id");
  }

  // 3. redirect_uri ∈ client 注册的 redirect_uris(RFC 6749 §3.1.2.3)
  if (!redirectUri) {
    return oauthError(c, "invalid_request", "redirect_uri required");
  }
  if (app.redirectUris.length === 0 || !app.redirectUris.includes(redirectUri)) {
    // redirect_uri 不匹配:不重定向(防开放重定向),直接报错
    return oauthError(c, "invalid_request", "redirect_uri not registered for this client");
  }

  // 4. PKCE 强制 S256(OAuth 2.1)
  if (!codeChallenge) {
    return oauthError(c, "invalid_request", "code_challenge required (PKCE mandatory)");
  }
  if (codeChallengeMethod !== "S256") {
    return oauthError(c, "invalid_request", "code_challenge_method must be S256");
  }

  // 5. scope 三层校验(层 1 全局 + 层 3 client 绑定),同 deviceAuthorization
  const requestedScopes = scope.split(/\s+/).filter((s) => s.length > 0);
  const { names: globalNames, systemNames } = await getScopeRepo().getSets();
  const globalAllowed =
    globalNames.size > 0
      ? globalNames
      : new Set(config.allowedScopes.split(/\s+/).filter(Boolean));
  const systemSet =
    systemNames.size > 0
      ? systemNames
      : new Set(config.systemScopes.split(/\s+/).filter(Boolean));
  const clientAllowed =
    app.allowedScopes.length > 0 ? new Set(app.allowedScopes) : null;
  for (const s of requestedScopes) {
    if (!globalAllowed.has(s)) {
      return oauthError(c, "invalid_scope", `unknown or disallowed scope: ${s}`);
    }
    if (clientAllowed && !systemSet.has(s) && !clientAllowed.has(s)) {
      return oauthError(c, "invalid_scope", `scope ${s} not allowed for this client`);
    }
  }
  // offline_access 自动补
  const finalScopes = [...requestedScopes];
  if (!finalScopes.includes("offline_access")) finalScopes.push("offline_access");
  const finalScope = finalScopes.join(" ");

  // 6. 创建授权码
  const rec = await createAuthCode({
    clientId,
    redirectUri,
    scope: finalScope,
    codeChallenge,
  });

  // 7. 302 重定向:redirect_uri?code=xxx&state=xxx
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", rec.code);
  if (state) redirectUrl.searchParams.set("state", state);
  return c.redirect(redirectUrl.toString(), 302);
});
