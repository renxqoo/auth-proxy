import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { apps } from "@auth-proxy/db";
import { getDb } from "../infra.js";

/**
 * app 仓储 —— 查/管 OAuth client 凭据。
 *
 * client_secret 用 scrypt hash 存储(不落明文)。
 * 验证时用 timingSafeEqual 防 timing 攻击。
 * 吊销的 client(revoked=true)拒绝登录。
 */

/** scrypt hash 格式:<salt_hex>:<hash_hex>。 */
export function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** 校验明文 secret 是否匹配 hash。 */
export function verifySecret(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  // 必须显式校验非空:Buffer.from("zzzz","hex") 会静默返回空 buffer,
  // scryptSync(...,0) 也返回空 buffer,timingSafeEqual(空,空)=== true,
  // 会让畸形/被篡改的 stored 值通过任意密码 → 认证绕过。
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const hash = Buffer.from(hashHex, "hex");
    // 空盐/空哈希一律拒绝(防上面描述的零长绕过)
    if (salt.length === 0 || hash.length === 0) return false;
    const computed = scryptSync(plain, salt, hash.length);
    if (computed.length !== hash.length) return false;
    return timingSafeEqual(computed, hash);
  } catch {
    return false;
  }
}

export interface AppRecord {
  id: number;
  clientId: string;
  name: string;
  createdAt: Date;
  revoked: boolean;
  createdFromTokenId: number | null;
  lastUsedAt: Date | null;
  allowedScopes: string[]; // 该 client 允许请求的 scope;空 = 允许全部已定义
  redirectUris: string[]; // RFC 7591:允许的回调地址
  grantTypes: string[]; // RFC 7591:该 client 允许的 grant_type
  tokenEndpointAuthMethod: string; // RFC 7591:client 认证方式
}

/** client 查询的公共列(不含 secret)。list/findById/findByClientId 共用。 */
const APP_COLUMNS = {
  id: apps.id,
  clientId: apps.clientId,
  name: apps.name,
  createdAt: apps.createdAt,
  revoked: apps.revoked,
  createdFromTokenId: apps.createdFromTokenId,
  lastUsedAt: apps.lastUsedAt,
  allowedScopes: apps.allowedScopes,
  redirectUris: apps.redirectUris,
  grantTypes: apps.grantTypes,
  tokenEndpointAuthMethod: apps.tokenEndpointAuthMethod,
} as const;

export class AppRepo {
  /**
   * 校验 client 凭据;通过返回 clientId,否则 null。
   * 注:client 没有"吊销"状态 —— "踢下线"只吊销其 session,client 总能重新登录。
   * 要彻底禁用某 client,用 delete 删除它(之后 verifyClient 自然查不到)。
   */
  async verifyClient(
    clientId: string,
    clientSecret: string,
  ): Promise<string | null> {
    const db = getDb();
    const rows = await db
      .select({ clientSecret: apps.clientSecret })
      .from(apps)
      .where(eq(apps.clientId, clientId));
    if (rows.length === 0) return null;
    if (!verifySecret(clientSecret, rows[0]!.clientSecret)) return null;
    return clientId;
  }

  /** 创建 app(secret 自动 hash)。供 /register 和管理端点用。 */
  async create(params: {
    clientId: string;
    clientSecret: string;
    name: string;
    createdFromTokenId?: number;
    redirectUris?: string[];
    grantTypes?: string[];
    tokenEndpointAuthMethod?: string;
  }): Promise<void> {
    const db = getDb();
    await db.insert(apps).values({
      clientId: params.clientId,
      clientSecret: hashSecret(params.clientSecret),
      name: params.name,
      createdFromTokenId: params.createdFromTokenId ?? null,
      redirectUris: params.redirectUris ?? [],
      grantTypes: params.grantTypes ?? [],
      tokenEndpointAuthMethod: params.tokenEndpointAuthMethod ?? "client_secret_basic",
    });
  }

  /** 列出所有 client(不含 secret)。 */
  async list(): Promise<AppRecord[]> {
    const db = getDb();
    const rows = await db.select(APP_COLUMNS).from(apps).orderBy(apps.createdAt);
    return rows;
  }

  /** 按 id 查(取 createdFromTokenId 用)。 */
  async findById(id: number): Promise<AppRecord | null> {
    const db = getDb();
    const rows = await db.select(APP_COLUMNS).from(apps).where(eq(apps.id, id));
    return rows[0] ?? null;
  }

  /** 按 clientId 查(device_authorization 校验 client 级 scope 用)。 */
  async findByClientId(clientId: string): Promise<AppRecord | null> {
    const db = getDb();
    const rows = await db
      .select(APP_COLUMNS)
      .from(apps)
      .where(eq(apps.clientId, clientId));
    return rows[0] ?? null;
  }

  /** 吊销 / 恢复 client。 */
  async setRevoked(id: number, revoked: boolean): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(apps)
      .set({ revoked })
      .where(eq(apps.id, id))
      .returning({ id: apps.id });
    return rows.length > 0;
  }

  /** 设置 client 允许的 scope 子集(空数组 = 允许全部)。 */
  async setAllowedScopes(id: number, allowedScopes: string[]): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .update(apps)
      .set({ allowedScopes })
      .where(eq(apps.id, id))
      .returning({ id: apps.id });
    return rows.length > 0;
  }

  /** 删除 client。 */
  async delete(id: number): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .delete(apps)
      .where(eq(apps.id, id))
      .returning({ id: apps.id });
    return rows.length > 0;
  }

  /** 更新最后使用时间(登录成功时调,审计用)。 */
  async touchLastUsed(clientId: string): Promise<void> {
    const db = getDb();
    await db
      .update(apps)
      .set({ lastUsedAt: new Date() })
      .where(eq(apps.clientId, clientId));
  }
}
