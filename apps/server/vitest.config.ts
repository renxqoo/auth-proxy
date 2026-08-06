import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试环境:大部分是 node(纯函数/逻辑);Hono app 用 app.request()
    environment: "node",
    // 路由测试用 fake timers/并发,放宽默认 5s
    testTimeout: 15_000,
    // 测试入口
    include: ["test/**/*.test.ts"],
    // 在测试文件加载前预设 env(_setup 的 setEnv 必须先于 config.ts 的 import)
    setupFiles: ["./test/_setup.ts"],
    // 每个 case 隔离 module 状态(config 是按 import 时的 env 读的,需重置)
    isolate: true,
    // 清除 vi.mock 缓存,避免跨 case 污染
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});
