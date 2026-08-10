import { describe, it, expect } from "vitest";
import { hasCompanyToken, NO_COMPANY_TOKEN } from "../src/repos/sessionRepo.js";

/**
 * hasCompanyToken 判定契约:
 * 判定 session 能否转发到公司应用,依据是 company token 真实状态,而非 sessionType 字符串。
 *
 * - 真实 token(user / agent session)→ true
 * - 占位 NO_COMPANY_TOKEN(machine session)→ false
 * - 空字符串 / 非字符串 → false(防御性)
 */
describe("hasCompanyToken", () => {
  it("真实 company token → true", () => {
    expect(hasCompanyToken({ companyAccessToken: "ct_alice_xxx" })).toBe(true);
  });

  it("占位 NO_COMPANY_TOKEN → false", () => {
    expect(hasCompanyToken({ companyAccessToken: NO_COMPANY_TOKEN })).toBe(false);
    expect(hasCompanyToken({ companyAccessToken: "__none__" })).toBe(false);
  });

  it("空字符串 → false", () => {
    expect(hasCompanyToken({ companyAccessToken: "" })).toBe(false);
  });

  it("非字符串 → false(防御性,SessionData 字段理论上不会是非 string)", () => {
    expect(hasCompanyToken({ companyAccessToken: null as unknown as string })).toBe(false);
    expect(hasCompanyToken({ companyAccessToken: undefined as unknown as string })).toBe(false);
  });
});
