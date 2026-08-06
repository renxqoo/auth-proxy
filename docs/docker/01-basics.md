# 01 · Docker 入门基础

> 本篇讲 Docker 的通用概念和命令,但**不是空讲理论**——每个概念都用 auth-proxy 的真实容器做对照。读完你能操作本项目,也能迁移到其他 Docker 项目。

## 1. Docker 是什么

一句话:**把应用和它的整个运行环境(系统库、依赖、配置)打包成一个标准单元(容器),让它"在哪都能跑"。**

### 解决什么问题

| 没有 Docker | 有 Docker |
|-------------|-----------|
| "我本地能跑啊"——生产环境 Node 版本不同就崩 | 镜像里锁死 Node 22,处处一致 |
| 装一堆服务(Postgres/Redis/Nginx)污染系统 | 全部塞进容器,系统保持干净 |
| 部署要手动装依赖、配环境 | `docker compose up` 一键起全栈 |
| 换台机器要重搭一遍 | 镜像可推送到仓库,任意机器拉取即跑 |

### auth-proxy 为什么用 Docker

auth-proxy 有 7 个服务:Node 中间层、Next.js 后台、Postgres、Redis、Nginx、mock 服务、迁移任务。**裸装这 7 个东西到任何一台服务器都是噩梦**——版本冲突、端口打架、依赖污染。容器化后,每个服务待在自己的隔离环境里,用 compose 编排,部署就是 `docker compose up`。

## 2. 核心概念

### 镜像(Image)vs 容器(Container)

最经典的比喻:**镜像是类,容器是实例。**

| | 镜像 (Image) | 容器 (Container) |
|---|---|---|
| 是什么 | 只读的打包模板 | 镜像跑起来的活实例 |
| 类比 | 面向对象里的"类" | "对象" |
| 能否同时多个 | 一个镜像可派生无数容器 | 每个容器独立运行 |
| 状态 | 不可变 | 有运行状态(可启停) |

**项目对照**:
- `node:22-slim` 是镜像(官方 Node 22 精简版)
- `Dockerfile.server` 构建出的 `auth-proxy-server` 也是镜像
- 你跑 `docker compose up` 后,server 服务就是一个**基于该镜像的运行中容器**

```bash
# 看本机有哪些镜像
docker images

# 看正在跑的容器
docker ps
# 看所有容器(含已停止)
docker ps -a
```

### 数据卷(Volume)

容器是**临时的**——容器删了,里面写的文件就没了。数据卷解决"数据要持久化"的问题。

> **项目对照**:Postgres 数据库的数据如果不挂卷,容器一重建,所有 admin 账号、token、签名密钥全没。`pg_data` 命名卷就是用来保住这些数据的。详见本文档第 5 节。

### 网络(Network)

容器之间怎么通信?靠 Docker 网络。最强大的特性:**同一网络内容器可用服务名互访。**

> **项目对照**:server 容器要连 Postgres,不需要知道 IP,直接用 `postgres:5432`(服务名即主机名)。nginx 要转发到 server,用 `server:3000`。这就是网络的作用。详见第 6 节。

### 仓库(Registry)

镜像存哪、怎么分享?靠镜像仓库。Docker Hub 是公共仓库(如 `node:22-slim` 就在上面),企业内可用私有仓库(Harbor/ACR)。auth-proxy 当前是本地构建镜像、不推送仓库(单机部署够用),企业级会引入私有仓库做 CI/CD。

## 3. 常用命令速查表

### 镜像操作

| 命令 | 作用 | 项目用例 |
|------|------|---------|
| `docker build -t 名字 -f Dockerfile.server .` | 构建镜像 | 手动构建 server 镜像 |
| `docker images` | 列出本地镜像 | 看构建出了哪些镜像 |
| `docker rmi <镜像ID>` | 删除镜像 | 清理旧镜像省空间 |
| `docker image prune` | 删除悬空镜像(无标签) | 清理中间层 |

### 容器操作(compose 项目最常用 compose 命令,见下)

| 命令 | 作用 | 项目用例 |
|------|------|---------|
| `docker run --rm -it node:22-slim node` | 临时起个容器跑命令 | 快速测试 Node 环境 |
| `docker exec -it <容器> sh` | 进运行中的容器 | `docker exec -it auth-proxy-server-1 sh` 进排查 |
| `docker logs -f <容器>` | 看容器日志 | 实时看 server 输出 |

### Compose 操作(本项目主力)

| 命令 | 作用 | 项目用例 |
|------|------|---------|
| `docker compose up -d` | 后台启动所有服务 | 本地/部署启动全栈 |
| `docker compose up -d --build` | 重新构建镜像再启动 | 改了代码后重新部署 |
| `docker compose down` | 停止并删容器(**保留卷**) | 重启服务 |
| `docker compose down -v` | 停止并删容器**和卷** | ⚠️ 会删数据库!迁移外别用 |
| `docker compose ps` | 看各服务状态 | 检查谁挂了 |
| `docker compose logs -f server` | 看某服务实时日志 | 排查 server 问题 |
| `docker compose restart server` | 重启某服务 | 改了 server env 后重启 |
| `docker compose build server` | 只构建某服务镜像 | 调试单个 Dockerfile |
| `docker compose exec postgres psql -U auth-proxy` | 在服务里跑命令 | 直连 PG 查数据 |

### 卷操作

| 命令 | 作用 |
|------|------|
| `docker volume ls` | 列出所有卷 |
| `docker volume inspect <卷名>` | 看卷在宿主机的物理位置 |
| `docker volume rm <卷名>` | 删卷(卷没被容器用才能删) |

### 系统

| 命令 | 作用 |
|------|------|
| `docker system df` | 看磁盘占用(镜像/容器/卷各占多少) |
| `docker system prune` | 清理所有停止的容器/悬空镜像/无用网络 |
| `docker system prune -a --volumes` | ⚠️ 激进清理,删所有未被引用的镜像和卷 |

## 4. 第一次运行:把 auth-proxy 跑起来

### 前置

装 [Docker Desktop](https://www.docker.com/products/docker-desktop)(Mac/Windows)或 Docker Engine(Linux)。验证:

```bash
docker --version
docker compose version
```

### 启动

在项目根目录(auth-proxy/),准备 `.env`:

```bash
# 本地开发:用宽松默认即可(compose 里有 :- 默认值)
# 但这四个是强制的(:? 语法,缺失会拒绝启动):
cat > .env <<'EOF'
ADMIN_SESSION_SECRET=本地开发用随便填一个32字符以上的字符串aaaaaaaaaaaa
ADMIN_USERNAME=admin
ADMIN_PASSWORD=devpassword123
POSTGRES_PASSWORD=auth-proxy_secret
EOF
```

> 生产环境的 `.env` 由 `deploy.sh` 自动生成强随机值,见 [04-config-secrets](./04-config-secrets.md)。这里只是本地能跑起来。

启动全栈:

```bash
docker compose up -d --build
```

第一次会比较慢(拉镜像 + 构建)。完成后看状态:

```bash
docker compose ps
```

应该看到 postgres/redis/server/admin-web/nginx 都是 `Up (healthy)`。migrate 是一次性任务,跑完会显示 `Exited (0)`(0 表示成功)。

### 访问

| 服务 | 地址 |
|------|------|
| 中间层 API | http://localhost/ |
| Admin 后台 | http://localhost/admin/login |
| JWKS | http://localhost/.well-known/jwks.json |

### 停止

```bash
docker compose down      # 停容器,数据卷保留
docker compose down -v   # ⚠️ 连数据卷一起删!下次启动数据库是空的
```

## 5. 怎么挂载卷(重点)

### 为什么需要卷

**铁律:容器是临时的,容器删了里面的文件就没了。** 任何需要持久化的数据(数据库、上传文件、日志)都必须挂卷。

### 卷的三种形态

| 形态 | 语法 | 特点 | 适用 |
|------|------|------|------|
| **命名卷** | `卷名:/容器路径` | Docker 托管,有名字好管理,**down 不删** | ✅ 数据库等核心数据 |
| **匿名卷** | `/容器路径`(不写卷名) | Docker 自动起名(一串哈希),难找易丢 | ❌ 不推荐 |
| **bind mount** | `宿主路径:/容器路径` | 直接映射宿主机目录,权限/迁移有坑 | 配置文件、开发热更新 |

### 语法:在 compose 里怎么写

```yaml
services:
  postgres:
    volumes:
      - pg_data:/var/lib/postgresql/data    # 命名卷:卷名:容器路径

  nginx:
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro  # bind mount:宿主路径:容器路径:只读

volumes:
  pg_data:    # 命名卷必须在这里声明
```

### 项目实例拆解

看 auth-proxy 的 Postgres 配置(`docker-compose.yml:17-18`):

```yaml
postgres:
  volumes:
    - pg_data:/var/lib/postgresql/data
```

拆解:
- `pg_data` = 卷名(在文件底部 `volumes:` 块声明,`docker-compose.yml:159`)
- `/var/lib/postgresql/data` = Postgres 容器里存数据的固定路径
- 效果:PG 的所有数据(admins 表、token、签名密钥...)物理上存在 Docker 管理的卷里,容器删了重建,数据还在

Nginx 的 bind mount(`docker-compose.yml:156`):

```yaml
nginx:
  volumes:
    - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

拆解:
- `./nginx.conf` = 宿主机(项目根)的配置文件
- `/etc/nginx/conf.d/default.conf` = 容器里 nginx 读配置的位置
- `:ro` = read-only,容器内不能改这个文件(防误改)
- 效果:你改 `nginx.conf` 后 `docker compose restart nginx` 即生效,不用重建镜像

### 坑

**【坑1】匿名卷 down 后难找易丢**
```yaml
# ❌ 别这么写
volumes:
  - /var/lib/postgresql/data   # 没有卷名,Docker 自动起个哈希名
```
`docker compose down` 后这个卷还在,但你很难识别它属于谁,清理时容易误删。**永远用命名卷。**

**【坑2】bind mount 的权限问题**
bind mount 直接映射宿主目录,容器内的用户(可能 root)写文件,宿主上看这些文件 owner 是 root,非 root 用户在宿主上改不了。数据库用 bind mount 尤其容易踩。**数据库类用命名卷,别用 bind mount。**

**【坑3】不要用 `docker volume cp` 跨架构迁移数据库**
从 ARM 机复制 PG 卷文件到 x86 机可能损坏。**永远走 `pg_dump`/`restore`**,见 [05-ops 迁移章节](./05-ops.md#4-迁移与灾难恢复)。

### 怎么查看/备份/删除卷

```bash
# 看卷列表
docker volume ls
# DRIVER    VOLUME NAME
# local     auth-proxy_pg_data
# local     auth-proxy_redis_data

# 看卷在哪(物理路径)
docker volume inspect auth-proxy_pg_data | grep Mountpoint
# /var/lib/docker/volumes/auth-proxy_pg_data/_data

# 看卷占多大
docker system df -v | grep pg_data

# 删卷(必须先 down 掉用它的容器)
docker compose down
docker volume rm auth-proxy_pg_data
```

> **备份不是这么做的**——直接复制卷文件不可靠。正确做法见 [05-ops 备份章节](./05-ops.md#1-备份与恢复p0)。

## 6. 怎么设置网络(重点)

### 默认行为:服务名即主机名

**Docker Compose 会自动给所有服务建一个默认网络,服务之间用服务名互相访问。** 这是 auth-proxy 的核心网络机制。

> server 连 Postgres,代码里写的是 `postgres:5432`,不是 IP。这里的 `postgres` 就是 compose 里 `postgres:` 服务的服务名。

### 端口映射:`ports` vs 不映射

```yaml
nginx:
  ports:
    - "80:80"      # 宿主机80 → 容器80,对外暴露

postgres:
  # 没有 ports → 只在内部网络可见,公网访问不到
```

- `ports: ["80:80"]` = 把容器端口映射到宿主机,**外部能访问**
- 不写 `ports` = **只有同网络的其他容器能访问**,公网/宿主机都访问不到

### 项目实例:为什么只有 nginx 暴露 80

看 auth-proxy 的设计(`docker-compose.yml`):

| 服务 | 有 ports 吗 | 原因 |
|------|------------|------|
| nginx | ✅ `80:80` | 唯一公网入口,统一终止 TLS、路由分发 |
| server | ❌ | 只通过 nginx 反代访问 |
| admin-web | ❌ | 只通过 nginx 的 `/admin` 路由访问 |
| postgres | ❌ | 只有 server 通过内网连 |
| redis | ❌ | 只有 server 通过内网连 |
| company-mock | ❌ | 只有 server 通过内网连 |

**这是安全最佳实践:最小暴露面。** 任何服务不需要被外部直接访问,就不映射端口。

### 坑

**【坑1】把数据库端口映射到公网 = 灾难**
```yaml
# ❌ 千万别这么写
postgres:
  ports:
    - "5432:5432"   # 除非你设了极强密码+防火墙,否则数据库直接暴露给全网扫描器
```
auth-proxy 故意不给 postgres 映射端口,就是防这个。如果你本地调试需要连 PG,临时加,但**生产环境绝对不要**。

**【坑2】服务名写错连不上**
内部通信靠服务名,必须和 compose 里 `services:` 下的名字**完全一致**。写成 `localhost` 在容器里是连不到别的容器的(localhost 是容器自己)。

### 进阶:多网络隔离

服务多了可用多个网络做隔离(如前端服务在前端网络,数据库在后端网络,前端服务碰不到数据库)。auth-proxy 用默认单网络够用,企业级会显式定义多网络。语法:

```yaml
services:
  nginx:
    networks: [frontend, backend]
  server:
    networks: [backend]
  postgres:
    networks: [backend]   # 只在 backend,nginx 虽然双网络但也碰不到(需显式允许)

networks:
  frontend:
  backend:
```

## 7. 日志查看与排障入门

### 看日志

```bash
# 看所有服务日志
docker compose logs

# 实时跟踪某服务
docker compose logs -f server

# 看最后 100 行
docker compose logs --tail=100 server

# 带时间戳
docker compose logs -ft server
```

### 进容器排查

```bash
# 进 server 容器看文件系统
docker compose exec server sh

# 进 PG 容器连数据库
docker compose exec postgres psql -U auth-proxy

# 在容器里跑任意命令
docker compose exec server node -e "console.log(process.env.NODE_ENV)"
```

### 常见错误排查

| 现象 | 可能原因 | 排查 |
|------|---------|------|
| `Bind address already in use` | 端口被占 | `lsof -i :80` 看谁占了 |
| server 起来立刻退出 | 配置校验失败(如缺 ADMIN_SESSION_SECRET) | `docker compose logs server` 看报错 |
| server 连不上 Postgres | PG 还没 healthy,server 就起来了 | 检查 `depends_on: condition: service_healthy` 是否配了 |
| 容器起来但访问 404 | nginx 路由没配对 | 看 `nginx.conf` 的 location 规则 |
| 数据没了 | 用了 `down -v` 或删了卷 | ⚠️ 不可恢复,所以才要备份 |

---

下一篇:[02-dockerfile — Dockerfile 编写要点 →](./02-dockerfile.md)
[← 返回总览](./README.md)
