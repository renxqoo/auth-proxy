import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 配置 —— 迁移生成。
 * 运行 `pnpm --filter @auth-proxy/db db:generate` 生成 SQL 迁移文件到 ./migrations。
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    // 迁移生成只读 schema,不需要真实连接;但 migrate 需要
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/auth-proxy",
  },
  verbose: true,
  strict: true,
});
