import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { admins, signingKeys } from "./schema.js";

/**
 * 种子数据:
 * - RS256 密钥对(若无 active 则生成一对)
 * - 首个管理员账号(若 admins 表空,用 ADMIN_USERNAME/ADMIN_PASSWORD 创建)
 *
 * 安全:ADMIN_USERNAME / ADMIN_PASSWORD 无默认 fallback。未设置则直接报错退出,
 * 避免任何环境(docker compose up / 本地裸跑)静默创建 admin/admin123 弱口令账号。
 * docker-compose.yml 用 ${VAR:?...} 强制要求 .env 提供;deploy.sh 首次部署随机生成。
 *
 * 注:不再 seed demo_app。所有 client 靠动态注册(POST /register + 注册令牌)。
 * 本地开发流程:seed → 打开 admin 后台创建注册令牌 → CLI register。
 *
 * 运行:DATABASE_URL=... pnpm --filter @auth-proxy/db seed
 */

/** scrypt hash:<salt_hex>:<hash_hex>。与 server/adminRepo 同格式。 */
function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function main() {
  const url =
    process.env.DATABASE_URL ?? "postgres://localhost:5432/auth-proxy";
  const conn = postgres(url, { max: 1 });
  const db = drizzle(conn);

  // 注:不再 seed demo_app。所有 client 靠动态注册(POST /register + 注册令牌)创建。
  // 本地开发:起 server 后,打开 admin 后台创建注册令牌,再 register。

  // 生成 RS256 密钥对(若 active 不存在)
  const activeKey = await db
    .select()
    .from(signingKeys)
    .where(eq(signingKeys.status, "active"));
  if (activeKey.length === 0) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString("utf8");
    const privatePem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString("utf8");
    await db.insert(signingKeys).values({
      kid: "key-" + randomBytes(6).toString("hex"),
      publicPem,
      privatePem,
      status: "active",
    });
    console.log("[db] generated RS256 signing key");
  } else {
    console.log("[db] active signing key exists, skip");
  }

  // 创建首个管理员(若 admins 表空)。
  // 无默认 fallback:未设置 ADMIN_USERNAME/PASSWORD 直接报错退出,
  // 绝不静默创建 admin/admin123 弱口令账号。
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  const existingAdmin = await db.select().from(admins).limit(1);
  if (existingAdmin.length === 0) {
    if (!adminUser || !adminPass) {
      throw new Error(
        "[db] admins 表为空且未设置 ADMIN_USERNAME/ADMIN_PASSWORD。" +
          "首次创建管理员必须显式提供凭证(生产由 deploy.sh 随机生成写入 .env)," +
          "不会回退到弱默认值。",
      );
    }
    if (adminPass.length < 8) {
      throw new Error(
        `[db] ADMIN_PASSWORD 长度不足(当前 ${adminPass.length},需 ≥8)。拒绝创建弱口令管理员。`,
      );
    }
    await db.insert(admins).values({
      username: adminUser,
      password: hashSecret(adminPass),
    });
    console.log(`[db] created initial admin: ${adminUser} (change ASAP)`);
  } else {
    console.log("[db] admin exists, skip");
  }

  await conn.end();
  console.log("[db] seed done ✓");
}

main().catch((e) => {
  console.error("[db] seed failed:", e);
  process.exit(1);
});
