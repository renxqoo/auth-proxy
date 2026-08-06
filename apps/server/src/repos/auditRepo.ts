import { desc, eq } from "drizzle-orm";
import { apiLogs, loginLogs } from "@auth-proxy/db";
import { getDb } from "../infra.js";
import { safeError } from "../config.js";

/**
 * 审计仓储 —— 写 + 查 login_logs / api_logs。
 *
 * 写失败只记 console,不抛(审计不能阻断主流程)。
 * 查询供 admin 后台用(分页 + 限制条数)。
 */

export class AuditRepo {
  // ---------- 写 ----------
  async writeLoginLog(params: {
    sessionId?: string;
    userCode: string;
    username: string;
    clientId: string;
    success: boolean;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    try {
      const db = getDb();
      await db.insert(loginLogs).values({
        sessionId: params.sessionId,
        userCode: params.userCode,
        username: params.username,
        clientId: params.clientId,
        success: params.success,
        ip: params.ip,
        userAgent: params.userAgent,
      });
    } catch (e) {
      safeError("[audit] writeLoginLog failed:", e);
    }
  }

  async writeApiLog(params: {
    sessionId: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
  }): Promise<void> {
    try {
      const db = getDb();
      await db.insert(apiLogs).values({
        sessionId: params.sessionId,
        method: params.method,
        path: params.path,
        status: params.status,
        durationMs: params.durationMs,
      });
    } catch (e) {
      safeError("[audit] writeApiLog failed:", e);
    }
  }

  // ---------- 查(后台用) ----------
  async recentLoginLogs(
    limit = 50,
  ): Promise<(typeof loginLogs.$inferSelect)[]> {
    const db = getDb();
    return db
      .select()
      .from(loginLogs)
      .orderBy(desc(loginLogs.createdAt))
      .limit(limit);
  }

  async recentApiLogs(limit = 50): Promise<(typeof apiLogs.$inferSelect)[]> {
    const db = getDb();
    return db
      .select()
      .from(apiLogs)
      .orderBy(desc(apiLogs.createdAt))
      .limit(limit);
  }

  /** 某令牌注册出的所有 client(审计:令牌使用情况)。 */
  async clientsByToken(
    tokenId: number,
  ): Promise<{ clientId: string; name: string; createdAt: Date }[]> {
    const db = getDb();
    const { apps } = await import("@auth-proxy/db");
    return db
      .select({
        clientId: apps.clientId,
        name: apps.name,
        createdAt: apps.createdAt,
      })
      .from(apps)
      .where(eq(apps.createdFromTokenId, tokenId))
      .orderBy(desc(apps.createdAt));
  }
}
