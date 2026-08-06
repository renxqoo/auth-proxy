import { describe, it, expect, vi, beforeEach } from "vitest";

// mock sessionStore + companyAuth + infra,只测 needsRefresh 的纯逻辑
vi.mock("../src/sessionStore.js", () => ({
  findSessionBySessionId: vi.fn(),
  updateSessionCompanyToken: vi.fn(),
}));
vi.mock("../src/companyAuth.js", () => ({
  refreshWithCompany: vi.fn(),
  CompanyAuthError: class extends Error {},
}));
vi.mock("../src/infra.js", () => ({
  getRedis: () => ({ set: vi.fn(), del: vi.fn() }),
}));

import { CompanyTokenRefresher } from "../src/companyTokenRefresher.js";

describe("CompanyTokenRefresher.needsRefresh", () => {
  let r: CompanyTokenRefresher;
  beforeEach(() => {
    r = new CompanyTokenRefresher();
  });

  it("expiresAt 远在未来 → false", () => {
    expect(r.needsRefresh(Date.now() + 3600_000)).toBe(false);
  });

  it("expiresAt 已过(过去)→ true", () => {
    expect(r.needsRefresh(Date.now() - 1000)).toBe(true);
  });

  it("expiresAt 在 30s 内(提前刷新窗口)→ true", () => {
    // REFRESH_AHEAD_MS = 30000;now + 30000 >= expiresAt → true
    expect(r.needsRefresh(Date.now() + 29_000)).toBe(true);
    expect(r.needsRefresh(Date.now() + 30_000)).toBe(true);
  });

  it("expiresAt 正好 30s+1ms 外 → false(边界)", () => {
    expect(r.needsRefresh(Date.now() + 30_001)).toBe(false);
  });
});
