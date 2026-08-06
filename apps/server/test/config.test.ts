import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// config 是 `as const` 模块级导出,env 在 import 时固化。
// 用动态 import + vi.resetModules 测不同 env 下的行为。

describe("config.maskUrl", () => {
  let maskUrl: (url: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/config.js");
    maskUrl = mod.maskUrl;
  });

  it("postgres: 隐藏密码但保留 user/host/db", () => {
    expect(maskUrl("postgres://user:secret@localhost:5432/mydb")).toBe(
      "postgres://user:***@localhost:5432/mydb",
    );
  });

  it("postgres: 无 user 无密码 → 原样返回(无可脱敏部分)", () => {
    expect(maskUrl("postgres://localhost:5432/db")).toBe(
      "postgres://localhost:5432/db",
    );
  });

  it("postgres: 只有 user(无密码)→ user:*** 形式", () => {
    // user 存在就输出 user:***。文档语义 OK(防止泄露 host 是否有密码)
    expect(maskUrl("postgres://dbuser@localhost:5432/db")).toBe(
      "postgres://dbuser:***@localhost:5432/db",
    );
  });

  it("redis: 隐藏密码", () => {
    expect(maskUrl("redis://:topsecret@redis-host:6379/2")).toBe(
      "redis://:***@redis-host:6379/2",
    );
  });

  it("无凭证 URL:原样保留协议/host/path(URL 规范会给空 pathname 补 '/')", () => {
    expect(maskUrl("http://localhost:4000")).toBe("http://localhost:4000/");
    expect(maskUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("非 URL 字符串:返回固定占位,不抛", () => {
    expect(maskUrl("not a url at all")).toBe("(invalid url)");
    expect(maskUrl("")).toBe("(invalid url)");
  });

  it("含特殊字符(已 percent-encode)的密码也能脱敏", () => {
    // 真实连接串里密码需 percent-encode;maskUrl 只关心 user/host/path
    expect(maskUrl("postgres://u:p%40ss%21w0rd@h:5432/db")).toBe(
      "postgres://u:***@h:5432/db",
    );
  });
});

describe("config.safeLog / safeError", () => {
  let safeLog: (m: string, ...a: unknown[]) => void;
  let safeError: (m: string, ...a: unknown[]) => void;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/config.js");
    safeLog = mod.safeLog;
    safeError = mod.safeError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("production:Error 仅打印 name:message,不含 stack", () => {
    vi.stubEnv("NODE_ENV", "production");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = new Error("boom");
    err.stack = "Error: boom\n    at some/file.ts:42";
    safeLog("msg", err);
    expect(logSpy).toHaveBeenCalledOnce();
    const args = logSpy.mock.calls[0]!;
    expect(args[0]).toBe("msg");
    // 关键:不含 stack 行
    expect(args[1]).toBe("Error: boom");
    expect(String(args[1])).not.toContain("at some/file.ts");
  });

  it("production:Error 对象传给 safeError 仅 name:message", () => {
    vi.stubEnv("NODE_ENV", "production");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("fail");
    err.stack = "Error: fail\n    at secret";
    safeError("ctx", err, { sql: "SELECT * FROM admins" });
    const args = errSpy.mock.calls[0]!;
    expect(args[0]).toBe("ctx");
    expect(args[1]).toBe("Error: fail");
    // 非 Error 参数原样透传(本测试只针对 Error 收敛)
    expect(args[2]).toEqual({ sql: "SELECT * FROM admins" });
  });

  it("非 production:完整透传(不收敛 Error)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = new Error("boom");
    err.stack = "Error: boom\n    at dev.ts:1";
    safeLog("msg", err);
    expect(logSpy.mock.calls[0]![1]).toBe(err); // 同一对象,未替换
  });
});
