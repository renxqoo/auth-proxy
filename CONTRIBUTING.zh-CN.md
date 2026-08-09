# 为 auth-proxy 贡献代码

[English](./CONTRIBUTING.md) · **中文**

感谢你有兴趣为本项目做贡献!本指南涵盖开发配置、代码规范和 PR 流程。参与即代表同意遵守[行为准则](./CODE_OF_CONDUCT.md)。

## 前置条件

- **Node 22+**
- **pnpm 11**(通过 corepack 启用:`corepack enable`)
- **Postgres** + **Redis**(本机安装,或 `docker compose up -d postgres redis`)
- **Git**

## 开发配置

```bash
git clone https://github.com/renxqoo/auth-proxy.git
cd auth-proxy
pnpm install

# 起 PG + Redis
docker compose up -d postgres redis

# 建库 + 迁移 + 种子
createdb auth-proxy
DATABASE_URL=postgres://localhost:5432/auth-proxy pnpm --filter @auth-proxy/db migrate
DATABASE_URL=postgres://localhost:5432/auth-proxy \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=devpassword123 \
  pnpm --filter @auth-proxy/db seed

# 起 mock + 中间层
DATABASE_URL=postgres://localhost:5432/auth-proxy \
REDIS_URL=redis://localhost:6379/2 \
COMPANY_API_BASE=http://localhost:4000 \
ADMIN_SESSION_SECRET=dev_secret_change_me_at_least_32_bytes_long \
  pnpm dev:all
```

## 项目结构

```
apps/
  server/         中间层(Hono)— OAuth device flow、JWT、gateway、admin API
  admin-web/      管理后台(Next.js)
  company-mock/   mock 公司应用(仅开发用,不部署)
packages/
  shared/         zod 契约 + 共享类型
  db/             drizzle schema + 迁移 + 种子
docs/             部署与运维文档
ops/              备份 / 恢复 / 健康检查脚本
```

## 常用命令

```bash
pnpm typecheck    # 全量类型检查(提交前必跑)
pnpm lint         # oxlint
pnpm build        # 全量构建
pnpm --filter @auth-proxy/server test   # 跑 server 测试(Vitest)
```

## 代码规范

- **语言:** TypeScript(strict 模式,ESM)。不要随意用 `any`,确需时给出理由。
- **Lint / 格式化:** 使用 [oxlint](https://oxc.rs) + oxfmt,运行 `pnpm lint`。不要引入新的 lint 警告。
- **Commit 信息:** 使用 [Conventional Commits](https://www.conventionalcommits.org/)——`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` 等。标题控制在 72 字符以内。
- **注释:** 与周围代码的密度和风格保持一致。鼓励写"为什么"(安全取舍、边界情况)的注释;复述代码"做什么"的注释是噪音。

## Pull Request 流程

1. **先开 Issue**(小修复或文档改动除外)——避免方向不符导致白做工。
2. **从 `main` 拉分支**,命名要语义化,如 `fix/refresh-reuse-race` 或 `feat/add-jwks-cache`。
3. **保持 PR 聚焦** —— 一个 PR 一个逻辑改动。便于 review,也便于回滚。
4. **补充或更新测试**(改动行为时,在 `apps/server/test` 加测试)。涉及安全的改动应附回归测试。
5. **本地确保 CI 通过**后再 push:
   ```bash
   pnpm typecheck && pnpm lint && pnpm --filter @auth-proxy/server test
   ```
6. **填写 PR 模板**(改了什么 / 为什么 / 如何测试)。
7. **及时响应** review 反馈。

## 安全相关改动

这是认证项目,安全改动需要额外谨慎:

- 若改动涉及 token 处理、认证、session 管理或 gateway,**在 PR 中描述威胁模型**。
- 绝不打印 secret、token 或凭证。
- 优先用白名单而非黑名单(参考 gateway 响应头透传的实现)。
- 如果拿不准某事是否算漏洞,请走 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md) 流程,不要直接提公开 PR。

## 报告 Issue

- **Bug:** 用 bug issue 模板 —— 包含复现步骤、预期 vs 实际行为、环境信息(Node/pnpm/OS、server 版本)。
- **新功能:** 用 feature 模板,先讲清使用场景,而非只给解决方案。

## License

提交贡献即代表你同意这些贡献以 [MIT License](./LICENSE) 授权。

感谢你让 auth-proxy 变得更好!🚀
