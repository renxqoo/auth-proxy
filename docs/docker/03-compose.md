# 03 · Compose 编排设计

> 本篇讲多容器编排怎么设计才可靠:服务依赖、网络隔离、数据持久化、健康检查、资源限制。auth-proxy 有 7 个服务,每个设计决策都有讲究。

## 1. 服务依赖与启动顺序

### 问题:谁该先起来

多服务部署,顺序很重要:Postgres 没起,server 起来也连不上;迁移没跑完,server 跑在空表上会报错。`depends_on` 控制启动顺序,但它有四档精细度。

### 四档 condition

| condition | 含义 | 适用 |
|-----------|------|------|
| 不写(默认) | 只等依赖容器被创建,不等任何状态 | ❌ 几乎没用 |
| `service_started` | 等依赖进程启动(但可能还没 ready) | 弱保证 |
| `service_healthy` | 等依赖 healthcheck 通过 | ✅ 数据库/缓存等 |
| `service_completed_successfully` | 等依赖**容器成功退出**(退出码0) | ✅ 一次性任务(迁移) |

### 项目实例

auth-proxy 的 server 启动依赖链(`docker-compose.yml:92-100`):

```yaml
server:
  depends_on:
    postgres:
      condition: service_healthy           # 等 PG 真正能连
    redis:
      condition: service_healthy           # 等 Redis 真正能连
    company-mock:
      condition: service_started           # mock 起来即可(无 healthcheck)
    migrate:
      condition: service_completed_successfully  # 等迁移+种子跑完
```

migrate 是**一次性任务**(`restart: "no"`,`docker-compose.yml:81`),它跑 `migrate.js` + `seed.js`,成功退出(码0)后 server 才启动。这保证了 **server 永远跑在表结构已就绪的库上**。

### 坑

**【坑1】只 depends_on 不等 healthy**
```yaml
# ❌ 这样 server 可能在 PG 还没 ready 时就启动,连接失败崩溃
server:
  depends_on:
    - postgres
```
PG 容器进程启动了,但要几秒才接受连接。必须 `condition: service_healthy` + 给 PG 配 healthcheck。

**【坑2】healthcheck 写得不对导致永远 unhealthy**
healthcheck 命令要在容器内能跑。比如 slim 镜像没装 curl,用 `curl localhost` 做 healthcheck 会一直失败。auth-proxy 的 PG healthcheck 用 `pg_isready`(PG 自带),server healthcheck 用 Node 的 `fetch`(不依赖 curl),都对。

## 2. 网络隔离设计

### 原则:最小暴露面

**只有需要被外部访问的服务才映射端口,其余一律内部通信。**

### 项目实例

auth-proxy 7 个服务,只有 1 个映射端口:

```yaml
nginx:
  ports:
    - "80:80"    # 唯一公网入口

postgres:        # 无 ports
redis:           # 无 ports
server:          # 无 ports(nginx 反代访问)
admin-web:       # 无 ports(nginx /admin 路由访问)
company-mock:    # 无 ports
migrate:         # 无 ports(一次性任务)
```

内部服务怎么互通?靠 compose 默认网络 + **服务名作主机名**:server 连 PG 用 `postgres:5432`,nginx 转发到 server 用 `server:3000`。详见 [01-basics 网络章节](./01-basics.md#6-怎么设置网络重点)。

### 坑

**【坑】数据库端口映射到公网 = 灾难**
```yaml
# ❌ 生产绝对禁止
postgres:
  ports:
    - "5432:5432"
```
除非有极强密码 + 防火墙白名单,否则 PG 端口暴露公网会被全自动扫描器在几分钟内爆破。auth-proxy 故意不映射,连宿主机都访问不到 PG,只有同网络的 server 能连。

> 本地调试需要连 PG 看 数据?临时加 `"5432:5432"`,调完删掉。或用 `docker compose exec postgres psql` 进容器查。

## 3. 数据持久化

### 决策矩阵:用哪种卷

| 类型 | 语法 | 持久化 | 迁移 | 适用 |
|------|------|--------|------|------|
| **命名卷** | `pg_data:/path` | ✅ down 不删 | 走 dump/restore | ✅ 数据库 |
| **匿名卷** | `/path` | ✅ 但难找 | 难 | ❌ 不推荐 |
| **bind mount** | `./host:/path` | ✅ | 直接拷文件 | 配置文件、开发热更新 |

### 项目实例

```yaml
postgres:
  volumes:
    - pg_data:/var/lib/postgresql/data    # 命名卷

nginx:
  volumes:
    - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro  # bind mount 配置,:ro 只读

volumes:
  pg_data:    # 命名卷声明
  redis_data:
```

PG 用命名卷(Docker 托管,down 不删,安全);nginx 配置用 bind mount(改完 restart 即生效,不用重建镜像)。两种各得其所。

详细原理见 [01-basics 卷章节](./01-basics.md#5-怎么挂载卷重点)。

### 关联:有卷 ≠ 有备份

> ⚠️ **数据挂在卷里只是"持久化",不等于"安全"。** 卷跟宿主机磁盘共存亡——硬盘坏了,卷和原数据一起没。备份是另一回事,见 [05-ops 备份章节](./05-ops.md#1-备份与恢复p0)。

## 4. 健康检查与重启策略

### healthcheck 的两层

| 层级 | 定义位置 | 作用 |
|------|---------|------|
| Dockerfile 级 | `HEALTHCHECK` 指令 | 镜像自带,任何用它的容器都有 |
| compose 级 | `healthcheck:` 块 | 覆盖/补充 Dockerfile 的 |

auth-proxy 两者都用:
- server 用 Dockerfile 级(`Dockerfile.server:56`,见 [02](./02-dockerfile.md#8-健康检查healthcheck))
- postgres/redis 用 compose 级(官方镜像没自带,得自己加):

```yaml
postgres:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-auth-proxy}"]
    interval: 5s
    timeout: 3s
    retries: 10
```

### 重启策略

| 策略 | 行为 | 适用 |
|------|------|------|
| `no` | 不重启(默认) | 一次性任务 |
| `always` | 总是重启(**包括手动 stop**) | ❌ 一般别用 |
| `unless-stopped` | 崩了重启,但手动 stop 后不重启 | ✅ **长跑服务首选** |
| `on-failure` | 仅非0退出码才重启 | 特定场景 |

### 项目实例

```yaml
postgres:
  restart: unless-stopped    # 崩了自动起,手动 down 后不自动起

migrate:
  restart: "no"              # 一次性任务,跑完就退,不重启
```

### 坑

**【坑】always 会把你手动停的服务又拉起来**
你 `docker compose stop server` 想停掉调试,结果 `restart: always` 又把它拉起来了,违背意图。用 `unless-stopped`——手动停的尊重你的意愿,崩溃的才自动恢复。

## 5. 资源限制与日志轮转

### 资源限制:防 OOM 拖垮全机

容器默认**无内存/CPU 限制**。一个服务内存泄漏,能把整台机器吃光,导致所有服务(含数据库)被 OOM Killer 杀掉。

```yaml
server:
  deploy:
    resources:
      limits:
        memory: 512M        # 硬上限,超了被 OOM 杀
        cpus: '1.0'
      reservations:
        memory: 256M        # 软保底
```

> ⚠️ **auth-proxy 当前未设资源限制。** 企业级必加。单机部署风险:一个服务失控可能拖垮全栈。优先级:中。

### 日志轮转:防撑爆磁盘

Docker 默认 `json-file` 日志驱动**无限增长**。一个高频日志服务几天就能写满磁盘,导致全盘只读、所有服务挂。

```yaml
server:
  logging:
    driver: "json-file"
    options:
      max-size: "50m"     # 单个日志文件最大 50M
      max-file: "5"       # 最多 5 个文件,轮转
```

### 项目实例

auth-proxy 给四个长跑服务都配了日志轮转(`docker-compose.yml`):

| 服务 | max-size | max-file | 总上限 |
|------|----------|----------|--------|
| server | 50m | 5 | 250M |
| nginx | 30m | 5 | 150M |
| admin-web | 30m | 3 | 90M |
| company-mock | 20m | 3 | 60M |

postgres/redis 用镜像默认日志行为(它们日志量小)。

### 坑

**【坑1】默认日志无限增长**
不配 `logging` = `json-file` 无限制。生产环境几天磁盘满,排查时才发现是日志。**任何长跑服务都要配 max-size/max-file。**

**【坑2】max-size 设太小导致日志丢失太快**
设 1m 的话出错瞬间日志就轮转没了。server 这种核心服务设 50m,保证有足够历史可查。

## 6. 一次性任务容器

### 场景

有些任务"跑一次就完",不是长跑服务:数据库迁移、种子数据初始化、定时批处理。用 `restart: "no"` 的容器实现。

### 项目实例:migrate 容器

```yaml
migrate:
  build:
    context: .
    dockerfile: Dockerfile.server        # 复用 server 镜像(含 db 包)
  depends_on:
    postgres:
      condition: service_healthy         # 等 PG ready
  command: >
    sh -c "
    node packages/db/dist/migrate.js &&    # 建表/改表
    node packages/db/seed.js               # 种子(RSA密钥+首个admin)
    "
  restart: "no"                          # 关键:跑完不重启
```

设计要点:
1. **复用 server 镜像**——迁移代码在 db 包里,server 镜像已包含,不用单独建迁移镜像
2. **幂等**——migrate 和 seed 都设计成可重复跑(migrate 用 drizzle 跳过已执行的,seed 检测表空才建 admin)
3. **`restart: "no"`**——跑完退出,compose 不会试图拉起它
4. **server `depends_on: migrate`**——保证 server 在迁移完成后才启动

### 坑

**【坑】一次性容器忘了 restart: "no"**
默认 `restart: always` 的话,迁移跑完退出(码0),compose 以为它崩了又拉起来,无限循环跑迁移。

---

下一篇:[04-config-secrets — 配置与密钥管理 →](./04-config-secrets.md)
[← 返回总览](./README.md)
