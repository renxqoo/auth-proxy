import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AdminRepo.verifyPassword 的 timing 安全单测。
 *
 * 攻击面:用户枚举。"用户不存在"和"密码错误"两条路径必须消耗
 * 等价 CPU 时间(都跑一次 scrypt),否则可通过响应时延差异枚举用户名。
 *
 * 测试策略:mock getDb 让 findByUsername 返回 null,测 verifyPassword
 *         在"不存在"路径仍调用 verifySecret(即做了 scrypt)。
 *         并用 performance.now() 断言两条路径耗时在同一数量级。
 */

const fakeQuery = {
  select: vi.fn(() => fakeQuery),
  from: vi.fn(() => fakeQuery),
  where: vi.fn(async () => [] as unknown[]), // 默认:用户不存在
};

vi.mock("../src/infra.js", () => ({
  getDb: () => fakeQuery,
}));

import { AdminRepo } from "../src/repos/adminRepo.js";

beforeEach(() => {
  vi.clearAllMocks();
  // 默认返回空(用户不存在)
  fakeQuery.where.mockResolvedValue([]);
});

describe("AdminRepo.verifyPassword timing 安全", () => {
  it("用户不存在时:不短路,仍消耗 scrypt 等价时间", async () => {
    const repo = new AdminRepo();
    const t0 = performance.now();
    const result = await repo.verifyPassword("nonexistent_user", "any-password");
    const elapsed = performance.now() - t0;

    expect(result).toBeNull();
    // 关键:必须消耗显著时间(scrypt ~几十到几百 ms)。
    // 若实现回退成"立即返回 null",elapsed 会 < 1ms。
    // 留足余量:scryptSync 在 node 默认参数下约 50-200ms,断言 > 10ms。
    expect(elapsed).toBeGreaterThan(10);
  });

  it("用户不存在 vs 密码错误:耗时在同一数量级(< 3x 差异)", async () => {
    const repo = new AdminRepo();

    // 路径 A:用户不存在
    fakeQuery.where.mockResolvedValue([]);
    const t0 = performance.now();
    await repo.verifyPassword("ghost", "pw");
    const tGhost = performance.now() - t0;

    // 路径 B:用户存在但密码错
    // 构造一个真实 hashSecret 的行,使 verifySecret 跑完整 scrypt
    const { hashSecret } = await import("../src/repos/appRepo.js");
    const stored = hashSecret("correct-password");
    fakeQuery.where.mockResolvedValue([
      {
        id: 1,
        username: "real",
        password: stored,
        createdAt: new Date(),
      },
    ]);
    const t1 = performance.now();
    await repo.verifyPassword("real", "wrong-password");
    const tWrong = performance.now() - t1;

    // 两条路径都跑了一次 scrypt,耗时应在同一数量级。
    // 放宽到 3x(避免 CI 环境抖动误报);真正短路实现的差异会是 50-100x。
    const ratio = Math.max(tGhost, tWrong) / Math.min(tGhost, tWrong);
    expect(ratio).toBeLessThan(3);
  });

  it("用户不存在时返回 null,不抛", async () => {
    const repo = new AdminRepo();
    await expect(
      repo.verifyPassword("anyone", "anything"),
    ).resolves.toBeNull();
  });
});
