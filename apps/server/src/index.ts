import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { assertProductionConfig } from "./config.js";
import { closeInfra, getDb, getRedis } from "./infra.js";
import { maskUrl, safeError } from "./config.js";
import { deviceAuthorization } from "./routes/deviceAuthorization.js";
import { verify } from "./routes/verify.js";
import { token } from "./routes/token.js";
import { userInfo } from "./routes/userInfo.js";
import { gateway } from "./routes/gateway.js";
import { jwks } from "./routes/jwks.js";
import { revoke } from "./routes/revoke.js";
import { adminWeb } from "./routes/adminWeb.js";
import { register } from "./routes/register.js";
import { metadata } from "./routes/metadata.js";

/**
 * @auth-proxy/server —— 鉴权中间层。
 *
 * 职责:
 * 1. OAuth 2.0 设备授权服务器(面向 CLI):/device_authorization /token /user_info
 * 2. 账号密码登录页(面向浏览器):/verify
 * 3. API Gateway(面向 CLI):/proxy/*
 *
 * 持久化:Postgres(权威)+ Redis(缓存/临时数据)。
 * company_token 永不离开本服务;CLI 只持有本服务签发的 JWT。
 */

const app = new Hono();
app.use(logger());

// OAuth 设备授权
app.route("/device_authorization", deviceAuthorization);
app.route("/token", token);
app.route("/user_info", userInfo);
app.route("/revoke", revoke);

// JWKS(公钥集合,供外部校验 JWT)
app.route("/.well-known/jwks.json", jwks);

// RFC 8414:OAuth 2.0 Authorization Server Metadata
app.route("/.well-known/oauth-authorization-server", metadata);

// admin 后台 API(session cookie 鉴权,必须登录后台)
app.route("/admin/web", adminWeb);

// 动态客户端注册(CLI 用注册令牌换 clientId/secret)
app.route("/register", register);

// 浏览器登录页
app.route("/verify", verify);

// API Gateway(业务请求透传)
app.route("/proxy", gateway);

// 健康检查
app.get("/", (c) => c.json({ service: "server", ok: true }));

// 全局错误处理:服务端日志只记 message(不泄露堆栈),客户端只收通用信息
app.onError((err, c) => {
  safeError("[server] unhandled error:", err);
  return c.json(
    { error: "internal_error", error_description: "unexpected server error" },
    500,
  );
});

// 启动前校验 PG/Redis 可用(无 docker 时直接退出,提示明确)
async function checkInfra(): Promise<void> {
  // 生产配置校验:默认 session secret 等不安全默认值必须拒绝启动
  assertProductionConfig();
  const redis = getRedis();
  const pong = await redis.ping();
  if (pong !== "PONG") throw new Error(`redis ping returned ${pong}`);
  // PG 简单连通性(查 apps 表是否存在)
  await getDb().query.apps.findFirst();
}

checkInfra()
  .then(() => {
    // TLS:启用时用 node:https 的 createServer + 证书;否则默认 HTTP
    if (config.tls.enabled) {
      if (!config.tls.certPath || !config.tls.keyPath) {
        throw new Error("TLS_ENABLED=1 but TLS_CERT_PATH/TLS_KEY_PATH not set");
      }
      serve(
        {
          fetch: app.fetch,
          port: config.port,
          createServer: createHttpsServer,
          serverOptions: {
            key: readFileSync(config.tls.keyPath),
            cert: readFileSync(config.tls.certPath),
          },
        },
        (info) => {
          console.log(`[server] listening on https://localhost:${info.port}`);
          console.log(`[server] TLS: on`);
        },
      );
    } else {
      serve({ fetch: app.fetch, port: config.port }, (info) => {
        console.log(`[server] listening on http://localhost:${info.port}`);
      });
    }
    console.log(`[server] company api base: ${config.companyApiBase}`);
    console.log(`[server] db: ${maskUrl(config.databaseUrl)}`);
    console.log(`[server] redis: ${maskUrl(config.redisUrl)}`);
  })
  .catch(async (e) => {
    safeError("[server] startup check failed:", e);
    console.error(
      "[server] ensure Postgres + Redis are running and DATABASE_URL/REDIS_URL are set.",
    );
    await closeInfra();
    process.exit(1);
  });

// 优雅关闭
process.on("SIGINT", async () => {
  await closeInfra();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeInfra();
  process.exit(0);
});
