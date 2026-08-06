import { SessionRepo } from "./sessionRepo.js";
import type { SessionData } from "./sessionRepo.js";
import { DeviceCodeRepo } from "./deviceCodeRepo.js";
import type { DeviceCodeRecord } from "./deviceCodeRepo.js";
import { AppRepo } from "./appRepo.js";
import type { AppRecord } from "./appRepo.js";
import { SigningKeyRepo } from "./signingKeyRepo.js";
import { AuditRepo } from "./auditRepo.js";
import { TokenRepo } from "./tokenRepo.js";
import type { TokenRecord } from "./tokenRepo.js";
import { AdminRepo } from "./adminRepo.js";
import type { AdminRecord } from "./adminRepo.js";

export type {
  SessionData,
  DeviceCodeRecord,
  TokenRecord,
  AppRecord,
  AdminRecord,
};

let sessionRepo: SessionRepo | null = null;
let deviceCodeRepo: DeviceCodeRepo | null = null;
let appRepo: AppRepo | null = null;
let signingKeyRepo: SigningKeyRepo | null = null;
let auditRepo: AuditRepo | null = null;
let tokenRepo: TokenRepo | null = null;
let adminRepo: AdminRepo | null = null;

export function getSessionRepo(): SessionRepo {
  if (!sessionRepo) sessionRepo = new SessionRepo();
  return sessionRepo;
}
export function getDeviceCodeRepo(): DeviceCodeRepo {
  if (!deviceCodeRepo) deviceCodeRepo = new DeviceCodeRepo();
  return deviceCodeRepo;
}
export function getAppRepo(): AppRepo {
  if (!appRepo) appRepo = new AppRepo();
  return appRepo;
}
export function getSigningKeyRepo(): SigningKeyRepo {
  if (!signingKeyRepo) signingKeyRepo = new SigningKeyRepo();
  return signingKeyRepo;
}
export function getAuditRepo(): AuditRepo {
  if (!auditRepo) auditRepo = new AuditRepo();
  return auditRepo;
}
export function getTokenRepo(): TokenRepo {
  if (!tokenRepo) tokenRepo = new TokenRepo();
  return tokenRepo;
}
export function getAdminRepo(): AdminRepo {
  if (!adminRepo) adminRepo = new AdminRepo();
  return adminRepo;
}
