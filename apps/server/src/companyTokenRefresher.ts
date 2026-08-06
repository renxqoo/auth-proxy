import { refreshWithCompany, CompanyAuthError } from "./companyAuth.js";
import { getRedis } from "./infra.js";
import {
  findSessionBySessionId,
  updateSessionCompanyToken,
} from "./sessionStore.js";

/**
 * company_token 刷新管理器 —— Redis 分布式锁(跨实例 singleflight)。
 *
 * 问题:并发多个请求(可能跨多个 server 实例)同时发现 company_token 过期,
 * 不能各自刷新(refresh 轮换后旧 token 立即失效)。
 *
 * 方案:用 Redis SETNX 抢锁,只有抢到的那个执行刷新,其余等结果。
 * 锁有 TTL 防止持有者崩溃导致死锁。
 */

// 提前刷新窗口:token 还剩这么久就主动刷
const REFRESH_AHEAD_MS = 30_000;
const LOCK_TTL_SEC = 30; // 刷新锁超时(防死锁)
const LOCK_WAIT_INTERVAL_MS = 100;
const LOCK_WAIT_TIMEOUT_MS = 10_000;

export class CompanyTokenRefresher {
  needsRefresh(expiresAtMs: number): boolean {
    return Date.now() + REFRESH_AHEAD_MS >= expiresAtMs;
  }

  /**
   * 确保 session 持有可用的 company access token。
   * 如需刷新则分布式单飞刷新。刷新失败抛 CompanyAuthError。
   */
  async ensureFresh(sessionId: string): Promise<string> {
    const session = await findSessionBySessionId(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    if (!this.needsRefresh(session.companyTokenExpiresAt)) {
      return session.companyAccessToken; // 仍有效
    }

    const lockKey = `refresh-lock:${sessionId}`;
    const redis = getRedis();

    // 尝试抢锁
    const acquired = await redis.set(lockKey, "1", "EX", LOCK_TTL_SEC, "NX");
    if (acquired) {
      // 抢到 → 执行刷新
      try {
        return await this.doRefresh(sessionId, session.companyRefreshToken);
      } finally {
        await redis.del(lockKey);
      }
    }

    // 没抢到 → 等持有者刷新完,重新读 session 拿新 token
    return this.waitForRefresh(sessionId);
  }

  private async doRefresh(
    sessionId: string,
    refreshToken: string,
  ): Promise<string> {
    const newToken = await refreshWithCompany(refreshToken);
    await updateSessionCompanyToken(sessionId, newToken);
    return newToken.access_token;
  }

  /** 等其它实例刷新完,轮询读 session 直到 token 更新或超时。 */
  private async waitForRefresh(sessionId: string): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < LOCK_WAIT_TIMEOUT_MS) {
      await sleep(LOCK_WAIT_INTERVAL_MS);
      const session = await findSessionBySessionId(sessionId);
      if (session && !this.needsRefresh(session.companyTokenExpiresAt)) {
        return session.companyAccessToken;
      }
    }
    throw new Error(`company token refresh timed out for session ${sessionId}`);
  }
}

let refresher: CompanyTokenRefresher | null = null;
export function getRefresher(): CompanyTokenRefresher {
  if (!refresher) refresher = new CompanyTokenRefresher();
  return refresher;
}

export { CompanyAuthError };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
