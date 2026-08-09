import { generateKeyPairSync, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { signingKeys, scopes, routePolicies } from "./schema.js";

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

  // 种子默认 scope 定义(对齐 company-mock 词汇表 + 中间层系统 scope)
  // onConflictDoNothing:重复 seed 不报错、不覆盖(已存在的保留)
  const defaultScopes = [
    { name: "offline_access", description: "中间层签发 refresh_token 所需", isSystem: true },
    { name: "company.api", description: "经 proxy 访问公司应用的聚合 scope", isSystem: true },
    { name: "orders:read", description: "读订单列表/详情", isSystem: false },
    { name: "orders:write", description: "下单/取消", isSystem: false },
    { name: "products:read", description: "读商品目录", isSystem: false },
    { name: "invoices:read", description: "读发票", isSystem: false },
    { name: "admin", description: "管理后台(用户列表等)", isSystem: false },
  ];
  for (const s of defaultScopes) {
    await db.insert(scopes).values(s).onConflictDoNothing();
  }
  console.log(`[db] ensured ${defaultScopes.length} default scopes`);

  // 种子默认路由策略(gateway 默认拒绝,故必须配齐 company-mock 现有接口)
  // pattern 是去掉 /proxy 前缀后的上游路径;scope=null 表示只需有效登录。
  // 用 pattern 做幂等键(重复 seed 不报错):先查再插
  const defaultPolicies = [
    { pattern: "/api/orders*", scope: "orders:read", method: "GET", description: "读订单列表/详情" },
    { pattern: "/api/products*", scope: "products:read", method: "GET", description: "读商品目录" },
    { pattern: "/api/invoices*", scope: "invoices:read", method: "GET", description: "读发票" },
    { pattern: "/api/admin/users", scope: "admin", method: "GET", description: "用户列表(管理员)" },
    { pattern: "/me", scope: null, method: "GET", description: "当前用户信息(只需登录)" },
    { pattern: "/api/profile", scope: null, method: "GET", description: "个人资料(只需登录)" },
  ];
  for (const p of defaultPolicies) {
    const exists = await db
      .select({ id: routePolicies.id })
      .from(routePolicies)
      .where(eq(routePolicies.pattern, p.pattern));
    if (exists.length === 0) {
      await db.insert(routePolicies).values(p);
    }
  }
  console.log(`[db] ensured ${defaultPolicies.length} default route policies`);

  await conn.end();
  console.log("[db] seed done ✓ (admin 账号需手动创建,见文件头注释)");
}

main().catch((e) => {
  console.error("[db] seed failed:", e);
  process.exit(1);
});
