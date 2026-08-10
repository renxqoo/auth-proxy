/**
 * 中间层运行时配置 —— 全部来自环境变量,开发期有默认值。
 * 真实公司应用接入时,只需改 COMPANY_API_BASE + JWT_SECRET。
 */

/**
 * 脱敏 URL 里的密码(日志安全)。
 * postgres://user:password@host:port/db → postgres://user:***@host:port/db
 * redis://:password@host:port → redis://:***@host:port
 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password || u.username) {
      return `${u.protocol}//${u.username || ""}:***@${u.host}${u.pathname}`;
    }
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // 非 URL 字符串,返回固定占位
    return "(invalid url)";
  }
}

/**
 * 生产环境日志:只在非 production 时打印详细日志。
 * production 只打印 message(不含 error 对象的堆栈/参数)。
 */
export function safeLog(message: string, ...args: unknown[]): void {
  if (process.env.NODE_ENV === "production") {
    // 生产:只打印 message + error 的 name/message(不含堆栈)
    const safe = args.map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      return a;
    });
    console.log(message, ...safe);
  } else {
    console.log(message, ...args);
  }
}

export function safeError(message: string, ...args: unknown[]): void {
  if (process.env.NODE_ENV === "production") {
    const safe = args.map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      return a;
    });
    console.error(message, ...safe);
  } else {
    console.error(message, ...args);
  }
}

function required(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * session cookie 签名密钥的默认值(开发兜底)。
 * 攻击者可能知道这个公开的默认值,从而离线伪造 admin cookie。
 * 生产环境必须设置自定义 ADMIN_SESSION_SECRET,见 assertProductionConfig。
 */
export const DEFAULT_SESSION_SECRET = "dev_session_secret_change_me";

export const config = {
  port: num("SERVER_PORT", 3000),
  // TLS:生产建议用反代终止 TLS;此处支持中间层直接跑 TLS(自签或正规证书)
  tls: {
    enabled: num("TLS_ENABLED", 0) === 1,
    certPath: required("TLS_CERT_PATH", ""),
    keyPath: required("TLS_KEY_PATH", ""),
  },
  // admin 后台 session cookie 签名密钥。部署时设强随机值。
  adminSessionSecret: required(
    "ADMIN_SESSION_SECRET",
    DEFAULT_SESSION_SECRET,
  ),
  adminSessionTtlSec: num("ADMIN_SESSION_TTL", 3600), // 1h
  // mock 公司应用基址(gateway 转发目标,companyAuth 调用)
  companyApiBase: required("COMPANY_API_BASE", "http://localhost:4000"),
  /**
   * 对外可访问的基础 URL(协议+host),用于拼 verification_uri 等返回给 CLI 的链接。
   *
   * 安全动机:若不配置,代码会回退用请求头拼 base。x-forwarded-host / Host
   * 是客户端可伪造的,攻击者可注入恶意 host,让 CLI 收到的登录链接指向钓鱼站
   * (host header injection → phishing)。生产部署必须显式设置本值为真实对外地址,
   * 这样无论请求头怎么伪造,返回的链接都固定指向可信域名。
   */
  publicBaseUrl: required("PUBLIC_BASE_URL", ""),
  // 持久化
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://localhost:5432/auth-proxy",
  ),
  redisUrl: required("REDIS_URL", "redis://localhost:6379/2"),
  // JWT 签发者(RS256;密钥从 signing_keys 表取,见 Phase C)
  jwtIssuer: required("JWT_ISSUER", "auth-proxy"),
  /**
   * access token 的 audience(RFC 9068 §3 要求 JWT access token 必须有 aud)。
   * 标识资源服务器(gateway /proxy 本身或下游公司应用)。校验时必须匹配,
   * 防止为 A 签发的 token 被拿到 B 使用(token confusion)。
   * 单一固定值适配当前单公司应用架构。
   */
  jwtAudience: required("JWT_AUDIENCE", "auth-proxy"),
  // token 生命周期(秒)
  jwtAccessTtlSec: num("JWT_ACCESS_TTL", 3600), // 1h
  jwtRefreshTtlSec: num("JWT_REFRESH_TTL", 86400 * 7), // 7d
  /**
   * 允许的 scope 白名单(空格分隔)。device_authorization 入口校验:
   * 请求的 scope 超出此集合 → invalid_scope(RFC 6749 §3.3)。
   * 注:offline_access 由入口自动补上,无需客户端显式请求,但列在白名单内可兼容。
   * company.api 是中间层聚合 scope(代表"公司应用 API 访问权",非单一公司权限),
   * 客户端(crmb)会请求它,故列入默认白名单。
   */
  allowedScopes: required(
    "ALLOWED_SCOPES",
    "company.api orders:read orders:write products:read invoices:read admin offline_access",
  ),
  /**
   * 系统 scope 集合(空格分隔)。这些 scope 是中间层自身管理的,不属于公司应用
   * 返回的用户权限(user.scopes),故在 narrowScope 收窄时不参与用户权限比对:
   *   - offline_access:中间层签发 refresh_token 所需
   *   - company.api:中间层聚合 scope(代表可经 proxy 访问公司应用)
   * 其余 scope 必须是用户实际拥有的,否则 invalid_scope。
   */
  systemScopes: required("SYSTEM_SCOPES", "offline_access company.api"),
  // device flow
  deviceCodeTtlSec: num("DEVICE_CODE_TTL", 600), // 10min
  devicePollIntervalSec: num("DEVICE_POLL_INTERVAL", 5),
  // authorization_code 流程(RFC 6749 §4.1 + PKCE RFC 7636)
  authCodeTtlSec: num("AUTH_CODE_TTL", 120), // 授权码有效期(秒);OAuth BCP 建议短
  // admin 签发 agent token 的最大 TTL(秒)。防永久 token。
  agentTokenMaxTtlSec: num("AGENT_TOKEN_MAX_TTL", 86400), // 24h
  // refresh 重用检测:旧 refresh 在此窗口内复用视为合法(容忍并发/重试),
  // 超过窗口视为泄露 → 吊销 session。OAuth 安全 BCP 建议 30s-数分钟。
  refreshReuseGraceSec: num("REFRESH_REUSE_GRACE_SEC", 30),
  // 限流(默认宽松,本地联调不卡;生产调小)
  rateLimit: {
    loginWindowMs: num("RL_LOGIN_WINDOW_MS", 60_000),
    loginMax: num("RL_LOGIN_MAX", 20), // 每 IP 每分钟 20 次登录尝试
    tokenWindowMs: num("RL_TOKEN_WINDOW_MS", 60_000),
    tokenMax: num("RL_TOKEN_MAX", 120), // 每 client 每分钟 120 次(含轮询)
    proxyWindowMs: num("RL_PROXY_WINDOW_MS", 60_000),
    proxyMax: num("RL_PROXY_MAX", 300), // 每 session 每分钟 300 次
    // admin 后台登录限流(原本无,新增防爆破)
    adminLoginWindowMs: num("RL_ADMIN_LOGIN_WINDOW_MS", 60_000),
    adminLoginMax: num("RL_ADMIN_LOGIN_MAX", 10), // 每 IP 每分钟 10 次
    deviceAuthWindowMs: num("RL_DEVICE_AUTH_WINDOW_MS", 60_000),
    deviceAuthMax: num("RL_DEVICE_AUTH_MAX", 30), // 每 client 每分钟 30 次
  },
} as const;

/** 当前是否仍在使用默认 session secret(未设 ADMIN_SESSION_SECRET)。 */
export function isUsingDefaultSessionSecret(): boolean {
  return config.adminSessionSecret === DEFAULT_SESSION_SECRET;
}

/**
 * 已知的弱 ADMIN_SESSION_SECRET 值黑名单。
 *
 * 这些值出现在源码默认、docker-compose 默认、或文档示例里,任何能读到
 * 仓库的人都知道。用它们当 HMAC 密钥等于没加密:攻击者可离线伪造任意
 * admin cookie。生产环境必须拒绝启动。
 */
const KNOWN_WEAK_SESSION_SECRETS = new Set([
  DEFAULT_SESSION_SECRET, // 源码默认:"dev_session_secret_change_me"
  "dev_session_secret", // docker-compose 历史默认
  "change_me",
  "secret",
  "",
]);

/**
 * 判断 session secret 是否安全可用于生产。
 * 公开以便测试:拒绝已知弱值 + 要求最小长度(32 字节 ≈ 256 bit)。
 */
export function isSessionSecretSafeForProduction(secret: string): boolean {
  if (KNOWN_WEAK_SESSION_SECRETS.has(secret)) return false;
  if (secret.length < 32) return false; // HMAC-SHA256 建议 ≥256 bit
  return true;
}

/**
 * 生产环境启动前校验:拒绝用不安全的默认值/弱密钥启动。
 *
 * 安全动机:ADMIN_SESSION_SECRET 是 admin cookie 的 HMAC 密钥。
 * 默认值 "dev_session_secret_change_me" 硬编码在源码里,任何能读到源码
 * 的人(包括公开仓库)都能用它离线伪造任意 admin 的 session cookie,
 * 直接绕过登录。docker-compose.yml 也曾用 "dev_session_secret" 作默认,
 * 同样已知。生产部署必须显式提供强随机密钥(≥32 字节)。
 *
 * 在 index.ts 启动时调用。
 */
export function assertProductionConfig(): void {
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd) return; // 非生产允许默认值(开发便利)
  const failures: string[] = [];
  if (!isSessionSecretSafeForProduction(config.adminSessionSecret)) {
    failures.push(
      "ADMIN_SESSION_SECRET 不安全(未设置 / 是已知默认值 / 长度 < 32)。生产环境必须用强随机密钥(如 openssl rand -hex 32),否则 admin cookie 可被伪造。",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      "生产环境配置校验失败:\n" +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
  }
}
