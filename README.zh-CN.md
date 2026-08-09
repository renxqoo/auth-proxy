# auth-proxy

[![Build & Push Images](https://github.com/renxqoo/auth-proxy/actions/workflows/build.yml/badge.svg)](https://github.com/renxqoo/auth-proxy/actions/workflows/build.yml)
[![Deploy](https://github.com/renxqoo/auth-proxy/actions/workflows/deploy.yml/badge.svg)](https://github.com/renxqoo/auth-proxy/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-11-red.svg)](https://pnpm.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.zh-CN.md)

[English](./README.md) · **中文**

OAuth 2.0 设备授权流程鉴权中间层。签发 RS256 JWT 并代理转发到公司应用 —— **公司凭证永不离开中间层**。客户端只持有中间层签发的 JWT,公司 token(`ct_*`)始终留在内部。

```mermaid
flowchart LR
  Client["客户端<br/>(CLI / Agent)"]
  Server["server<br/>鉴权中间层"]
  Company["公司应用<br/>(company-mock / 真实)"]

  Client -- "① device flow 登录" --> Server
  Server -- "账号密码" --> Company

  Client -- "② /proxy/* 业务请求" --> Server
  Server -- "company_token 代理" --> Company
```

两条链路:**① 登录**(设备流程,客户端拿 JWT);**② 代理**(业务请求,server 代持公司 token 转发)。

---

## 目录

- [特性](#特性)
- [技术栈](#技术栈)
- [架构](#架构)
- [快速开始](#快速开始)
- [API 端点](#api-端点)
- [端到端流程](#端到端流程)
- [Admin 后台](#admin-后台)
- [部署](#部署)
- [运维](#运维)
- [安全设计](#安全设计)
- [开发](#开发)
- [真实公司应用接入](#真实公司应用接入)
- [贡献](#贡献)
- [License](#license)

## 特性

- 🔐 **设备授权流程(RFC 8628)** — 专为 CLI 和无头 agent 设计,客户端无需浏览器跳转。
- 🛡️ **公司凭证永不外泄** — 公司 token(`ct_*`)只存在于中间层内部,客户端拿到的是中间层签发的 JWT。
- 🔑 **JWT RS256,签名密钥可轮转** — 公钥发布在 `/.well-known/jwks.json`,私钥存 `signing_keys` 表。
- 🔄 **Refresh token 轮换 + 重用检测** — 旧 refresh 超过宽限窗口被复用 → 自动吊销 session。
- 🧮 **限流**(Redis 实现)— login 按 IP、`/token` 按 client、`/proxy` 按 session。
- 🛡️ **CSRF 防护**、scrypt 哈希存储 secret、生产配置校验、首个管理员强随机密码。
- 📊 **审计日志** — 登录记录(含 `[REUSE]` 重用事件)+ 每一次代理 API 调用。
- 🖥️ **Admin 管理后台**(Next.js)— 管理注册令牌、客户端、管理员,查看审计日志。
- 🐳 **一键部署** — `deploy.sh` 或 GitHub Actions CI/CD,GHCR 镜像分发。
- 🗄️ **自动化运维** — 每日 Postgres 备份 + 健康巡检 cron,部署时自动安装。

## 技术栈

| 层级 | 技术 |
|------|------|
| 中间层(`apps/server`) | [Hono](https://hono.dev) 4、[jose](https://github.com/panva/jose) 6(JWT/JWKS)、TypeScript 5 |
| 管理后台(`apps/admin-web`) | [Next.js](https://nextjs.org) 16、React 19、Tailwind CSS 4、shadcn/ui |
| 共享契约(`packages/shared`) | [zod](https://zod.dev) 4 |
| 数据库(`packages/db`) | PostgreSQL、[drizzle-orm](https://orm.drizzle.team) 0.44、drizzle 迁移 |
| 缓存 / 限流 / device_code 存储 | Redis |
| Monorepo | pnpm 11 workspaces + [Turborepo](https://turbo.build) 2 |
| Lint / 格式化 | oxlint + oxfmt |
| 测试 | Vitest |
| 部署 | Docker、docker-compose、nginx、GitHub Actions |

## 架构

基于 **pnpm workspaces + Turborepo** 的 monorepo。

| 包 | 作用 | 端口 |
|----|------|------|
| `packages/shared` | zod 契约 + 类型(各包共享) | — |
| `packages/db` | 数据库 schema(drizzle)+ 迁移 + 种子 | — |
| `apps/company-mock` | mock 公司应用(`/login` `/refresh` `/me` `/api/orders`) | 4000(内部) |
| `apps/server` | 鉴权中间层:device flow + 登录页 + JWT + gateway | 3000(内部) |
| `apps/admin-web` | Admin 管理后台(Next.js) | 3001(内部) |

**数据库表:** `signing_keys`、`apps`、`users`、`sessions`、`login_logs`、`api_logs`、`refresh_token_history`、`registration_tokens`、`admins`。

### 部署拓扑

只有 **nginx** 暴露 80 端口,其余服务全部在内部网络可见。

```
公网 :80 ──► nginx ──┬──► server:3000   (中间层 API + 登录页)
                    └──► admin-web:3001 (后台页面,/admin)
server ──► postgres / redis / company-mock(均为内部网络)
```

完整部署图与决策说明:[docs/docker](./docs/docker/README.md)。

## 快速开始

### 前置

- **Node 22+**、**pnpm 11**(corepack 自动启用)
- **Postgres**、**Redis**(本机已装,或用 `docker compose up -d postgres redis` 起这两个)

### 初始化

```bash
pnpm install

# 起 PG + Redis(本机已有则跳过)
docker compose up -d postgres redis

# 建库 + 迁移 + 种子(生成 RSA 密钥 + 首个管理员)
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

首个管理员账号由 seed 用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建。登录后台后可创建**注册令牌**发给客户端。

> **注意:**生产环境 seed **不创建任何 admin**(零默认,防弱口令)。首个管理员手动创建:`pnpm --filter @auth-proxy/db create-admin` 或 `docker compose exec server node packages/db/dist/scripts/create-admin.js`。

## API 端点

所有端点由中间层(`apps/server`)提供,根路径为 server 基址(如 `http://localhost:3000`)。

### OAuth 2.0 设备授权流程(RFC 8628)

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/register` | 动态客户端注册(返回 `client_id` + `client_secret`) |
| `POST` | `/device_authorization` | 申请设备码 → 返回 `device_code`、`user_code`、`verification_uri` |
| `POST` | `/token` | 轮询换 token(`grant_type=urn:ietf:params:oauth:grant-type:device_code`)或刷新(`grant_type=refresh_token`) |
| `GET` | `/verify` | 用户在浏览器打开的登录页(接受 `?user_code=`) |
| `POST` | `/verify/login` | 提交公司账号密码,授权该设备 |
| `GET` | `/user_info` | 查询当前 session 信息(Bearer access token) |
| `POST` | `/revoke` | 吊销 session/token |
| `GET` | `/.well-known/jwks.json` | JWT 公钥(RS256) |

### 代理网关

| 方法 | 路径 | 说明 |
|------|------|------|
| `ALL` | `/proxy/*` | 用存储的 company token 把任意请求转发到公司应用。去掉 `/proxy` 前缀;透传状态码 + body。 |

### Admin API(`/admin/web/*`)

session cookie 鉴权,供后台页面调用。包含 `/login`、`/logout`、`/me`、`/overview`、`/tokens`、`/apps`、`/audit/login`、`/audit/api`、`/admins`。详见 [`apps/server/src/routes/adminWeb.ts`](./apps/server/src/routes/adminWeb.ts)。

## 端到端流程

CLI/agent 如何完成认证并调用公司 API:

```
┌─────────┐                    ┌─────────┐                  ┌─────────────┐
│  客户端 │                    │ server  │                  │  公司应用   │
│ (CLI)   │                    │ (中间层)│                  │(mock/真实) │
└────┬────┘                    └────┬────┘                  └──────┬──────┘
     │  ① POST /register            │                              │
     │ ────────────────────────────►│                              │
     │  ◄── client_id, client_secret│                              │
     │                              │                              │
     │  ② POST /device_authorization│                              │
     │ ────────────────────────────►│                              │
     │  ◄── device_code, user_code, │                              │
     │      verification_uri        │                              │
     │                              │                              │
     │  ③ 浏览器打开 verification_uri│                              │
     │     登录 ────────────────────┼─────────────────────────────►│(账号密码)
     │                              │  ◄── company_token (ct_*) ───┤  永不离开中间层
     │                              │                              │
     │  ④ POST /token(轮询)        │                              │
     │ ────────────────────────────►│                              │
     │  ◄── access_token (JWT)      │                              │
     │      refresh_token           │                              │
     │                              │                              │
     │  ⑤ POST /proxy/api/orders    │                              │
     │      Authorization: Bearer … │                              │
     │ ────────────────────────────►│── company_token ────────────►│
     │                              │◄──────── 响应 ───────────────┤
     │  ◄── 200 + body(透传)       │                              │
```

最小客户端示例(HTTP),用 `/register` 拿到 `client_id` / `client_secret` 后:

```bash
# ① 申请设备码
curl -X POST http://localhost:3000/device_authorization \
  -u "$CLIENT_ID:$CLIENT_SECRET"

# → { "device_code":"…", "user_code":"ABCD-WXYZ",
#     "verification_uri":"http://localhost:3000/verify",
#     "verification_uri_complete":"http://localhost:3000/verify?user_code=ABCD-WXYZ",
#     "expires_in":600, "interval":5 }

# ② 用户在浏览器打开 verification_uri_complete 完成登录

# ③ 轮询换 token(遵守 `interval`,处理 authorization_pending / slow_down)
curl -X POST http://localhost:3000/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
  -d "device_code=$DEVICE_CODE"

# → { "access_token":"eyJ…", "token_type":"Bearer",
#     "expires_in":3600, "refresh_token":"…", "scope":"…" }

# ④ 经代理调用公司 API
curl http://localhost:3000/proxy/api/orders \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## Admin 后台

本地:`http://localhost:3001/admin` · 生产:`http://<server>/admin`

功能(账号密码登录 + session cookie 鉴权):

- **注册令牌**:创建(限时多次)/ 列出(含使用次数)/ 吊销
- **客户端**:列出所有动态注册的 client / 吊销 / 恢复
- **审计日志**:登录记录(成功/失败 + `[REUSE]` 重用事件)+ API 调用记录
- **管理员**:添加 / 删除(不能删自己)

## 部署

**日常部署走 GitHub Actions CI/CD**(推荐):

- push 到 `main` → [`.github/workflows/build.yml`](./.github/workflows/build.yml) 自动构建三个镜像推 GHCR。
- 手动触发 [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) 部署(SSH 到服务器拉最新镜像并重启)。需要配 Secrets:`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY`(`DEPLOY_PORT` 可选)。必填 input:`public_base_url`。

**应急手动部署**(仅在 CI/CD 不可用时使用,如 GitHub 故障):

```bash
PUBLIC_BASE_URL=http://公网IP SSH_HOST=服务器IP ./deploy.sh
RESTART_ONLY=1 SSH_HOST=服务器IP ./deploy.sh                              # 仅重启容器
FORCE_NEW_SECRETS=1 PUBLIC_BASE_URL=http://公网IP SSH_HOST=服务器IP ./deploy.sh  # 强制重新生成机器密钥
```

`deploy.sh` 先在本地预构建产物(避免低配服务器编译卡死),上传后服务器只装运行时依赖 + 拷产物(不跑编译)。

部署后:

- 中间层:`http://<server>/`
- Admin 后台:`http://<server>/admin/login`
- JWKS:`http://<server>/.well-known/jwks.json`

### 必需的环境变量

生产 `.env` 由 `deploy.sh` 首次部署自动生成,完整说明见 [`.env.example`](./.env.example)。

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | Postgres 连接串 |
| `REDIS_URL` | Redis 连接串(建议独立 db index,如 `/2`) |
| `ADMIN_SESSION_SECRET` | 后台 session cookie 签名密钥(≥32 字节,生产强制) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 首个管理员凭证(seed 仅在表空时创建一次) |
| `POSTGRES_PASSWORD` | 数据库密码 |
| `PUBLIC_BASE_URL` | 对外可访问地址(拼 `verification_uri`,防 host header 注入) |
| `COMPANY_API_BASE` | 公司应用基址(真实接入改这里) |

## 运维

`deploy.sh` 自动安装 cron(`/etc/cron.d/auth-proxy`):

- **每天 03:00** PG 备份 → `/opt/backups/postgres/`(保留 14 天)
- **每 5 分钟** 健康巡检 → 异常时调 webhook 告警(30 分钟去抖)

```bash
# 手动备份 / 恢复
/opt/auth-proxy/ops/backup.sh
/opt/auth-proxy/ops/restore.sh --list
/opt/auth-proxy/ops/restore.sh /opt/backups/postgres/auth-proxy_XXXXXXXX.sql

# 异地备份 + 告警(在 .env 配)
REMOTE_BACKUP_CMD="rclone copyto {} oss:auth-proxy-backup/{/}"
ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
```

完整运维指南(备份恢复、故障告警、日志、迁移、故障排查):[docs/docker/05-ops](./docs/docker/05-ops.md)。

## 安全设计

- **公司 token(`ct_*`)永不离开中间层** — 客户端只持有中间层签发的 JWT。
- **JWT RS256** — 签名密钥存 `signing_keys` 表,可轮转;公钥经 `/.well-known/jwks.json` 暴露。
- **access token 含 `aud`**(RFC 9068 §3)— 校验时必须匹配 audience,防 token confusion(跨资源服务器误用)。
- **`client_secret` scrypt 哈希存储**,非明文。
- **CSRF 防护** — `/verify/login` 双重提交 cookie。
- **Refresh token 轮换 + 重用检测** — 每次刷新签发新的 refresh token;旧 refresh 超 `REFRESH_REUSE_GRACE_SEC`(30s)再用 → 自动吊销 session。
- **Scope 授权边界(四层,OAuth 2.1)** — scope 授权动态存库,可经 admin 后台管理:
  - **层 1(全局定义):** scope 在 `scopes` 表定义(seed 默认:`orders:read`、`admin` 等);请求的 scope 必须存在 → 否则 `invalid_scope`。
  - **层 3(client 绑定):** 每个 client(`apps.allowed_scopes`)可限制为 scope 子集;空 = 允许全部(默认)。在 `/device_authorization` 强制。
  - **层 2(用户收窄):** 签发时请求的 scope 与用户实际权限(`user.scopes`)取交集;越权 → `invalid_scope`。
  - **层 4(gateway 路径策略):** gateway 转发前按 `route_policies`(路径模式 → 所需 scope)校验 token.scope,不满足 → `403 insufficient_scope`。**默认拒绝**:没配策略的路径直接 403(强制显式配置)。这是纵深防御:即使资源服务忘了查权限,gateway 也挡得住。
  - 系统 scope(`offline_access`、`company.api`)自动授予,豁免层 2、3。
- **限流** — login/verify 按 IP,`/token` 按 client,`/proxy` 按 session。
- **生产配置校验** — `assertProductionConfig()` 启动时拒绝弱 `ADMIN_SESSION_SECRET`。
- **首个管理员强制随机密码** — seed 不回退弱默认,由 `deploy.sh` 生成强随机值。
- **Host header 注入防护** — `verification_uri` 用可信的 `PUBLIC_BASE_URL` 拼接,绝不信任 `x-forwarded-host`。

详见 [docs/docker/04-config-secrets](./docs/docker/04-config-secrets.md)。发现安全漏洞?见 [SECURITY.zh-CN.md](./SECURITY.zh-CN.md)。

## 开发

```bash
pnpm install      # 装依赖
pnpm dev:all      # 起 mock + server(本地开发)
pnpm typecheck    # 全量类型检查
pnpm lint         # oxlint
pnpm build        # 全量构建
```

测试在 `apps/server/test`(Vitest):

```bash
pnpm --filter @auth-proxy/server test
```

测试账号(mock):

| 账号 | 密码 | 权限 |
|------|------|------|
| alice | alice123 | `orders:read` |
| bob | bob123 | (无,测权限边界) |

## 真实公司应用接入

真实公司应用可用时,**只改中间层**:

1. `COMPANY_API_BASE` 指向真实公司应用。
2. 若登录/刷新接口契约与 mock 不同,改 [`apps/server/src/companyAuth.ts`](./apps/server/src/companyAuth.ts)(中间层唯一接触公司应用的文件),做字段映射。

## 贡献

欢迎贡献!请阅读 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md) 了解开发配置、代码规范和 PR 流程。参与即代表同意遵守[行为准则](./CODE_OF_CONDUCT.md)。

版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE) © 2026 renxqoo
