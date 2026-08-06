# 04 · 配置与密钥管理

> 这一章是单机部署和企业级部署的**分水岭**。配置怎么管、密钥放哪、初始化凭证怎么处理——做对了是基本功,做错了是安全事故。auth-proxy 在这块踩过坑也做了加固,全部记录在此。

## 1. 配置外置原则

### 铁律:容器只读,配置从外部注入

```
配置的单一可信源(git / .env / Secrets Manager)
        │ 部署时注入(declare)
        ▼
容器(只读镜像 + 注入的配置,随时可重建)
```

**绝不应该手动进容器改配置文件。** 一旦这么做:

### 坑:进容器改配置

**【坑】手改容器内的文件**
```
docker exec -it server sh
vi /app/config.js   # 改了个值
```
后果:
1. **重建就丢**——任何 `docker compose up --build`、镜像更新、OOM 重启触发容器重建,改动全没,且无告警
2. **无法审计**——三个月后没人记得改过啥,没有 git 历史
3. **环境漂移**——dev/prod 配置不一致,排查地狱
4. **不可重现**——换台机器部署,配置和现在不一样

**正解**:改配置源(`.env` / compose 文件 / git)→ 重新部署。auth-proxy 的设计就是这样:改 `.env` 或 compose → `docker compose up -d` 重建。详见 [05 部署流程](./05-ops.md#5-一键部署流程解读)。

## 2. 环境变量分层

### 两类:非敏感配置 vs 敏感密钥

| 类别 | 例子 | 能否进 git | 能否进镜像 |
|------|------|-----------|-----------|
| **非敏感配置** | 端口、DB host、限流阈值、特性开关 | ✅ 可以 | ✅ 可以(但通常也不进) |
| **敏感密钥** | 密码、session secret、加密 key、API token | ❌ 绝不 | ❌ 绝不 |

auth-proxy 用 `.env`(gitignore 排除)+ `.env.example`(占位值,进 git)分离两者。

### 项目实例:三种 compose env 语法

`docker-compose.yml` 里用了三种 `${}` 语法,语义不同:

```yaml
# 1. ${VAR:-default} —— 有默认值,不设也行
POSTGRES_USER: ${POSTGRES_USER:-auth-proxy}          # 第14行:不设就用 auth-proxy

# 2. ${VAR:?msg} —— 强制必填,不设就拒绝启动(防弱默认)
ADMIN_SESSION_SECRET: ${ADMIN_SESSION_SECRET:?must be set}  # 第114行:缺失直接报错
ADMIN_USERNAME: ${ADMIN_USERNAME:?must be set}              # 第74行

# 3. ${VAR:-default} 用于带合理默认的
PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-http://<your-server-ip>}   # 第116行
```

**设计原则**:
- 有安全默认值且不敏感的 → `${VAR:-default}`(便利)
- 涉及安全的密钥 → `${VAR:?...}` 强制(绝不允许"忘了设就用弱默认")

### 坑

**【坑】密钥用 :- 给了个弱默认**
```yaml
ADMIN_PASSWORD: ${ADMIN_PASSWORD:-admin123}   # ❌ 忘了设 .env 就用 admin123
```
任何一次部署忘了设,就静默创建弱口令账号。必须用 `:?` 强制。auth-proxy 早期就是这个坑,后来改成 `:?`(见下文第 4 节)。

## 3. 密钥管理演进路径(四级)

### 从最弱到最强

| 级别 | 做法 | 风险 | 适用规模 |
|------|------|------|---------|
| **L1 明文 .env** | 密钥明文写服务器 .env 文件 | 服务器失窃/攻破=全泄 | 单机/内网 |
| **L2 SOPS 加密进 git** | .env 用 age 加密成 .env.enc 进 git,服务器解密 | 私钥泄露=全泄,但有审计 | **中小企业(推荐 auth-proxy 下一步)** |
| **L3 Docker/K8s Secret** | 编排系统加密存储(etcd 加密/ docker secret) | 比 L2 集中,可轮换 | 容器化生产 |
| **L4 Vault 运行时注入** | 密钥不落盘,应用启动时从 Vault 拉,只进内存 | 最高,可动态生成、自动轮换 | 云原生/企业级 |

### auth-proxy 现状:L1

当前 `.env` 明文落在服务器 `/opt/auth-proxy/`(权限 600),由 `deploy.sh` 生成。这是 L1。

**风险**:服务器被攻破或磁盘镜像泄露,所有密钥暴露。

**缓解措施(已做)**:
- `.env` 在 `.dockerignore` 和 `.gitignore` 双重排除,不进镜像不进 git
- compose 用 `${VAR:?}` 强制要求,不会用弱默认
- `deploy.sh` 生成强随机值(openssl rand)
- server 启动时 `assertProductionConfig()` 校验弱密钥并拒绝启动

**下一步:L2(SOPS)** —— 把 .env 用 SOPS+age 加密成 .env.enc 进 git,服务器只放 age 私钥。零代码改动,纯运维流程升级。这是性价比最高的一步。

## 4. 初始化超管/密码处理(踩坑重点)

这是 auth-proxy 改造中花最多精力的一块。初始化第一个管理员账号——这个看似简单的问题,藏着大坑。

### 五种范式对比

按"初始密码流转面"(经过多少地方)从安全到危险排序:

| # | 方式 | 密码经过的地方 | 代表 | 自动化 |
|---|------|---------------|------|--------|
| 1 | **安装向导** | 仅运维大脑→浏览器→DB | WordPress/Grafana | ❌ 需人工 |
| 2 | **CLI 创建** | 运维终端→DB | Django createsuperuser | ❌ 需 shell |
| 3 | **邀请邮件** | 邮箱(加密)→DB | 企业 SaaS | ⚠️ 需 SMTP |
| 4 | **env 注入 + seed** | CI/env→容器→DB | Jenkins/**auth-proxy** | ✅ 全自动 |
| 5 | **首个注册即超管** | 浏览器→DB | 小型开源 | ❌ 谁先注册谁是 admin |

### auth-proxy 的演进(三步踩坑史)

**第 0 版:弱默认值(最危险)**
```ts
// seed.ts 早期
const adminUser = process.env.ADMIN_USERNAME ?? "admin";
const adminPass = process.env.ADMIN_PASSWORD ?? "admin123";
```
问题:`?? "admin123"` 这个 fallback,任何一次部署没设 env,就静默创建 `admin/admin123` 弱口令账号,且端口 80 公网暴露。

**第 1 版:compose 强制 env**
```yaml
# docker-compose.yml
ADMIN_USERNAME: ${ADMIN_USERNAME:?must be set}
ADMIN_PASSWORD: ${ADMIN_PASSWORD:?must be set}
```
堵住了"忘设就用弱默认"。但初始密码仍会在 deploy.sh 终端打印、短暂存在于 .env。

**第 2 版(当前):移除 fallback + 长度校验**
```ts
// seed.ts:67-82
const adminUser = process.env.ADMIN_USERNAME;   // 无 fallback
const adminPass = process.env.ADMIN_PASSWORD;
if (!adminUser || !adminPass) {
  throw new Error("...必须显式提供凭证,不会回退到弱默认值");  // 第72行
}
if (adminPass.length < 8) {
  throw new Error("...拒绝创建弱口令管理员");                  // 第79行
}
```
配合 `deploy.sh` 首次部署用 `openssl rand` 生成强随机密码 + 打印一次 + 写入 .env。

### 企业级:消除"初始密码"问题

企业级根本不纠结"初始密码怎么传"——它**消除应用自管超管密码**这件事本身:
- 超管账号在 **IdP**(Okta/Azure AD/飞书)里管理,应用不存密码
- 登录走 OIDC/SAML 重定向到 IdP,应用拿不到密码
- MFA、密码策略、离职收权全在 IdP 一处管

中小企业没 IdP?那就把"自管身份"做扎实(scrypt 哈希、限流、强制改密、审计日志),这是 auth-proxy 的方向。详见 [安全边界](../../README.md#安全边界)。

## 5. JWT_SECRET vs ENCRYPTION_KEY

这两类密钥**性质完全不同**,处理方式天差地别。

| | JWT_SECRET | ENCRYPTION_KEY |
|---|-----------|----------------|
| 用途 | 签名/验签 token | 对称加密敏感数据 |
| 换密钥后果 | 旧 token 立即失效,用户重登即可 | **历史数据无法解密(灾难)** |
| 轮换难度 | 简单,重启即可 | 极难,要重新加密所有存量数据 |
| 泄漏后果 | 能伪造 token | 能解密所有加密数据 |

> 注:auth-proxy 的 JWT 用 RS256(密钥从 signing_keys 表取,seed 时生成),不走 JWT_SECRET。但这个对比对理解密钥管理通用且重要。

### 企业级:信封加密(Envelope Encryption)

对 ENCRYPTION_KEY 这类有状态密钥,企业级用 **KMS + 信封加密**:
```
KMS 主密钥(永不出 KMS,可轮换)
   │ 解密
   ▼
DEK(每条数据一个独立密钥,加密后存库)
   │ 加密
   ▼
业务数据(加密后存库)
```
- 主密钥泄漏不影响数据(还需解 DEK)
- 单条 DEK 泄漏只影响一条记录
- 轮换主密钥只需重加密 DEK(少量),不碰业务数据

中小企业没 KMS?至少做到:**确认生产没用示例值 + 定期轮换 + 用 admin-api 重新加密存量**。

### 铁律

> **任何曾出现在代码/git/文档/截图/聊天里的密钥 = 已泄漏,必须轮换。** 这比用什么存储方案都重要。

密钥一旦进了版本库历史,即使后来删掉,git 历史里永远留着,任何能 clone 仓库的人都能翻到。轮换是唯一解。

---

下一篇:[05-ops — 运维与可观测性 →](./05-ops.md)
[← 返回总览](./README.md)
