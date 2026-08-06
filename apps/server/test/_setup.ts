/**
 * 测试基础设施 —— mock PG/Redis、统一重置 config 状态。
 *
 * 关键:server 的 config 在 import 时读 env,各模块通过 module-level singleton
 * 持有连接。vitest 的 vi.mock + isolate:true 保证每个测试文件重算 module。
 *
 * 用法(每个测试文件顶部):
 *   import { mockInfra, setEnv } from "../test/_setup.js";
 *   mockInfra(); // 把 infra 替换成 fake,config 用测试默认值
 */

/**
 * 用测试值预设 process.env(在 import config.ts 之前调)。
 * 必须在静态 import 之前执行 —— 通过 vi.mock 的 hoisting 或 setup 文件实现。
 */
export function setEnv(overrides: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    NODE_ENV: "test",
    ADMIN_SESSION_SECRET: "test-session-secret-very-strong-random-value",
    ADMIN_SESSION_TTL: "3600",
    DATABASE_URL: "postgres://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379/15",
    COMPANY_API_BASE: "http://company-mock.test",
    JWT_ISSUER: "test-issuer",
    SERVER_PORT: "3999",
    JWT_ACCESS_TTL: "3600",
    JWT_REFRESH_TTL: "604800",
    DEVICE_CODE_TTL: "600",
    DEVICE_POLL_INTERVAL: "5",
    REFRESH_REUSE_GRACE_SEC: "30",
    RL_LOGIN_WINDOW_MS: "60000",
    RL_LOGIN_MAX: "20",
    RL_TOKEN_WINDOW_MS: "60000",
    RL_TOKEN_MAX: "120",
    RL_PROXY_WINDOW_MS: "60000",
    RL_PROXY_MAX: "300",
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    process.env[k] = v;
  }
}

// 在模块加载前预设环境(setup 文件最先执行)
setEnv();
