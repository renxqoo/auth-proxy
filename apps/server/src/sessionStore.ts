import { randomBytes } from "node:crypto";
import type { CompanyTokenResponse } from "@auth-proxy/shared";
import { getSessionRepo, type SessionData } from "./repos/index.js";

/**
 * sessionStore —— 对外 API 保留,内部委托 SessionRepo(PG 权威 + Redis 缓存)。
 * sessionId / refreshId 生成逻辑仍在此处。
 */

const SESSION_PREFIX = "sid_";
const REFRESH_PREFIX = "idrt_";

export type { SessionData };

export interface CreatedSession {
  sessionId: string;
  refreshId: string;
  data: SessionData;
}

/** 用户登录公司应用成功后创建会话。 */
export async function createSession(
  companyToken: CompanyTokenResponse,
  scope: string,
  clientId: string,
): Promise<CreatedSession> {
  const repo = getSessionRepo();
  const userId = await repo.upsertUser(companyToken.user);
  const sessionId = SESSION_PREFIX + randomBytes(16).toString("hex");
  const refreshId = REFRESH_PREFIX + randomBytes(16).toString("hex");
  const data = await repo.create({
    sessionId,
    refreshId,
    userId,
    clientId,
    companyUser: companyToken.user,
    companyToken,
    companyTokenExpiresAt: Date.now() + companyToken.expires_in * 1000,
    scope,
  });
  return { sessionId, refreshId, data };
}

export async function findSessionBySessionId(
  sessionId: string,
): Promise<SessionData | null> {
  return getSessionRepo().findBySession(sessionId);
}

export async function findSessionByRefreshId(
  refreshId: string,
): Promise<SessionData | null> {
  return getSessionRepo().findByRefresh(refreshId);
}

export async function updateSessionCompanyToken(
  sessionId: string,
  token: CompanyTokenResponse,
): Promise<void> {
  return getSessionRepo().updateCompanyToken(sessionId, token);
}

/** refresh 轮换:旧 refreshId 失效,签发新 refreshId;返回更新后的 session。 */
export async function rotateSessionRefresh(
  oldRefreshId: string,
): Promise<SessionData | null> {
  const newRefreshId = REFRESH_PREFIX + randomBytes(16).toString("hex");
  return getSessionRepo().rotateRefresh(oldRefreshId, newRefreshId);
}

export async function revokeSession(sessionId: string): Promise<void> {
  return getSessionRepo().revoke(sessionId);
}

/** 级联吊销某 client 的所有 session(client 吊销/删除时调)。 */
export async function revokeSessionsByClient(
  clientId: string,
): Promise<string[]> {
  return getSessionRepo().revokeByClient(clientId);
}

/** 记录 refresh 轮换(重用检测用)。 */
export async function recordRefreshRotation(
  sessionId: string,
  oldJti: string,
): Promise<void> {
  return getSessionRepo().recordRefreshRotation(sessionId, oldJti);
}

/** 查 refresh 历史(重用检测宽限判断)。 */
export async function findRefreshHistory(
  jti: string,
): Promise<{ sessionId: string; rotatedAt: Date } | null> {
  return getSessionRepo().findRefreshHistory(jti);
}
