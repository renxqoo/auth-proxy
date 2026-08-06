import { randomBytes } from "node:crypto";
import type { CompanyTokenResponse } from "@auth-proxy/shared";
import { config } from "./config.js";
import { getDeviceCodeRepo, type DeviceCodeRecord } from "./repos/index.js";

/**
 * device_code 状态机 —— 设备授权流程的服务端状态。
 * 存储后移到 Redis(见 repos/deviceCodeRepo);本文件保留对外 API,
 * 负责 deviceCode/userCode 生成 + 状态流转语义。
 *
 *   pending → authorized → consumed/expired/denied
 */

const DEVICE_PREFIX = "dc_";

export type { DeviceCodeRecord };
export type DeviceCodeStatus = DeviceCodeRecord["status"];

function randomUserCode(): string {
  // 8 位大写字母数字,中划线分组:ABCD-EFGH(去易混字符)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  const buf = randomBytes(8);
  for (let i = 0; i < 8; i++) s += chars[buf[i] % chars.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 申请设备码;返回新记录(已落 Redis)。 */
export async function createDeviceCode(
  clientId: string,
  scope: string,
): Promise<DeviceCodeRecord> {
  const now = Date.now();
  const rec: DeviceCodeRecord = {
    deviceCode: DEVICE_PREFIX + randomBytes(18).toString("hex"),
    userCode: randomUserCode(),
    clientId,
    scope,
    status: "pending",
    createdAt: now,
    expiresAt: now + config.deviceCodeTtlSec * 1000,
  };
  await getDeviceCodeRepo().create(rec);
  return rec;
}

export async function findDeviceCodeByDevice(
  deviceCode: string,
): Promise<DeviceCodeRecord | null> {
  const rec = await getDeviceCodeRepo().findByDevice(deviceCode);
  if (rec) refreshExpiry(rec);
  return rec;
}

export async function findDeviceCodeByUser(
  userCode: string,
): Promise<DeviceCodeRecord | null> {
  return getDeviceCodeRepo().findByUser(userCode);
}

/** 浏览器登录成功:绑定 company_token,标记 authorized。 */
export async function authorizeDeviceCode(
  userCode: string,
  token: CompanyTokenResponse,
): Promise<DeviceCodeRecord | null> {
  const rec = await getDeviceCodeRepo().findByUser(userCode);
  if (!rec || rec.status !== "pending") return null;
  rec.companyToken = token;
  rec.status = "authorized";
  await getDeviceCodeRepo().update(rec);
  return rec;
}

/** CLI 换 token 成功:标记 consumed。 */
export async function consumeDeviceCode(
  deviceCode: string,
): Promise<DeviceCodeRecord | null> {
  const rec = await getDeviceCodeRepo().findByDevice(deviceCode);
  if (!rec || rec.status !== "authorized") return null;
  rec.status = "consumed";
  await getDeviceCodeRepo().update(rec);
  return rec;
}

/** 持久化 device_code 记录(轮询节流更新 lastPollAt 用)。 */
export async function updateDeviceCode(rec: DeviceCodeRecord): Promise<void> {
  await getDeviceCodeRepo().update(rec);
}

/** 惰性过期:超时未登录转 expired。 */
export function refreshExpiry(rec: DeviceCodeRecord): void {
  if (rec.status === "expired" || rec.status === "consumed") return;
  if (Date.now() >= rec.expiresAt) rec.status = "expired";
}
