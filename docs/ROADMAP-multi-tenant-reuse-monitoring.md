# 演进路线:多租户基座 + Refresh 重用检测 + 连接池监控

> 本文档是**后续实现的参考蓝图**,记录已确认的设计决策与待实施细节。
> 当前代码库处于「单应用 + 持久化 + RS256 + 审计限流」阶段(已完成)。
> 本文描述在此基础上叠加的三项能力。
>
> ⚠️ **更新(2026-08)**:CLI 已拆为独立仓库 [renxqoo/rxcli](https://github.com/renxqoo/rxcli),不再在本仓库内。本文中涉及 `packages/cli/` 的部分(如多租户改造对 CLI 侧的影响)待结合独立 CLI 仓库重新规划,文中相关描述可能已过时。

---

## 目录

- [一、现状回顾(已实现)](#一现状回顾已实现)
- [二、待实现能力总览](#二待实现能力总览)
- [三、能力一:多租户基座(app_id 贯穿)](#三能力一多租户基座app_id-贯穿)
- [四、能力二:Refresh 重用检测自动吊销](#四能力二refresh-重用检测自动吊销)
- [五、能力三:连接池监控(仅日志告警)](#五能力三连接池监控仅日志告警)
- [六、分阶段实施计划](#六分阶段实施计划)
- [七、关键决策记录](#七关键决策记录)
- [八、风险与对策](#八风险与对策)
- [九、不在本期范围](#九不在本期范围)

---

## 一、现状回顾(已实现)

### 1.1 架构

```
CLI ──device flow──► server ──账号密码──► company-mock
CLI ──/proxy/*────► gateway ──company_token──► company-mock
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
       Postgres(权威)             Redis(缓存/临时)
       ├ sessions                  ├ session 缓存(5min TTL)
       ├ users                     ├ device_code(10min TTL)
       ├ apps(client凭据)          ├ refresh 单飞锁(SETNX)
       ├ signing_keys(RS256)       └ 限流计数(INCR+EXPIRE)
       ├ login_logs(审计)
       └ api_logs(审计)
```

### 1.2 当前数据库表结构(6 张)

| 表 | 用途 | 关键字段 |
|----|------|----------|
| `signing_keys` | JWT RS256 密钥(轮转) | kid, public_pem, private_pem, status(active/retired) |
| `apps` | OAuth client 凭据 | **client_id(unique), client_secret, name** |
| `users` | 可登录用户 | **company_user_id(全局 unique)**, name, scopes, last_login_at |
| `sessions` | 会话权威源(company_token 持有处) | session_id(unique), user_id(FK), refresh_id, company_access_token, company_refresh_token, company_token_expires_at, scope, revoked |
| `login_logs` | 登录审计 | session_id, user_code, username, client_id, success, ip, user_agent |
| `api_logs` | gateway 调用审计 | session_id, method, path, status, duration_ms |

**注**:`device_code` 不在 PG,是 Redis 临时状态(10min TTL)。

### 1.3 当前 server 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/device_authorization` | POST | 申请设备码(RFC 8628) |
| `/token` | POST | 换 token(device_code 轮询 / refresh 刷新) |
| `/user_info` | GET | 查当前用户 |
| `/revoke` | POST | 吊销 token(RFC 7007) |
| `/.well-known/jwks.json` | GET | 公钥集合(RFC 7517) |
| `/verify` | GET | 登录页 HTML |
| `/verify/login` | POST | 提交账号密码(浏览器) |
| `/proxy/*` | ALL | gateway 业务转发 |

### 1.4 当前 CLI 命令

```
auth-proxy auth login              # 设备流程登录
auth-proxy auth status             # 查登录状态
auth-proxy auth logout             # 退出(调 /revoke)
auth-proxy call <method> <path> [body]  # 经 gateway 调接口
auth-proxy config <key> [value]    # 查看/设置配置
```

### 1.5 当前 CLI 本地存储

- `~/.super-cli/config.json`:baseUrl / clientId / clientSecret(单份)
- `~/.super-cli/credentials.json`(0600):access_token / refresh_token / expires_at / scope / user(单份)

### 1.6 已具备的安全特性

- ✅ 账号密码只在浏览器↔中间层,CLI 不接触
- ✅ company_token 只存 PG sessions 表,不进 JWT,不离开中间层
- ✅ JWT RS256,私钥只在中间层;CLI 只持 sessionId
- ✅ 密钥轮转(signing_keys 表)
- ✅ /revoke 吊销 session
- ✅ 审计(login_logs + api_logs)
- ✅ 限流(verify/login 按 IP、/token 按 client、/proxy 按 session)
- ✅ company_token 刷新分布式锁(Redis SETNX)

---

## 二、待实现能力总览

| 能力 | 性质 | 改造量 | 依赖 |
|------|------|--------|------|
| **多租户基座** | 架构级(app_id 贯穿) | 大 | — |
| **Refresh 重用检测** | 安全加固 | 中 | 依赖多租户(app_id 维度) |
| **连接池监控** | 运维加固 | 小 | 依赖多租户(日志带 app 上下文) |

**关键耦合**:三项都受 `app_id` 影响。多租户要求 app_id 贯穿所有表;重用检测的"吊销"必须带 app_id(否则 A 应用泄露波及 B);监控日志要带 app_id。**因此 schema 改动一次性规划(一个迁移),功能分阶段实现**。

**执行顺序**:多租户基座 → 重用检测 → 监控。

---

## 三、能力一:多租户基座(app_id 贯穿)

### 3.1 目标

中间层服务 **N 个独立公司应用**,每个有自己的:
- baseURL(`company_api_base`)
- OAuth client 凭据(client_id / client_secret)
- 用户目录(同一个公司用户 id 在不同 app 是不同记录)
- 登录态隔离

像 Auth0 那样"一个中间层管多个应用",CLI 用 `--app` 切换。

### 3.2 关键决策(已确认)

| 项 | 决策 |
|----|------|
| 多租户含义 | A — 多个独立公司应用 |
| 登录契约 | 统一账号密码(companyAuth 只是 baseURL 不同,**不抽象成可插拔**) |
| CLI 凭证 | 多 app 多凭证,`--app` 选当前默认 |
| 应用管理 | 运行时动态:`auth-proxy app add/list/remove` + server 端点 |
| 默认 app | 保留(seed `default`),向后兼容 |

### 3.3 Schema 迁移(新增迁移 0001)

#### 3.3.1 `apps` 表扩展

```sql
ALTER TABLE apps
  ADD COLUMN company_api_base text NOT NULL DEFAULT 'http://localhost:4000',
  ADD COLUMN default_scopes   text[] NOT NULL DEFAULT '{}';
```

#### 3.3.2 给表加 `app_id`(users / sessions / login_logs / api_logs)

```sql
-- 假设 default app 的 id = 1(seed 写入后的 id)
ALTER TABLE users      ADD COLUMN app_id bigint NOT NULL REFERENCES apps(id) DEFAULT 1;
ALTER TABLE sessions   ADD COLUMN app_id bigint NOT NULL REFERENCES apps(id) DEFAULT 1;
ALTER TABLE login_logs ADD COLUMN app_id bigint NOT NULL REFERENCES apps(id) DEFAULT 1;
ALTER TABLE api_logs   ADD COLUMN app_id bigint REFERENCES apps(id);  -- 可空(便于历史)

-- users 唯一键改造:全局 unique → 复合 unique
ALTER TABLE users DROP CONSTRAINT users_company_user_id_unique;
ALTER TABLE users ADD CONSTRAINT users_app_id_company_user_id_unique
  UNIQUE (app_id, company_user_id);
```

**关键**:`users.company_user_id` 当前全局 unique。多租户后同一个人在 A/B app 是不同记录,必须改成 `(app_id, company_user_id)` 复合唯一。否则第二个 app 登录同一个人会冲突。

#### 3.3.3 数据迁移

- 给 `default` app 补 `company_api_base = http://localhost:4000`
- 历史记录 `app_id` 回填为 default app 的 id(NOT NULL 约束需要)
- **开发库可清空重建**,不做复杂回填脚本

#### 3.3.4 drizzle schema 改动

`auth-proxy/packages/db/src/schema.ts`:
- `apps` 加 `companyApiBase` / `defaultScopes` 字段
- `users` / `sessions` / `loginLogs` / `apiLogs` 加 `appId` 字段 + 关系定义
- `users` 的 unique 从 `companyUserId` 改为 `(appId, companyUserId)` 复合

### 3.4 后端改造

#### 3.4.1 `appRepo` 扩展(`repos/appRepo.ts`)

```ts
class AppRepo {
  verifyClient(clientId, clientSecret): Promise<AppRecord | null>  // 返回完整记录,不只 clientId
  findById(id): Promise<AppRecord | null>
  findByClientId(cid): Promise<AppRecord | null>
  list(): Promise<AppRecord[]>
  create(params): Promise<AppRecord>
  remove(clientId): Promise<void>
}
```

#### 3.4.2 `sessionRepo` / `companyAuth` / `gateway` 带 app_id

- `upsertUser(appId, companyUser)` —— 复合唯一键
- `sessionRepo.create(...)` 带 appId
- `companyAuth.loginWithCompany(app, creds)` / `refreshWithCompany(app, token)` —— baseURL 从 app 取
- `gateway` 转发目标从 `session.appId → app.companyApiBase` 动态(不再用全局 `config.companyApiBase`)
- `deviceCodeStore`:`DeviceCodeRecord` 加 `appId`(`createDeviceCode` 带 app)

#### 3.4.3 `verifyClient` / token / device_authorization 贯穿 app

- `verifyClient` 返回 app 记录(含 company_api_base、default_scopes)
- `device_authorization` 创建 device_code 时绑定 app(从 verifyClient 结果)
- `token` 签发时 scope 合并 `app.defaultScopes`

#### 3.4.4 配置清理

- 删除 `config.companyApiBase`(改从 app 记录读)
- 保留 `DATABASE_URL` / `REDIS_URL` / JWT 配置 / 限流配置

### 3.5 app 管理端点(server)

| 端点 | 方法 | 用途 |
|------|------|------|
| `/apps` | POST | 创建 app |
| `/apps` | GET | 列出所有 app |
| `/apps/:clientId` | DELETE | 删除 app |

### 3.6 CLI app 命令 + --app 选项

```bash
auth-proxy app add --client-id app2 --client-secret s2 --name "App 2" --api-base http://localhost:4001
auth-proxy app list
auth-proxy app remove <clientId>

auth-proxy --app app2 auth login      # 登录 app2
auth-proxy --app app2 call GET /api/orders
auth-proxy --app default auth status  # 凭证隔离,互不影响
```

#### CLI 凭证存储结构改造

`~/.super-cli/credentials.json` 从单份改为按 app 分:

```json
{
  "currentApp": "default",
  "apps": {
    "default": {
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": 1234567890,
      "scope": "...",
      "user": { "open_id": "u_alice", "name": "Alice" }
    },
    "app2": { ... }
  }
}
```

`config.json` 也按 app 存 clientId/clientSecret 列表,或仍用全局 + per-app 覆盖。

---

## 四、能力二:Refresh 重用检测自动吊销

### 4.1 背景与威胁

当前 refresh rotation:轮换时用新 refreshId **覆盖**旧的。旧 refresh 再用会查不到 session → 返回 `invalid_grant`。但这**无法区分两种情况**:

- **情况 A**:refresh token 是瞎编的/从未存在 → 正常错误,返回 invalid_grant 即可
- **情况 B**:refresh token **曾经有效、已被轮换过** → 意味着 **token 泄露**(有人复制了一份),应**立刻吊销整个 session 的所有 token**,强制重新登录

不做 B 的话:攻击者偷到的旧 refresh token 虽然换不到新 token,但**不会触发任何警报**,系统无法察觉泄露。

### 4.2 关键难点:误报 → CLI 协调

CLI 的 `callViaGateway` 在 401 时会自动 refresh。**两个并发请求同时 401** 会导致:

```
请求1 (401) → 用 refresh_X 换 token → 成功,refresh_X 轮换成 refresh_Y
请求2 (401) → 也用 refresh_X(它本地还存着旧的)→ 重用!→ 触发吊销
```

结果:正常用户因为并发被强制登出。这是误报。

### 4.3 方案:CLI 锁 + 中间层宽限窗口(双保险)

#### 4.3.1 CLI 端 singleflight(进程内锁)

`packages/cli/src/api.ts` 的 `callViaGateway` 改造:

```ts
// 进程内 Map:同一 session 并发 401 时,只发一次 refresh
const refreshInflight = new Map<string, Promise<TokenInfo>>();

async function callViaGateway(...) {
  // ... 401 时
  const existing = refreshInflight.get(sessionKey);
  if (existing) return doCall((await existing).access_token);

  const p = refreshAccessToken(...).finally(() => refreshInflight.delete(sessionKey));
  refreshInflight.set(sessionKey, p);
  return doCall((await p).access_token);
}
```

**局限**:只防单进程内并发;跨 CLI 进程(多终端同一用户)仍可能冲突,由中间层宽限窗口兜底。

#### 4.3.2 中间层 30s 宽限窗口

`server/src/routes/token.ts` 的 `handleRefreshGrant` 改造:

```
1. 验 refresh token → claims(jti)
2. 查 sessions where refresh_id = jti 且未吊销
   - 找到 → 正常轮换:
       a. 旧 jti 写入 refresh_token_history
       b. 更新 sessions.refresh_id 为新 jti
3. 找不到(已被轮换/不存在):
   - 查 refresh_token_history where refresh_jti = jti
     - 找到且 rotated_at 在 30s 内 → 宽限:返回当前活跃 token(容忍并发/重试)
     - 找到且超过 30s → 重用!吊销该 session,记 login_logs 为安全事件,返回 invalid_grant
     - 没找到 → 纯无效 token,返回 invalid_grant(不吊销)
```

### 4.4 新增表:`refresh_token_history`

```sql
CREATE TABLE refresh_token_history (
  id          bigserial PRIMARY KEY,
  app_id      bigint NOT NULL REFERENCES apps(id),
  session_id  text NOT NULL,        -- 关联 session(即使 session 被吊销也保留)
  refresh_jti text NOT NULL,        -- 曾用过的 refresh jti
  rotated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, refresh_jti)      -- 一个 jti 只轮换一次
);
CREATE INDEX idx_refresh_history_jti ON refresh_token_history(refresh_jti);
```

**为什么带 app_id**:重用检测的吊销必须限定在 app 维度,否则 A 应用的泄露会波及 B 应用。`UNIQUE(app_id, refresh_jti)` 保证同 app 内 jti 唯一。

### 4.5 sessionRepo 新增方法

```ts
class SessionRepo {
  // 轮换时记录历史
  recordRefreshRotation(appId, sessionId, oldJti): Promise<void>
  // 查历史(宽限判断 + 重用检测)
  findRefreshHistory(appId, jti): Promise<{ sessionId, rotatedAt } | null>
  // 重用检测触发:吊销 session
  revokeByReuse(sessionId): Promise<void>
}
```

### 4.6 安全事件记录

重用检测触发时,写入 `login_logs`:
- `success = false`
- `username` 字段记 `[REUSE]` 前缀(如 `[REUSE] alice`),便于检索区分
- 或后续加 `event_type` 字段(本期用前缀方案,避免再加字段)

### 4.7 关键决策(已确认)

| 项 | 决策 |
|----|------|
| 误报对策 | CLI 锁 + 30s 宽限窗口(双保险) |
| 重用动作 | 吊销 session + 记安全事件(login_logs) |
| 宽限窗口长度 | 30s |

---

## 五、能力三:连接池监控(仅日志告警)

### 5.1 监控对象

只做**应用侧连接池**监控,不引入 Prometheus/Grafana 运维栈。

| 监控对象 | 看什么 |
|----------|--------|
| postgres.js 连接池(max=10) | active/idle/queued 连接数、是否有请求等池 |

### 5.2 实现(`server/src/infra.ts`)

postgres.js 返回的 client 有 `.stats` 字段。定时采样:

```ts
// infra.ts
const queryClient = postgres(connStr, { max: 10 });

// 每 30s 采样
setInterval(() => {
  const s = queryClient.stats;  // { active, idle, waiting_count }
  if (s.waiting_count > 0) {
    console.error(`[db] pool exhausted: ${s.active}/${max} active, ${s.waiting_count} waiting`);
  } else if (s.active >= max * 0.8) {
    console.warn(`[db] pool near limit: ${s.active}/${max} active`);
  }
}, 30_000).unref();
```

### 5.3 慢查询/错误日志

- postgres.js `onnotice` 回调 → console.warn
- 连接错误 → console.error,带 app 上下文(多租户后日志要能定位是哪个 app)

### 5.4 关键决策(已确认)

| 项 | 决策 |
|----|------|
| 监控层级 | 仅应用侧池探针 |
| 告警通道 | 仅日志(靠现有日志系统告警) |
| 是否引入 Prometheus | 否 |

---

## 六、分阶段实施计划

**每阶段独立可验证,通过后再进下一阶段。**

### Phase A — Schema 迁移 + 多租户数据模型

**产出**:
- 迁移 0001:apps 扩字段、5 表加 app_id、新增 refresh_token_history、users 复合唯一键
- seed 更新:default app 带 company_api_base
- db 包 schema/types 更新

**验证**:
```bash
pnpm --filter @auth-proxy/db migrate
pnpm --filter @auth-proxy/db seed
# psql 检查:
#   \d apps → 有 company_api_base, default_scopes
#   \d users → 唯一约束是 (app_id, company_user_id)
#   \d refresh_token_history → 存在,UNIQUE(app_id, refresh_jti)
```

---

### Phase B — 后端 app 维度贯穿

**产出**:
- appRepo 扩展(findById/list/create/remove)
- sessionRepo/companyAuth/deviceCodeStore/gateway 全部带 appId
- verifyClient 返回 app 记录
- 配置清理:删 `config.companyApiBase`

**验证**:
```bash
# 登录 default app,全流程通(回归测试)
# 手动插第二个 app(company_api_base 指向另一个 mock 实例)
# 登录后 gateway 转发到对应实例
# psql 查 sessions.app_id 正确区分
```

---

### Phase C — app 管理端点 + CLI app 命令 + CLI --app

**产出**:
- server:`POST/GET/DELETE /apps`
- CLI:`auth-proxy app add/list/remove`
- CLI `auth login/call --app <clientId>`
- CLI credentials.json 改多 app 结构

**验证**:
```bash
auth-proxy app add --client-id app2 --client-secret s2 --name "App 2" --api-base http://localhost:4001
auth-proxy app list                  # default, app2
auth-proxy --app app2 auth login     # 登录 app2
auth-proxy --app app2 call GET /api/orders
auth-proxy --app default auth status # 仍登录 default(凭证隔离)
```

---

### Phase D — Refresh 重用检测

**产出**:
- token.ts handleRefreshGrant 改造(查 history + 30s 宽限 + 吊销)
- sessionRepo:recordRefreshRotation / findRefreshHistory / revokeByReuse
- CLI api.ts:refresh singleflight(进程内锁)

**验证**:
```bash
# 正常刷新:连续 refresh 不误报
# 并发 401(CLI 内):singleflight 保证只刷一次
# 模拟重用:用 30s 前的旧 refresh → session 被吊销,login_logs 记 [REUSE] 事件
# 宽限窗口内(30s 内)旧 refresh → 返回当前 token(不吊销)
```

---

### Phase E — 连接池监控日志 + 收尾

**产出**:
- infra.ts 连接池统计采样 + 阈值日志
- 慢查询/错误日志带 app 上下文
- README / .env.example 更新(多 app 配置、app 管理、重用检测说明)
- 全量 typecheck/lint/format/build 复核
- E2E:多 app 隔离 + 重用检测触发 + 日志可见

**验证**:
```bash
# 压一批并发请求,日志无连接池告警(正常)
# 制造池耗尽(调小 max),日志出现 warn
# 全链路:app add → login app2 → call → logout;重用检测端到端
```

---

## 七、关键决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 多租户含义 | A(多个独立公司应用) | 业务需要中间层服务多个公司应用 |
| 登录契约 | 统一账号密码 | 当前所有 app 都是账号密码,companyAuth 无需抽象 |
| CLI 凭证 | 多 app 多凭证 + `--app` | 运维需同时管理多个应用 |
| 应用管理 | 运行时动态 + CLI 命令 | 增减 app 不需改代码/重启 |
| 默认 app | 保留 default | 向后兼容,现有流程不中断 |
| 重用检测误报对策 | CLI 锁 + 30s 宽限窗口 | 双保险,既防单进程并发又防跨进程冲突 |
| 重用动作 | 吊销 session + 记事件 | 标准做法,泄露即强制重登 |
| 连接池监控 | 仅日志告警 | 不引入运维栈,保持部署轻量 |
| schema 改动 | 一次性迁移(0001) | 三能力都受 app_id 影响,避免反复改表 |

---

## 八、风险与对策

| 风险 | 对策 |
|------|------|
| app_id 漏加导致串数据 | 所有查询强制带 app_id 过滤;repo 层封装,路由不直接拼 SQL |
| users 唯一键改造破坏现有数据 | 开发库清空重建;生产需回填脚本(本期不涉及) |
| 重用检测误报踢正常用户 | CLI singleflight + 30s 宽限窗口双保险 |
| 迁移失败 | drizzle generate 后先 review SQL,再 migrate |
| 多 app 凭证文件结构改动 | 向后兼容:读到旧格式(无 apps 字段)自动迁移到 default |

---

## 九、不在本期范围

- ❌ 可插拔登录方式(账号密码/OAuth/SSO 按应用不同)—— 当前统一账号密码
- ❌ 审计日志检索 UI
- ❌ Prometheus/Grafana 监控栈
- ❌ app 级别的 JWT 密钥隔离(当前全局 signing_keys)
- ❌ app 级别限流配额(当前限流配置全局)
- ❌ refresh token 重用的 webhook/邮件通知(当前仅记 login_logs)

---

## 附录:当前文件清单(改造时参考)

```
auth-proxy/packages/
├── db/src/
│   ├── schema.ts          ★ 加 app_id 字段 + refresh_token_history 表
│   ├── client.ts          (不变)
│   ├── migrate.ts         (新增迁移执行)
│   └── seed.ts            ★ default app 带 company_api_base
└── server/src/
    ├── config.ts          ★ 删 companyApiBase
    ├── infra.ts           ★ 加连接池监控采样
    ├── oauthHelpers.ts    ★ verifyClient 返回 app 记录
    ├── companyAuth.ts     ★ loginWithCompany/refresh 带 app 参数
    ├── sessionStore.ts    (薄封装,跟随 repo)
    ├── deviceCodeStore.ts ★ DeviceCodeRecord 加 appId
    ├── companyTokenRefresher.ts (不变,从 session 读 app)
    ├── jwt.ts             (不变)
    ├── repos/
    │   ├── appRepo.ts        ★ 扩展 findById/list/create/remove
    │   ├── sessionRepo.ts    ★ 带 appId + 重用检测方法
    │   ├── deviceCodeRepo.ts (不变)
    │   ├── signingKeyRepo.ts (不变)
    │   └── auditRepo.ts      (不变)
    ├── middleware/rateLimit.ts (不变)
    └── routes/
        ├── deviceAuthorization.ts  ★ 带 app(从 verifyClient)
        ├── token.ts                ★ handleRefreshGrant 加重用检测
        ├── verify.ts               (不变,审计已带)
        ├── userInfo.ts             (不变)
        ├── gateway.ts              ★ 转发目标从 session.appId 动态
        ├── jwks.ts                 (不变)
        ├── revoke.ts               (不变)
        └── apps.ts                 ★ 新增(POST/GET/DELETE /apps)

packages/cli/src/
├── config.ts             ★ credentials 改多 app 结构
├── api.ts                ★ refresh singleflight + revoke/app 端点
├── index.ts              ★ 全局 --app 选项
└── commands/
    ├── auth.ts           (不变,跟随 --app)
    ├── call.ts           (不变,跟随 --app)
    ├── config.ts         (不变)
    └── app.ts            ★ 新增(add/list/remove)
```
