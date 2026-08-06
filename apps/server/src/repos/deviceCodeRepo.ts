import type { CompanyTokenResponse } from "@auth-proxy/shared";
import { config } from "../config.js";
import { getRedis } from "../infra.js";

/**
 * device_code 仓储 —— 纯 Redis(临时状态,不进 PG)。
 *
 * 替换原内存版 deviceCodeStore。状态机不变:
 *   pending → authorized → consumed/expired/denied
 *
 * Redis 结构:
 *   key = devcode:{deviceCode}      → JSON 全量记录(TTL = expires_in)
 *   key = devcode-user:{userCode}   → deviceCode 反查(TTL 同上)
 */

export type DeviceCodeStatus =
  | "pending"
  | "authorized"
  | "consumed"
  | "expired"
  | "denied";

export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string;
  status: DeviceCodeStatus;
  createdAt: number;
  expiresAt: number;
  companyToken?: CompanyTokenResponse;
  deniedReason?: string;
  lastPollAt?: number;
}

const KEY_DEV = (dc: string) => `devcode:${dc}`;
const KEY_USER = (uc: string) => `devcode-user:${uc}`;
const TTL = config.deviceCodeTtlSec;

export class DeviceCodeRepo {
  async create(rec: DeviceCodeRecord): Promise<void> {
    const redis = getRedis();
    const pipe = redis.multi();
    pipe.set(KEY_DEV(rec.deviceCode), JSON.stringify(rec), "EX", TTL);
    pipe.set(KEY_USER(rec.userCode), rec.deviceCode, "EX", TTL);
    await pipe.exec();
  }

  async findByDevice(deviceCode: string): Promise<DeviceCodeRecord | null> {
    const raw = await getRedis().get(KEY_DEV(deviceCode));
    return raw ? (JSON.parse(raw) as DeviceCodeRecord) : null;
  }

  async findByUser(userCode: string): Promise<DeviceCodeRecord | null> {
    const dc = await getRedis().get(KEY_USER(userCode));
    if (!dc) return null;
    return this.findByDevice(dc);
  }

  async update(rec: DeviceCodeRecord): Promise<void> {
    // 保持原 TTL(取剩余时间);简化起见用原 TTL 重设(略宽松)
    const redis = getRedis();
    await redis.set(KEY_DEV(rec.deviceCode), JSON.stringify(rec), "EX", TTL);
  }
}
