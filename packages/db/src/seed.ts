import { generateKeyPairSync, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { signingKeys } from "./schema.js";

/**
 * 种子数据:仅 RS256 密钥对(若无 active 则生成一对)。
 *
 * 不创建任何 admin 账号。首个管理员由部署者手动创建,避免代码/部署脚本里
 * 出现任何默认凭证(那会成为公开可利用的初始弱口令窗口)。
 *
 * 手动创建首个 admin 的方式(任选其一):
 *   A) 本地连库:
 *        docker compose exec postgres psql -U supercli -d supercli \
 *          -c "INSERT INTO admins (username, password) VALUES ('yourname', '<scrypt_hash>');"
 *        (scrypt hash 用 apps/server 的 hashSecret 生成,或用下面的 create-admin 脚本)
 *   B) 用独立脚本(见 packages/db/scripts/create-admin.ts):
 *        docker compose exec server node packages/db/dist/scripts/create-admin.js
 *
 * 注:不再 seed demo_app。所有 client 靠动态注册(POST /register + 注册令牌)。
 *
 * 运行:DATABASE_URL=... pnpm --filter @auth-proxy/db seed
 */

async function main() {
  const url =
    process.env.DATABASE_URL ?? "postgres://localhost:5432/auth-proxy";
  const conn = postgres(url, { max: 1 });
  const db = drizzle(conn);

  // 注:不再 seed demo_app。所有 client 靠动态注册(POST /register + 注册令牌)创建。

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

  await conn.end();
  console.log("[db] seed done ✓ (admin 账号需手动创建,见文件头注释)");
}

main().catch((e) => {
  console.error("[db] seed failed:", e);
  process.exit(1);
});
