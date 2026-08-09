import {
  pgTable,
  serial,
  bigserial,
  text,
  boolean,
  timestamp,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * @auth-proxy/db —— Postgres schema(drizzle)。
 *
 * 表清单:
 *   signing_keys  JWT RS256 密钥(轮转)
 *   apps          OAuth client 凭据(替换 env 写死)
 *   users         可登录用户(登录成功时 upsert)
 *   sessions      会话权威源(company_token 持有处)
 *   login_logs    登录审计
 *   api_logs      gateway 调用审计
 *
 * 注:device_code 是 10 分钟临时状态,放 Redis(见 server/deviceCodeRepo),不在此处。
 */

// ---------- signing_keys ----------
export const signingKeyStatus = pgEnum("signing_key_status", [
  "active",
  "retired",
]);

export const signingKeys = pgTable("signing_keys", {
  id: serial("id").primaryKey(),
  kid: text("kid").notNull().unique(),
  alg: text("alg").notNull().default("RS256"),
  publicPem: text("public_pem").notNull(),
  privatePem: text("private_pem").notNull(),
  status: signingKeyStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

// ---------- apps ----------
export const apps = pgTable("apps", {
  id: serial("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // admin 后台用:吊销标记 + 注册审计
  revoked: boolean("revoked").notNull().default(false),
  createdFromTokenId: integer("created_from_token_id"), // 注册自哪个令牌
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }), // 最后使用(登录时更新)
  // 该 client 允许请求的 scope 子集。空 [] = 允许全部已定义 scope(默认,向后兼容);
  // admin 裁剪后只允许列出的。运行时 device_authorization 校验:请求的 scope 必须 ∈ 此集合。
  allowedScopes: text("allowed_scopes").array().notNull().default([]),
});

// ---------- scopes(全局 scope 定义) ----------
// OAuth 标准三层 scope 管理之层 1:全局定义。取代环境变量白名单,可经 admin 后台增删。
// isSystem=true 的 scope 是中间层自身管理的(offline_access/company.api),
// 不参与用户权限收窄(narrowScope 豁免它们)。
export const scopes = pgTable("scopes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(), // "orders:read"
  description: text("description"), // "读订单列表/详情"
  isSystem: boolean("is_system").notNull().default(false), // 系统 scope,豁免用户收窄
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- route_policies(网关路径→scope 策略) ----------
// 企业级纵深防御之层 4:gateway 转发前校验 token.scope 是否覆盖该路径所需 scope。
// 默认拒绝:没匹配到任何策略的路径 → gateway 直接 403(强制所有路径显式配策略)。
// pattern 用简单通配符:/api/orders* 匹配 /api/orders 和 /api/orders/123。
// scope 为 null 表示"只需有效 token,不要业务 scope"(如 /me、/api/profile 自身信息)。
// method 为 null 表示匹配所有 HTTP 方法。
export const routePolicies = pgTable("route_policies", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull(), // "/api/orders*"(去掉 /proxy 前缀后的上游路径)
  scope: text("scope"), // "orders:read";null = 只验登录
  method: text("method"), // "GET"/"POST"/null(=null 匹配所有方法)
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- users ----------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  companyUserId: text("company_user_id").notNull().unique(),
  name: text("name").notNull(),
  // scopes 缓存自公司应用返回;权威仍以公司应用为准
  scopes: text("scopes").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

// ---------- sessions(权威) ----------
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(), // sid_xxx(JWT sub)
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  clientId: text("client_id").notNull(), // 登录时用的 OAuth client(client 吊销时级联)
  refreshId: text("refresh_id").notNull(), // idrt_xxx(当前有效 refresh jti)
  companyAccessToken: text("company_access_token").notNull(),
  companyRefreshToken: text("company_refresh_token").notNull(),
  companyTokenExpiresAt: timestamp("company_token_expires_at", {
    withTimezone: true,
  }).notNull(),
  scope: text("scope").notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- login_logs(审计) ----------
export const loginLogs = pgTable("login_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id"),
  userCode: text("user_code").notNull(),
  username: text("username").notNull(),
  clientId: text("client_id").notNull(),
  success: boolean("success").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- api_logs(审计) ----------
export const apiLogs = pgTable("api_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sessionId: text("session_id").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------- refresh_token_history(重用检测) ----------
// 记录每次 refresh 轮换:旧 jti 入此表。
// 检测重用时查此表;30s 宽限窗口内允许旧 jti 再用(容忍并发),超窗口视为泄露。
export const refreshTokenHistory = pgTable(
  "refresh_token_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull(), // 关联 session(即使被吊销也保留)
    refreshJti: text("refresh_jti").notNull(), // 曾用过的 refresh jti
    rotatedAt: timestamp("rotated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_history_jti_unique").on(t.refreshJti),
    index("refresh_history_session").on(t.sessionId),
  ],
);

// ---------- registration_tokens(动态客户端注册) ----------
// 注册令牌:管理员生成,限时多次;团队成员用它调 /register 换取独立 clientId/secret。
export const registrationTokens = pgTable("registration_tokens", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(), // rt_ + 随机
  name: text("name").notNull(), // 备注(如"研发组")
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revoked: boolean("revoked").notNull().default(false), // 管理员手动吊销
  // 创建时选:一次性(singleUse=true,用完即作废)或多次(false,到期前不限次)
  singleUse: boolean("single_use").notNull().default(true),
  used: boolean("used").notNull().default(false), // 一次性令牌用过后置 true(区别于 revoked)
  // 使用计数(/register 成功时 +1)
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// ---------- admins(后台管理员) ----------
export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(), // scrypt hash
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// 导出类型(drizzle 自动推导,供 repo 使用)
export type SigningKey = typeof signingKeys.$inferSelect;
export type NewSigningKey = typeof signingKeys.$inferInsert;
export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type Scope = typeof scopes.$inferSelect;
export type NewScope = typeof scopes.$inferInsert;
export type RoutePolicy = typeof routePolicies.$inferSelect;
export type NewRoutePolicy = typeof routePolicies.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type LoginLog = typeof loginLogs.$inferSelect;
export type NewLoginLog = typeof loginLogs.$inferInsert;
export type ApiLog = typeof apiLogs.$inferSelect;
export type NewApiLog = typeof apiLogs.$inferInsert;
export type RefreshTokenHistory = typeof refreshTokenHistory.$inferSelect;
export type NewRefreshTokenHistory = typeof refreshTokenHistory.$inferInsert;
export type RegistrationToken = typeof registrationTokens.$inferSelect;
export type NewRegistrationToken = typeof registrationTokens.$inferInsert;
export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;
