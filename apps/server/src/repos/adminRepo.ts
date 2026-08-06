import { eq, count } from "drizzle-orm";
import { admins } from "@auth-proxy/db";
import { getDb } from "../infra.js";
import { hashSecret, verifySecret } from "./appRepo.js";

/**
 * admin 仓储 —— 后台管理员账号。
 * 密码用 scrypt hash(复用 appRepo 的 hashSecret/verifySecret)。
 */

export interface AdminRecord {
  id: number;
  username: string;
  createdAt: Date;
}

/**
 * 用户不存在时的 dummy scrypt 计算 —— 抹平 timing 侧信道。
 *
 * 安全动机:verifyPassword 原实现"用户不存在 → 立即返回 null",跳过 scrypt。
 * 攻击者通过响应时延差异(有 scrypt vs 无 scrypt,差几十到几百 ms)
 * 能枚举出哪些用户名存在,再针对性爆破。这是经典的 timing 枚举攻击。
 *
 * 修复:用户不存在时也跑一次等价工作量的 scrypt(用固定 dummy hash),
 * 使"不存在"和"密码错"两条路径的耗时基本一致。
 *
 * 注:dummy hash 是真实 hashSecret() 的输出格式,scrypt 参数与 verifySecret
 * 完全一致,耗时等价。dummy 值不会用于鉴权,只消耗 CPU。
 */
const DUMMY_STORED_HASH = hashSecret("dummy-password-for-constant-time");

export class AdminRepo {
  /** 按用户名查(含 password hash,登录校验用)。 */
  async findByUsername(username: string): Promise<{
    id: number;
    username: string;
    password: string;
    createdAt: Date;
  } | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(admins)
      .where(eq(admins.username, username));
    return rows[0] ?? null;
  }

  /** 校验密码;通过返回 AdminRecord(不含 password),否则 null。 */
  async verifyPassword(
    username: string,
    password: string,
  ): Promise<AdminRecord | null> {
    const row = await this.findByUsername(username);
    if (!row) {
      // 用户不存在:跑一次 dummy scrypt 抹平 timing(不短路返回)
      // 结果丢弃,只消耗与真实校验等量的时间
      verifySecret(password, DUMMY_STORED_HASH);
      return null;
    }
    if (!verifySecret(password, row.password)) return null;
    return { id: row.id, username: row.username, createdAt: row.createdAt };
  }

  /** 创建管理员(secret 自动 hash)。 */
  async create(params: {
    username: string;
    password: string;
  }): Promise<AdminRecord> {
    const db = getDb();
    const [row] = await db
      .insert(admins)
      .values({
        username: params.username,
        password: hashSecret(params.password),
      })
      .returning({
        id: admins.id,
        username: admins.username,
        createdAt: admins.createdAt,
      });
    return row!;
  }

  /** 列出所有管理员(不含 password)。 */
  async list(): Promise<AdminRecord[]> {
    const db = getDb();
    return db
      .select({
        id: admins.id,
        username: admins.username,
        createdAt: admins.createdAt,
      })
      .from(admins)
      .orderBy(admins.createdAt);
  }

  /** 删除管理员。 */
  async delete(id: number): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(admins)
      .where(eq(admins.id, id))
      .returning({ id: admins.id });
    return rows.length > 0;
  }

  /** 改密码。 */
  async setPassword(id: number, password: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(admins)
      .set({ password: hashSecret(password) })
      .where(eq(admins.id, id))
      .returning({ id: admins.id });
    return rows.length > 0;
  }

  /**
   * 管理员总数。用于删除时的"至少保留一个"保护。
   * 返回数值;空表返回 0。
   */
  async count(): Promise<number> {
    const db = getDb();
    const rows = await db.select({ count: count() }).from(admins);
    // drizzle pg 返回 count 为字符串(避免大数精度),显式 Number 化
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * 改用户名(不 hash)。唯一约束冲突由路由层 try/catch 捕获 → 转 409。
   * 返回 false 表示 id 不存在。
   */
  async setUsername(id: number, username: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(admins)
      .set({ username })
      .where(eq(admins.id, id))
      .returning({ id: admins.id });
    return rows.length > 0;
  }
}
