import { describe, it, expect } from "vitest";
import { getClientIp } from "../src/middleware/rateLimit.js";
import { bearerOf } from "../src/jwt.js";

/**
 * getClientIp —— 限流/审计用的 IP 提取。
 *
 * 安全契约:
 * 1. 有 x-forwarded-for 时取第一段(最左 = 客户端真实 IP,需可信反代)
 * 2. 无 XFF 时回退 remote-address
 * 3. 都没有 → "unknown"(不崩)
 */
describe("getClientIp", () => {
  function ctx(headers: Record<string, string | undefined>) {
    return { req: { header: (n: string) => headers[n.toLowerCase()] } };
  }

  it("单个 IP 的 x-forwarded-for → 取该 IP", () => {
    expect(getClientIp(ctx({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("多跳代理的 x-forwarded-for → 取最左(客户端)", () => {
    expect(getClientIp(ctx({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" }))).toBe(
      "1.2.3.4",
    );
  });

  it("XFF 带空格 → trim", () => {
    expect(getClientIp(ctx({ "x-forwarded-for": "  1.2.3.4  " }))).toBe(
      "1.2.3.4",
    );
  });

  it("无 XFF → remote-address", () => {
    expect(getClientIp(ctx({ "remote-address": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("XFF 优先于 remote-address", () => {
    expect(
      getClientIp(
        ctx({ "x-forwarded-for": "1.1.1.1", "remote-address": "2.2.2.2" }),
      ),
    ).toBe("1.1.1.1");
  });

  it("都没有 → 'unknown'", () => {
    expect(getClientIp(ctx({}))).toBe("unknown");
  });
});

/**
 * bearerOf —— 从 Authorization 头提 Bearer token。
 *
 * 安全契约:
 * 1. 标准 "Bearer xxx" → 返回 xxx
 * 2. 非 Bearer / 缺失 / 畸形 → undefined(不误放行)
 * 3. 大小写:当前实现区分大小写(只认 "Bearer");回归保护
 */
describe("bearerOf", () => {
  it("标准 Bearer → token", () => {
    expect(bearerOf("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("Bearer 后多个空格也能取(正则 \\s+)", () => {
    expect(bearerOf("Bearer   xyz")).toBe("xyz");
  });

  it("undefined / 空 → undefined", () => {
    expect(bearerOf(undefined)).toBeUndefined();
    expect(bearerOf("")).toBeUndefined();
  });

  it("非 Bearer scheme → undefined", () => {
    expect(bearerOf("Basic abc")).toBeUndefined();
    expect(bearerOf("bearer abc")).toBeUndefined(); // 小写不认(回归)
    expect(bearerOf("Token abc")).toBeUndefined();
  });

  it("只有 'Bearer' 无 token → undefined", () => {
    expect(bearerOf("Bearer")).toBeUndefined();
    // "Bearer " 后 \s+ 匹配了空格,但 (.+) 需 ≥1 字符 → 仍不匹配 → undefined
    expect(bearerOf("Bearer ")).toBeUndefined();
  });
});
