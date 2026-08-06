import { Hono } from "hono";
import { config } from "../config.js";
import { findSessionBySessionId } from "../sessionStore.js";
import { getRefresher, CompanyAuthError } from "../companyTokenRefresher.js";
import { bearerOf, verifyAccessToken } from "../jwt.js";
import { oauthError } from "../oauthHelpers.js";
import { enforceRateLimit } from "../middleware/rateLimit.js";
import { getAuditRepo } from "../repos/index.js";

/**
 * /proxy/* —— API Gateway。CLI 拿业务数据走这里。
 *
 * 流程:
 * 1. 校验中间层 JWT → sessionId
 * 2. 查 session → 取 company_token(必要时单飞刷新)
 * 3. 用 company_token 转发到公司应用,原样透传响应
 *
 * 透传原则(对齐 AGENTS.md "忠实转写"):
 * - 公司应用的 4xx/5xx 原样返回状态码 + body,不包装、不猜测。
 * - method/body/查询串原样转发。
 */
export const gateway = new Hono();

// 通配 /proxy/* ;Hono v4 用 * 抓剩余路径
gateway.all("/*", async (c) => {
  // 1. JWT 校验
  const claims = await verifyAccessToken(
    bearerOf(c.req.header("Authorization")),
  );
  if (!claims) {
    return oauthError(c, "invalid_grant", "missing or invalid access token");
  }
  const session = await findSessionBySessionId(claims.sub);
  if (!session) {
    return oauthError(c, "invalid_grant", "session not found; please re-login");
  }

  // 按 session 限流(防滥用 gateway)
  const rl = await enforceRateLimit(`proxy:${claims.sub}`, {
    windowMs: config.rateLimit.proxyWindowMs,
    limit: config.rateLimit.proxyMax,
    prefix: "rl:proxy",
  });
  if (!rl.allowed) {
    return c.json(
      { error: "too_many_requests", error_description: "rate limit exceeded" },
      429,
      { "Retry-After": String(rl.retryAfterSec) },
    );
  }

  // 2. 取(必要时刷新)company access token
  let companyAccessToken: string;
  try {
    companyAccessToken = await getRefresher().ensureFresh(claims.sub);
  } catch (e) {
    if (e instanceof CompanyAuthError) {
      // company refresh 失效 → 用户需重新登录
      return oauthError(
        c,
        "invalid_grant",
        "company session expired; please re-login via `auth login`",
      );
    }
    throw e; // 其它异常交给全局错误处理
  }

  // 3. 计算转发目标 URL:去掉 /proxy 前缀
  const url = new URL(c.req.url);
  const upstreamPath = url.pathname.replace(/^\/proxy/, "") + url.search;
  const target = `${config.companyApiBase}${upstreamPath}`;

  // 4. 透传请求(方法/headers/body)
  const upstreamHeaders = new Headers();
  // 仅透传安全的头;Authorization 用 company token 覆盖
  const passthrough = ["content-type", "accept", "user-agent"];
  for (const h of passthrough) {
    const v = c.req.header(h);
    if (v) upstreamHeaders.set(h, v);
  }
  upstreamHeaders.set("Authorization", `Bearer ${companyAccessToken}`);

  const startedAt = Date.now();
  const upstreamRes = await fetch(target, {
    method: c.req.method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(c.req.method)
      ? undefined
      : await c.req.text(),
  });
  const durationMs = Date.now() - startedAt;

  // 异步写审计;失败仅记日志,不阻断响应
  void getAuditRepo().writeApiLog({
    sessionId: claims.sub,
    method: c.req.method,
    path: upstreamPath,
    status: upstreamRes.status,
    durationMs,
  });

  // 5. 选择性透传响应头
  //
  // 安全:原实现用黑名单(只剥 hop-by-hop),会放行上游的 set-cookie / location /
  // server / x-powered-by 等。这些对 CLI 无用且有害:
  //   - set-cookie:泄露公司应用会话(信息泄露)
  //   - location:可能诱导 CLI 跟随非预期跳转(开放重定向)
  //   - server/x-powered-by:暴露上游技术栈(指纹)
  // 改用白名单:只透传 CLI 真正需要的业务头,body 仍原样透传(忠实转写契约不变)。
  const respHeaders = new Headers();
  const SAFE_RESPONSE_HEADERS = new Set([
    "content-type",
    "content-length",
    "content-encoding",
    "content-language",
    "etag",
    "last-modified",
    "cache-control",
    "expires",
    "date",
  ]);
  upstreamRes.headers.forEach((v, k) => {
    if (SAFE_RESPONSE_HEADERS.has(k.toLowerCase())) {
      respHeaders.set(k, v);
    }
  });
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: respHeaders,
  });
});
