import { randomBytes } from "node:crypto";
import type { CompanyUser } from "@auth-proxy/shared";

/**
 * 内存 token store —— mock 公司应用的会话状态。
 *
 * 设计要点:
 * - access/refresh token 都用 opaque 随机串(ct_/cr_ 前缀)。
 *   中间层绝不解析它们,只透传 + 刷新;真实公司 token 格式不可控时这条路径不变。
 * - refresh 一次性轮换:用掉即失效,签发新一对。模拟主流"refresh rotation"实现。
 * - 每 60s 清扫过期项,避免内存泄漏。
 */

const ACCESS_PREFIX = "ct_";
const REFRESH_PREFIX = "cr_";

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  user: CompanyUser;
  expiresAt: number; // unix ms
  refreshExpiresAt: number; // unix ms
}

class TokenStore {
  private byAccess = new Map<string, TokenRecord>();
  private byRefresh = new Map<string, TokenRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly accessTtlMs: number,
    private readonly refreshTtlMs: number,
  ) {
    // accessTtl 通常很短(测自动刷新);refresh 给宽裕窗口便于复测
    this.refreshTtlMs = Math.max(refreshTtlMs, accessTtlMs * 2);
  }

  /** 为已认证用户签发一对新 token。 */
  issue(user: CompanyUser): TokenRecord {
    const now = Date.now();
    const rec: TokenRecord = {
      accessToken: ACCESS_PREFIX + randomBytes(18).toString("hex"),
      refreshToken: REFRESH_PREFIX + randomBytes(18).toString("hex"),
      user,
      expiresAt: now + this.accessTtlMs,
      refreshExpiresAt: now + this.refreshTtlMs,
    };
    this.byAccess.set(rec.accessToken, rec);
    this.byRefresh.set(rec.refreshToken, rec);
    return rec;
  }

  /** access token 校验;返回记录或 null(无效/过期)。 */
  findByAccess(token: string | undefined): TokenRecord | null {
    if (!token) return null;
    const rec = this.byAccess.get(token);
    if (!rec) return null;
    if (Date.now() >= rec.expiresAt) return null; // 过期视为无效
    return rec;
  }

  /** refresh 校验 + 轮换:旧 refresh 失效,签发新一对。 */
  rotate(refreshToken: string): TokenRecord | null {
    const rec = this.byRefresh.get(refreshToken);
    if (!rec) return null;
    if (Date.now() >= rec.refreshExpiresAt) {
      this.purge(rec);
      return null;
    }
    // 一次性轮换:先删旧,再签新
    this.purge(rec);
    return this.issue(rec.user);
  }

  /** 吊销某用户全部 token(测 gateway "需重新登录"场景)。 */
  revokeByUser(userId: string): number {
    // 先收集再删,避免遍历时修改 map
    const victims: TokenRecord[] = [];
    for (const rec of this.byAccess.values()) {
      if (rec.user.id === userId) victims.push(rec);
    }
    for (const rec of victims) this.purge(rec);
    return victims.length;
  }

  startSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  private sweep(): void {
    const now = Date.now();
    // 先收集再删,避免遍历时修改 map
    const victims: TokenRecord[] = [];
    for (const rec of this.byAccess.values()) {
      if (now >= rec.refreshExpiresAt) victims.push(rec);
    }
    for (const rec of victims) this.purge(rec);
  }

  private purge(rec: TokenRecord): void {
    this.byAccess.delete(rec.accessToken);
    this.byRefresh.delete(rec.refreshToken);
  }
}

let store: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!store) {
    // TOKEN_TTL(秒)控制 access token 过期;默认 60s 便于测刷新。
    const ttlSec = Number(process.env.TOKEN_TTL ?? 60);
    store = new TokenStore(ttlSec * 1000, ttlSec * 1000 * 24); // refresh 宽 24 倍
    store.startSweep();
  }
  return store;
}
