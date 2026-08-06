# 05 · 运维与可观测性

> 部署成功只是开始。这一章讲怎么让服务**长期可靠地活着**——备份、监控、日志、迁移,以及 auth-proxy 的部署流程解读。运维的本质:数据不丢、出事知道、能恢复。

## 1. 备份与恢复(P0)

### 核心论点

> **有卷 ≠ 有备份;本地备份 ≠ 真备份。**

数据挂在命名卷里只是"持久化"(容器重建不丢),但卷和宿主机硬盘共存亡——硬盘坏/机器换/勒索病毒,卷和原数据一起没。**必须独立备份,且备份必须异地。**

### PG 备份:用 pg_dump,不能复制卷文件

**不能**直接 `docker volume cp` 或复制 `/var/lib/docker/volumes/...` 文件——PG 运行时数据文件可能不一致,跨 Docker 版本/架构复制还可能损坏。

**正确做法**:通过容器执行 `pg_dump` 导出 SQL。

### 项目实例:ops/backup.sh

`ops/backup.sh` 的核心逻辑(通过容器跑 pg_dump,宿主机免装 PG 客户端):

```bash
# backup.sh:43-45
docker compose exec -T postgres pg_dump -U auth-proxy auth-proxy > 备份文件.sql
```

特性:
- **本地轮转**:保留 14 天,超期自动删(`find -mtime +14 -delete`)
- **异地推送**:可选,在 .env 设 `REMOTE_BACKUP_CMD`(`ops/backup.sh:62`)
- **空文件校验**:pg_dump 失败产空文件时检测并删除,避免"假备份"

### 异地备份(必须做)

只放服务器本地的备份 = 半备份(硬盘坏了备份陪葬)。在 `.env` 配置推送命令:

```bash
# rclone 推 OSS(推荐)
REMOTE_BACKUP_CMD="rclone copyto {} oss:auth-proxy-backup/{/}"
# 或 AWS CLI
REMOTE_BACKUP_CMD="aws s3 cp {} s3://my-bucket/auth-proxy/{/}"
```
`{}` = 本地完整路径,`{/}` = 文件名。backup.sh 会替换这两个占位符。

> 没有对象存储?最低限度用 `scp` 推到另一台机器。原则:**备份必须在服务器以外的存储上。**

### 恢复与演练

`ops/restore.sh` 提供两种模式:
- `--list`:列出可用备份
- 默认:增量导入(不删表)
- `--reset`:灾后全量重建(DROP SCHEMA → migrate → 导入,带 YES 二次确认)

> **没验证过能恢复的备份 = 没有备份。** 至少在新库跑一次 `restore.sh` 确认 SQL 能导回去。

详细命令见 [README 运维章节](../../README.md#备份与恢复)。

## 2. 健康巡检与告警

### 问题:部署完不是结束

`deploy.sh` 跑完健康检查(轮询 HTTP 200)就退出了,**平时没人盯**。服务半夜挂了,你不设告警的话,是用户先发现。

### 项目实例:ops/healthcheck.sh

每 5 分钟巡检一次(cron `*/5 * * * *`),检查三项:
1. 公网入口 nginx:80 是否 200
2. server 容器是否 healthy
3. postgres/redis 容器状态

任一异常 → 调告警 webhook。关键设计——**30 分钟去抖**(`ops/healthcheck.sh:25`):

```bash
COOLDOWN_SEC=1800  # 故障持续时,30 分钟内不重复发,防刷屏
```

配告警:在 `.env` 加飞书/钉钉 webhook:
```bash
ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
ALERT_HOST=auth-proxy-prod
```
不配 webhook 时,故障只记到 `/var/log/auth-proxy-health.log`。

### 告警的去抖逻辑

为什么需要去抖:服务挂了不会 5 分钟自愈,每 5 分钟发一条告警会刷屏。用状态文件记录上次告警时间,30 分钟内同一故障不重复发;服务恢复时清状态(下次故障能立刻告警)。

## 3. 日志管理

### 容器日志的生命周期问题

Docker `json-file` 日志存在宿主机 `/var/lib/docker/containers/<id>/<id>-json.log`。**容器删了,对应日志文件也删**。所以:
- 临时排障:`docker compose logs server`(从当前日志文件读)
- 长期留存:要么挂卷到应用自己写文件,要么用集中日志系统

### 日志轮转(已做)

见 [03-compose 日志章节](./03-compose.md#5-资源限制与日志轮转)。auth-proxy 四个长跑服务都配了 `max-size`/`max-file`,防止日志撑爆磁盘。日志文件在宿主机的实际位置:

```bash
# 找某个容器的日志文件
docker inspect --format='{{.LogPath}}' <容器名>
# /var/lib/docker/containers/abc123.../abc123...-json.log
```

### 企业级演进:集中日志

单机 `docker logs` 够用,但服务多了/多节点时,日志散在各容器没法搜。企业级用集中日志栈:
- **Loki + Grafana**:轻量,适合中小规模
- **ELK(Elasticsearch + Logstash + Kibana)**:功能全但重
- 原理:每个容器跑个 logging driver/promtail 把日志推到中心,统一检索

auth-proxy 单机部署暂不需要,多节点时再演进。

## 4. 迁移与灾难恢复

### 标准流程

```
老服务器                         新服务器
pg_dump(导出)──┐
                │ scp / 对象存储
                ▼               装 docker + 传代码 + .env
                                docker compose up -d postgres(等 healthy)
                ◄── 导入 dump ── cat xxx.sql | docker compose exec -T postgres psql -U auth-proxy
                                docker compose up -d(起全部)
```

详细命令见 [README 迁移章节](../../README.md#迁移服务器)。

### 坑

**【坑】用 docker volume cp 跨架构迁移**
从 ARM(mac)复制 PG 卷文件到 x86(服务器),数据文件格式/字节序问题可能导致损坏。**永远走 `pg_dump`/`restore`**——SQL 是文本,跨架构安全。

**【坑】忘了迁移 .env**
新机器起不来,因为缺 `ADMIN_SESSION_SECRET` 等强制变量。`.env` 不在代码里(gitignore),迁移时要单独传(或在新机器重跑 `deploy.sh` 重新生成,但密钥会变)。

### 灾难恢复清单

真出事时按这个顺序:
1. 确认最新备份存在且能恢复(`restore.sh --list`)
2. 在新机器/重建环境上:装 docker + 传代码
3. 传 `.env`(或重新生成)
4. `docker compose up -d postgres`,等 healthy
5. `restore.sh xxx.sql` 导入备份
6. `docker compose up -d` 起全部
7. 验证:登录 admin 后台看数据完整性

## 5. 一键部署流程解读

`deploy.sh` 把整个部署流程自动化成六步:

```
[1/6] 上传代码     tar 打包(排除 node_modules/.git/.env 等)→ scp 到服务器
  │
[2/6] 准备 .env    首次部署:openssl rand 生成强随机密钥写入 .env
  │                老环境升级:增量补全缺失变量,不动已有密钥
  │
[3/6] 构建镜像     docker compose config 校验 + docker compose build
  │
[4/6] 启动服务     docker compose down → docker compose up -d
  │                (migrate 容器自动先跑迁移+种子,再起 server)
  │
[5/6] 健康检查     轮询 http://localhost:80/ 直到 200(最多30次×3秒)
  │
[6/6] 安装 cron    幂等写入 /etc/cron.d/auth-proxy:
                   备份 03:00 / 巡检每5分钟
```

### 设计要点

**幂等**:每一步都可重复跑。`.env` 已存在就补全缺失项不覆盖已有;cron 文件每次重写不追加。

**密钥不进传输流**:tar 打包排除了 `.env`(`deploy.sh:51`),密钥只在服务器本地生成/存在。

**强制校验**:compose 用 `${VAR:?}` 让"密钥缺失"在 `docker compose config` 阶段就报错,不会跑到运行时才发现。

**老环境平滑升级**:这是踩坑后的改进——早期版本"全有或全无",老 `.env` 缺新变量就直接报错起不来。现在改成增量补全,详见 [04 初始化凭证章节](./04-config-secrets.md#4-初始化超管密码处理踩坑重点)。

## 6. 企业级演进路线图

### 现状 vs 企业级

| 维度 | auth-proxy 现状 | 企业级 | 差距 |
|------|---------------|--------|------|
| **镜像** | slim + 多阶段 | distroless + 镜像扫描 + 私有仓库 | 中(USER node 待加) |
| **编排** | 单机 compose | K8s(多副本/滚动更新/自愈) | 大(单机够用时不必动) |
| **密钥** | 明文 .env + 强制校验 | Vault/KMS 运行时注入 | 中(SOPS 是过渡) |
| **部署** | deploy.sh SSH 手触发(服务器构建) | GitOps(CI 构建+镜像分发,见 [06](./06-ci-cd.md)) | 中 |
| **可观测** | 健康巡检+本地日志 | Prometheus 指标 + Loki 日志 + 告警 | 中 |
| **备份** | pg_dump cron + 异地(待配) | 托管 DB 自动备份 + PITR | 小(本地备份已合格) |
| **身份** | 本地账号 + 加固密码 | IdP/OIDC 托管 | 大(无 IdP 时的正解是做扎实自管) |

### 按优先级的升级清单

| 优先级 | 事项 | 改动量 | 理由 |
|--------|------|--------|------|
| 🔴 P0 | 配置异地备份 | 小(配 .env) | 防数据全损,本地备份=半备份 |
| 🔴 P0 | 配置告警 webhook | 小(配 .env) | 出事得知道 |
| 🟡 P1 | Dockerfile 加 USER node | 小 | 安全基线,防容器逃逸提权 |
| 🟡 P1 | .env 改 SOPS 加密进 git | 中(纯运维) | 消除明文密钥单点 |
| 🟡 P1 | 加资源限制 mem_limit | 小(3行 YAML) | 防 OOM 拖垮全机 |
| 🟡 P1 | CI/CD 替代服务器构建 | 中(配 GHCR) | 服务器构建慢(corepack 卡)是结构性问题,CI 根治。方案见 [06-ci-cd](./06-ci-cd.md) |
| 🟢 P2 | Prometheus + Grafana | 中 | 主动监控,不只靠巡检 |
| 🟢 P2 | Prometheus + Grafana | 中 | 主动监控,不只靠巡检 |
| 🟢 P2 | 接 SSO/IdP(若有) | 大 | 干掉本地密码管理负担 |

### 何时该从 compose 迁 K8s

**不要为了"企业级"而迁**。判断标准(满足任一即可考虑):
- 需要**多副本**做高可用(单机宕机不能接受)
- 服务数量**超过 15-20 个**,compose 文件难维护
- 需要**跨多台机器**部署
- 需要**滚动更新/金丝雀发布**(零停机部署)

auth-proxy 单机 7 个服务、可接受短暂停机部署,**compose 完全够用**,迁 K8s 的运维成本远大于收益。

## 7. 部署常见问题排查

### 构建阶段卡住

**【症状】构建卡在 corepack 下载 pnpm**
```
#34 RUN pnpm install --frozen-lockfile
#34 ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.1.2.tgz
```
**原因**:corepack 在 install 时才去 npmjs.org 现下载 pnpm,国内服务器访问慢。
**解决**:已在 Dockerfile 用 `corepack prepare` + `COREPACK_NPM_REGISTRY=https://registry.npmmirror.com` 解决,详见 [02-dockerfile 构建工具章节](./02-dockerfile.md#4-构建工具corepack--pnpm-下载)。

**【症状】`pnpm install` 下依赖包本身慢**
corepack 下的是 pnpm 工具(已解决),这里指下 react/hono 等项目依赖慢——那是 npm registry 的问题,需另配 `.npmrc`:
```dockerfile
RUN echo "registry=https://registry.npmmirror.com" > /.npmrc
```
auth-proxy 依赖包少、lockfile 命中快,暂未遇到。

### 启动阶段失败

**【症状】server 容器启动立刻退出**
通常是配置校验失败。看日志定位:
```bash
docker compose logs server
```
常见原因:
- `.env` 缺 `ADMIN_SESSION_SECRET` / `ADMIN_USERNAME` / `ADMIN_PASSWORD`(compose `${VAR:?}` 会报 must be set)
- `ADMIN_SESSION_SECRET` 弱(短于 32 字符或用已知默认值,`assertProductionConfig` 拒绝启动)

**【症状】migrate 容器退出码非 0,server 不启动**
migrate 跑迁移+种子失败。看日志:
```bash
docker compose logs migrate
```
常见原因:数据库连接串不对、admins 表空但没设 ADMIN 凭证(seed.ts 会拒绝建弱口令账号)。

### 运行阶段

**【症状】访问 80 端口 502/连接被拒**
nginx 起来了但后端没就绪。检查:
```bash
docker compose ps        # server 是否 Up (healthy)?
docker compose logs nginx # 看反代报错
```

**【症状】磁盘慢慢满了**
大概率是日志。检查:
```bash
docker system df                          # 总览
docker compose logs --tail=0 -f server    # 看哪个服务日志暴涨
```
解法:确认该服务配了 `logging: max-size/max-file`(见 [03 日志轮转](./03-compose.md#5-资源限制与日志轮转))。

---

[← 返回总览](./README.md)
