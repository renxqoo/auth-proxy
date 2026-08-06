import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 应用迁移 —— 把 migrations 下的 SQL 执行到 PG。
 * 运行:DATABASE_URL=... pnpm --filter @auth-proxy/db migrate
 *
 * migrationsFolder 用基于本文件的绝对路径(不依赖 CWD),
 * 这样在 docker 里不管 WORKDIR 是什么都能找到。
 */
async function main() {
  const url =
    process.env.DATABASE_URL ?? "postgres://localhost:5432/auth-proxy";
  const conn = postgres(url, { max: 1 });
  const db = drizzle(conn);
  // dist/migrate.js → 同级的 ../migrations/(源码时 dist 不存在则用 ../migrations)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = join(__dirname, "..", "migrations");
  console.log("[db] running migrations from:", migrationsFolder);
  await migrate(db, { migrationsFolder });
  console.log("[db] migrations applied ✓");
  await conn.end();
}

main().catch((e) => {
  console.error("[db] migration failed:", e);
  process.exit(1);
});
