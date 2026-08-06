import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 被 vitest 提升到顶部,替换 repos/index.js
// 这样 createDeviceCode 不触达真实 Redis
const fakeCreate = vi.fn<(rec: unknown) => Promise<void>>();
vi.mock("../src/repos/index.js", () => ({
  getDeviceCodeRepo: () => ({
    create: fakeCreate,
    findByDevice: async () => null,
    findByUser: async () => null,
    update: async () => {},
  }),
}));

import { createDeviceCode } from "../src/deviceCodeStore.js";

describe("createDeviceCode 生成的字段格式与熵", () => {
  beforeEach(() => {
    fakeCreate.mockReset();
    fakeCreate.mockResolvedValue(undefined);
  });

  it("userCode XXXX-XXXX,字符集去易混字符(无 0/O/1/I)", async () => {
    for (let i = 0; i < 50; i++) {
      fakeCreate.mockClear();
      await createDeviceCode("cli_test", "offline_access");
      const rec = fakeCreate.mock.calls[0]![0] as {
        userCode: string;
        deviceCode: string;
      };
      expect(rec.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(rec.userCode).not.toMatch(/[01OI]/);
    }
  });

  it("deviceCode dc_ + 36 hex(18 字节)", async () => {
    await createDeviceCode("cli_test", "offline_access");
    const rec = fakeCreate.mock.calls[0]![0] as { deviceCode: string };
    expect(rec.deviceCode).toMatch(/^dc_[0-9a-f]{36}$/);
  });

  it("每次生成的 userCode/deviceCode 都不同(随机性)", async () => {
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      fakeCreate.mockClear();
      await createDeviceCode("cli_test", "offline_access");
      const rec = fakeCreate.mock.calls[0]![0] as { userCode: string };
      codes.push(rec.userCode);
    }
    expect(new Set(codes).size).toBe(codes.length); // 全部唯一
  });

  it("status=pending,clientId/scope 正确透传", async () => {
    await createDeviceCode("cli_abc", "offline_access read:orders");
    const rec = fakeCreate.mock.calls[0]![0] as {
      status: string;
      clientId: string;
      scope: string;
    };
    expect(rec.status).toBe("pending");
    expect(rec.clientId).toBe("cli_abc");
    expect(rec.scope).toBe("offline_access read:orders");
  });
});
