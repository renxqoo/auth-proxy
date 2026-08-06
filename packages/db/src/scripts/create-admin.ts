import { randomBytes, scryptSync } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { admins } from "../schema.js";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * 手动创建/重置 admin 账号。
 *
 * 用途:
 *   - 全新部署后创建首个 admin(seed 不再创建任何 admin)
 *   - 忘记 admin 密码时重置
 *
 * 两种用法:
 *   A) 交互式(TTY,密码不回显、不进 history):
 *        docker compose exec server node packages/db/dist/scripts/create-admin.js
 *        username: <输入>   password: <输入>   confirm: <再输>
 *   B) 环境变量(自动化/非 TTY,如 CI 或 ssh 管道):
 *        docker compose exec -T \
 *          -e ADMIN_USERNAME=root -e ADMIN_PASSWORD='强随机' \
 *          server node packages/db/dist/scripts/create-admin.js
 *
 * 安全:
 *   - 零默认值。用户名/密码必须显式提供(stdin 或 env),绝不回退到弱口令。
 *   - 交互模式下密码从 stdin 隐藏读取,不进 shell history / 进程参数。
 *   - 密码 ≥ 8 字符,scrypt hash 存储(与 apps/server/adminRepo 同格式)。
 */

function hashSecret(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** 从 stdin 读密码(不回显)。回退环境下无法隐藏则明确警告。 */
async function readPassword(prompt: string): Promise<string> {
  // 关闭 TTY 回显(若 stdin 是 tty)
  const fd = (stdin as unknown as { fd?: number }).fd ?? 0;
  const wasRaw = stdin.isTTY ? stdin.isRaw : undefined;
  if (stdin.isTTY) {
    process.stdout.write(prompt);
    stdin.setRawMode(true);
  }
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  // 逐字符读,不输出回显
  let value = "";
  await new Promise<void>((resolve) => {
    stdin.resume();
    stdin.on("data", function onData(chunk: Buffer) {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve();
          return;
        }
        value += ch;
      }
    });
  });
  rl.close();
  void fd;
  return value;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未设置。用法:DATABASE_URL=... tsx src/scripts/create-admin.ts");
  }
  const conn = postgres(url, { max: 1 });
  const db = drizzle(conn);

  // 凭证来源优先级:env(自动化/管道) > 交互式 stdin(人工)
  // env 模式用于非 TTY 场景,如:
  //   docker compose exec -T -e ADMIN_USERNAME=x -e ADMIN_PASSWORD=y server \
  //     node packages/db/dist/scripts/create-admin.js
  let username = process.env.ADMIN_USERNAME ?? "";
  let password = process.env.ADMIN_PASSWORD ?? "";

  if (!username || !password) {
    // 交互式(需要 TTY)
    if (!stdin.isTTY) {
      throw new Error(
        "非交互环境且未设 ADMIN_USERNAME/ADMIN_PASSWORD env。请在 TTY 下运行,或用 env 传参。",
      );
    }
    const rl = readline.createInterface({ input: stdin, output: stdout });
    if (!username) {
      username = (await rl.question("username: ")).trim();
    }
    rl.close();
    if (!password) {
      password = await readPassword("password: ");
      const confirm = await readPassword("confirm:  ");
      if (password !== confirm) {
        await conn.end();
        throw new Error("两次输入的密码不一致");
      }
    }
  }

  if (!username) {
    await conn.end();
    throw new Error("用户名不能为空");
  }
  if (password.length < 8) {
    await conn.end();
    throw new Error(`密码长度不足(当前 ${password.length},需 ≥8)。拒绝创建弱口令管理员。`);
  }

  // upsert:存在则更新密码,不存在则创建
  const existing = await db.select().from(admins).where(eq(admins.username, username));
  if (existing.length > 0) {
    await db
      .update(admins)
      .set({ password: hashSecret(password) })
      .where(eq(admins.username, username));
    console.log(`[create-admin] 已重置 admin "${username}" 的密码`);
  } else {
    await db.insert(admins).values({ username, password: hashSecret(password) });
    console.log(`[create-admin] 已创建 admin "${username}"`);
  }

  await conn.end();
  console.log("[create-admin] done ✓");
}

main().catch((e) => {
  console.error("[create-admin] failed:", e.message ?? e);
  process.exit(1);
});
