import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 攻击场景 #2(HIGH):默认 session secret 泄露 → cookie 伪造
 *
 * 漏洞:config.adminSessionSecret 在 ADMIN_SESSION_SECRET 未设时
 *      默认 "dev_session_secret_change_me"。攻击者知道这个默认值后,
 *      可以离线构造一个有效签名的 admin_session cookie,直接绕过登录。
 *
 * 期望:生产环境(NODE_ENV=production)必须拒绝用默认 secret 启动,
 *      或至少不能让默认 secret 通过校验。
 *
 * 修复策略:config 暴露 isUsingDefaultSecret 标志;启动时(production)
 *         若为 true 则抛错。parseSessionCookieValue 可额外检查。
 */

describe("SECURITY: 默认 ADMIN_SESSION_SECRET 不能在生产生效", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("未设 ADMIN_SESSION_SECRET → config 标记为使用默认 secret", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const { config, isUsingDefaultSessionSecret } = await import(
      "../src/config.js"
    );
    expect(config.adminSessionSecret).toBe("dev_session_secret_change_me");
    expect(isUsingDefaultSessionSecret()).toBe(true);
  });

  it("设了自定义 ADMIN_SESSION_SECRET → isUsingDefaultSessionSecret() === false", async () => {
    process.env.ADMIN_SESSION_SECRET = "a-real-random-secret-1234567890";
    const { isUsingDefaultSessionSecret } = await import("../src/config.js");
    expect(isUsingDefaultSessionSecret()).toBe(false);
    delete process.env.ADMIN_SESSION_SECRET;
  });

  it("攻击:用默认 secret 离线伪造的 cookie,在默认配置下能通过 parse", async () => {
    // 这是漏洞复现 —— 证明默认 secret 可被利用
    delete process.env.ADMIN_SESSION_SECRET;
    const { createHmac } = await import("node:crypto");
    const { config } = await import("../src/config.js");
    const { parseSessionCookieValue } = await import(
      "../src/middleware/adminSession.js"
    );
    // 攻击者离线构造:
    const payload = {
      adminId: 1,
      username: "admin",
      exp: Date.now() + 3600_000,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const sig = createHmac("sha256", config.adminSessionSecret)
      .update(payloadB64)
      .digest("base64url");
    const forged = `${payloadB64}.${sig}`;
    // 漏洞存在时:这个伪造 cookie 会通过校验(返回非 null)
    expect(parseSessionCookieValue(forged)).not.toBeNull();
  });

  it("修复目标:assertProductionConfig() 在 production + 默认 secret 时抛错", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    const { assertProductionConfig } = await import("../src/config.js");
    expect(() => assertProductionConfig()).toThrow(/ADMIN_SESSION_SECRET/i);
    vi.unstubAllEnvs();
  });

  it("修复目标:production + 自定义 secret → assertProductionConfig 不抛", async () => {
    process.env.ADMIN_SESSION_SECRET = "a-strong-random-secret-32bytes-min-1234567890";
    vi.stubEnv("NODE_ENV", "production");
    const { assertProductionConfig } = await import("../src/config.js");
    expect(() => assertProductionConfig()).not.toThrow();
    delete process.env.ADMIN_SESSION_SECRET;
    vi.unstubAllEnvs();
  });

  it("回归:docker-compose 历史默认 'dev_session_secret' 必须被拒绝(防绕过)", async () => {
    // 修复前的 assertProductionConfig 只查源码默认 'dev_session_secret_change_me',
    // 而 docker-compose.yml 默认是 'dev_session_secret' → 校验通过 → 弱密钥在生产生效。
    // 黑名单必须覆盖两者,否则部署用 compose 默认即可绕过校验。
    process.env.ADMIN_SESSION_SECRET = "dev_session_secret";
    vi.stubEnv("NODE_ENV", "production");
    const { assertProductionConfig } = await import("../src/config.js");
    expect(() => assertProductionConfig()).toThrow(/ADMIN_SESSION_SECRET/i);
    delete process.env.ADMIN_SESSION_SECRET;
    vi.unstubAllEnvs();
  });

  it("回归:短密钥(< 32 字节)必须被拒绝", async () => {
    process.env.ADMIN_SESSION_SECRET = "short-but-not-default-xyz";
    vi.stubEnv("NODE_ENV", "production");
    const { assertProductionConfig } = await import("../src/config.js");
    expect(() => assertProductionConfig()).toThrow(/ADMIN_SESSION_SECRET/i);
    delete process.env.ADMIN_SESSION_SECRET;
    vi.unstubAllEnvs();
  });

  it("回归:32 字节强随机密钥 → 通过", async () => {
    process.env.ADMIN_SESSION_SECRET = "abcdef0123456789abcdef0123456789"; // 32 字符
    vi.stubEnv("NODE_ENV", "production");
    const { assertProductionConfig } = await import("../src/config.js");
    expect(() => assertProductionConfig()).not.toThrow();
    delete process.env.ADMIN_SESSION_SECRET;
    vi.unstubAllEnvs();
  });
});

afterEach(() => {
  // 恢复 setup 默认的 test secret
  process.env.ADMIN_SESSION_SECRET =
    "test-session-secret-very-strong-random-value";
  vi.unstubAllEnvs();
});
