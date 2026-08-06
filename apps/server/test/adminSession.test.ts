import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * admin session cookie —— HMAC 签名的无状态 cookie。
 *
 * 安全契约:
 * 1. 自签自验:同一 secret 下,issue 后 parse 必须还原出 adminId/username
 * 2. 篡改 payload(改 adminId 提权)→ HMAC 失配 → null
 * 3. 篡改签名 → null
 * 4. 过期(exp <= now)→ null
 * 5. 完全畸形(无点、空、乱码)→ null,不抛
 * 6. 不同 secret 签的 cookie → null(防跨环境/伪造)
 */

// 用固定 secret 测试(setup 已注入)
async function loadModule() {
  vi.resetModules();
  return await import("../src/middleware/adminSession.js");
}

describe("adminSession round-trip", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("issue → parse 还原 adminId/username", async () => {
    const { issueSessionCookieValue, parseSessionCookieValue } =
      await loadModule();
    const cookie = issueSessionCookieValue(42, "alice");
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const parsed = parseSessionCookieValue(cookie);
    expect(parsed).not.toBeNull();
    expect(parsed!.adminId).toBe(42);
    expect(parsed!.username).toBe("alice");
    expect(parsed!.exp).toBeGreaterThan(Date.now());
  });
});

describe("adminSession 攻击面", () => {
  beforeEach(async () => {
    vi.resetModules();
    await loadModule();
  });

  it("篡改 payload(改 adminId 提权)→ null", async () => {
    const { issueSessionCookieValue, parseSessionCookieValue } =
      await loadModule();
    const cookie = issueSessionCookieValue(1, "lowpriv");
    const [payloadB64, sig] = cookie.split(".");
    // 解 payload,改 adminId,re-encode,签名不动
    const payloadJson = JSON.parse(
      Buffer.from(payloadB64!, "base64url").toString("utf8"),
    );
    payloadJson.adminId = 9999; // 提权!
    const tamperedPayload = Buffer.from(
      JSON.stringify(payloadJson),
      "utf8",
    ).toString("base64url");
    const forged = `${tamperedPayload}.${sig}`;
    expect(parseSessionCookieValue(forged)).toBeNull();
  });

  it("篡改 exp(延长有效期)→ null", async () => {
    const { issueSessionCookieValue, parseSessionCookieValue } =
      await loadModule();
    const cookie = issueSessionCookieValue(7, "u");
    const [payloadB64, sig] = cookie.split(".");
    const payloadJson = JSON.parse(
      Buffer.from(payloadB64!, "base64url").toString("utf8"),
    );
    payloadJson.exp = Date.now() + 365 * 24 * 3600 * 1000; // 一年后
    const tampered = Buffer.from(
      JSON.stringify(payloadJson),
      "utf8",
    ).toString("base64url");
    expect(parseSessionCookieValue(`${tampered}.${sig}`)).toBeNull();
  });

  it("签名被替换成任意值 → null", async () => {
    const { issueSessionCookieValue, parseSessionCookieValue } =
      await loadModule();
    const cookie = issueSessionCookieValue(1, "u");
    const [payloadB64] = cookie.split(".");
    expect(
      parseSessionCookieValue(`${payloadB64}.AAAAAAAAAAAAAAAAAAAAAAAA`),
    ).toBeNull();
  });

  it("过期 cookie → null", async () => {
    // 直接伪造一个 exp 在过去的 cookie(用真实 secret 签名,通过 HMAC 校验)
    const { createHmac } = await import("node:crypto");
    const config = (await import("../src/config.js")).config;
    const pastPayload = {
      adminId: 1,
      username: "u",
      exp: Date.now() - 1000, // 1 秒前过期
    };
    const payloadB64 = Buffer.from(JSON.stringify(pastPayload), "utf8").toString(
      "base64url",
    );
    const sig = createHmac("sha256", config.adminSessionSecret)
      .update(payloadB64)
      .digest("base64url");
    const { parseSessionCookieValue } = await loadModule();
    expect(parseSessionCookieValue(`${payloadB64}.${sig}`)).toBeNull();
  });

  it("完全畸形输入 → null,不抛", async () => {
    const { parseSessionCookieValue } = await loadModule();
    const junk = [
      undefined,
      "",
      "nopoint",
      "a.b.c",
      "..",
      ".....",
      "payload",
      "@@@@.@@@@",
      `${"A".repeat(100)}.${"B".repeat(50)}`,
    ];
    for (const j of junk) {
      expect(() => parseSessionCookieValue(j as string)).not.toThrow();
      expect(parseSessionCookieValue(j as string)).toBeNull();
    }
  });

  it("不同 secret 签的 cookie → null(防伪造/跨环境)", async () => {
    vi.resetModules();
    vi.stubEnv("ADMIN_SESSION_SECRET", "secret-A");
    const modA = await loadModule();
    const cookieA = modA.issueSessionCookieValue(1, "u");

    vi.resetModules();
    vi.stubEnv("ADMIN_SESSION_SECRET", "secret-B-different");
    const modB = await loadModule();
    expect(modB.parseSessionCookieValue(cookieA)).toBeNull();
    vi.unstubAllEnvs();
  });

  it("payload 非 JSON → null,不抛", async () => {
    const { parseSessionCookieValue } = await loadModule();
    // 签名一个随机 payload 让签名校验通过,但 payload 是垃圾 JSON
    const { createHmac } = await import("node:crypto");
    const config = (await import("../src/config.js")).config;
    const junkPayload = Buffer.from("not json{").toString("base64url");
    const sig = createHmac("sha256", config.adminSessionSecret)
      .update(junkPayload)
      .digest("base64url");
    expect(() =>
      parseSessionCookieValue(`${junkPayload}.${sig}`),
    ).not.toThrow();
    expect(parseSessionCookieValue(`${junkPayload}.${sig}`)).toBeNull();
  });
});
