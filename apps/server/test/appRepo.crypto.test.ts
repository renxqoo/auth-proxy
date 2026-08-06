import { describe, it, expect } from "vitest";
import { hashSecret, verifySecret } from "../src/repos/appRepo.js";

/**
 * appRepo 的纯函数:hashSecret / verifySecret。
 * 这是整个系统的密码学根:admin 密码、client_secret 都靠它。
 *
 * 关键安全契约:
 * 1. 同一明文每次 hash 不同(随机 salt)→ 防彩虹表
 * 2. verifySecret 对正确密码返回 true,错误返回 false
 * 3. 存储格式损坏/畸形 → 返回 false,不抛(防 DoS)
 * 4. 长度不匹配 → 直接 false(先于 timingSafeEqual,防越界)
 */

describe("hashSecret", () => {
  it("同一明文两次 hash 产生不同结果(随机 salt)", () => {
    const a = hashSecret("password123");
    const b = hashSecret("password123");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+:[0-9a-f]+$/); // salt_hex:hash_hex
  });

  it("salt 部分长度固定 16 字节 = 32 hex", () => {
    const h = hashSecret("x");
    const [salt] = h.split(":");
    expect(salt!.length).toBe(32);
  });

  it("hash 部分长度 64 字节 = 128 hex", () => {
    const h = hashSecret("x");
    const [, hash] = h.split(":");
    expect(hash!.length).toBe(128);
  });
});

describe("verifySecret", () => {
  it("正确密码 → true", () => {
    const stored = hashSecret("correct horse battery staple");
    expect(verifySecret("correct horse battery staple", stored)).toBe(true);
  });

  it("错误密码 → false", () => {
    const stored = hashSecret("right");
    expect(verifySecret("wrong", stored)).toBe(false);
    expect(verifySecret("RIGHT", stored)).toBe(false); // 大小写敏感
    expect(verifySecret("right ", stored)).toBe(false); // 空格敏感
    expect(verifySecret("", stored)).toBe(false);
  });

  it("大小写/空格/完全不同的串都返回 false,绝不抛", () => {
    const stored = hashSecret("abc");
    const weird = ["", " ", "ABC", "abc ", " abc", "\u0000", "a".repeat(10_000)];
    for (const w of weird) {
      expect(() => verifySecret(w, stored)).not.toThrow();
      expect(verifySecret(w, stored)).toBe(false);
    }
  });

  it("畸形 stored(无冒号)→ false,不抛", () => {
    expect(verifySecret("anything", "")).toBe(false);
    expect(verifySecret("anything", "nodelimiter")).toBe(false);
    expect(verifySecret("anything", ":")).toBe(false);
    expect(verifySecret("anything", "onlysalt")).toBe(false);
  });

  it("畸形 stored(非 hex)→ false,不抛", () => {
    expect(verifySecret("x", "zzzz:yyyy")).toBe(false);
    expect(verifySecret("x", "1234:nothex!@#$")).toBe(false);
  });

  it("hash 长度与计算结果不匹配(被截断)→ false,不抛", () => {
    // 真实 hash 是 128 hex;截短成 10 hex
    const real = hashSecret("pw");
    const [, hash] = real.split(":");
    const truncated = `abcd:${hash!.slice(0, 10)}`;
    expect(verifySecret("pw", truncated)).toBe(false);
  });

  it("存储格式与实现格式一致(回归:格式不能悄悄变)", () => {
    // 格式契约:<salt_hex_32>:<hash_hex_128>
    const stored = hashSecret("contract-test");
    const [salt, hash] = stored.split(":");
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });
});
