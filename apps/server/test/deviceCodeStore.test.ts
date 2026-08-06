import { describe, it, expect } from "vitest";
import { refreshExpiry } from "../src/deviceCodeStore.js";
import type { DeviceCodeRecord } from "../src/repos/index.js";

/**
 * deviceCodeStore 纯函数测试(refreshExpiry)。
 *
 * refreshExpiry 是 device_code 状态机的"惰性过期":
 * - expired/consumed:不动(终态)
 * - pending/authorized/denied:若 now >= expiresAt → 转 expired
 */

function makeRec(overrides: Partial<DeviceCodeRecord> = {}): DeviceCodeRecord {
  return {
    deviceCode: "dc_test",
    userCode: "ABCD-EFGH",
    clientId: "cli_test",
    scope: "offline_access",
    status: "pending",
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("refreshExpiry", () => {
  it("未过期 + pending → 状态不变", () => {
    const rec = makeRec({ status: "pending", expiresAt: Date.now() + 60_000 });
    refreshExpiry(rec);
    expect(rec.status).toBe("pending");
  });

  it("已过期 + pending → 转 expired", () => {
    const rec = makeRec({ status: "pending", expiresAt: Date.now() - 1 });
    refreshExpiry(rec);
    expect(rec.status).toBe("expired");
  });

  it("已过期 + authorized → 转 expired(未被消费的授权码超时)", () => {
    const rec = makeRec({ status: "authorized", expiresAt: Date.now() - 1 });
    refreshExpiry(rec);
    expect(rec.status).toBe("expired");
  });

  it("已过期 + denied → 转 expired", () => {
    const rec = makeRec({ status: "denied", expiresAt: Date.now() - 1 });
    refreshExpiry(rec);
    expect(rec.status).toBe("expired");
  });

  it("expired 终态:expiresAt 已过但不再转(幂等)", () => {
    const rec = makeRec({ status: "expired", expiresAt: Date.now() - 9999 });
    refreshExpiry(rec);
    expect(rec.status).toBe("expired");
  });

  it("consumed 终态:即便 expiresAt 没过也保持 consumed", () => {
    const rec = makeRec({
      status: "consumed",
      expiresAt: Date.now() + 9999,
    });
    refreshExpiry(rec);
    expect(rec.status).toBe("consumed");
  });

  it("边界:expiresAt 恰好等于 now → 转 expired(>= 判定)", () => {
    const now = Date.now();
    const rec = makeRec({ status: "pending", expiresAt: now });
    refreshExpiry(rec);
    expect(rec.status).toBe("expired");
  });
});
