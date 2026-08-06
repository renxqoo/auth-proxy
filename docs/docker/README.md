# auth-proxy Docker 部署文档

这套文档讲清楚一件事:**怎么用 Docker 把 auth-proxy 安全、可靠地部署起来,并长期运维。**

它不是 Docker 入门教程的堆砌,而是**架构决策参考**——讲透每个选择背后的"为什么"、踩过哪些坑、企业级怎么演进,并紧密结合本项目的真实代码。

## 给谁看

| 读者 | 建议路径 |
|------|---------|
| **Docker 新人** | 先读 [01-basics](./01-basics.md),建立概念和命令基础 |
| **项目开发者** | 读 [02](./02-dockerfile.md) + [03](./03-compose.md),理解镜像和编排怎么写 |
| **运维 / 部署者** | 读 [04](./04-config-secrets.md) + [05](./05-ops.md),理解配置密钥和长期运维 |
| **做技术决策** | 全读,尤其各篇末尾的"企业级演进"部分 |

## 文档地图

```
docs/docker/
├── README.md            ← 你在这里:总览 + 导航
├── 01-basics.md         ← 入门基础:Docker 概念/命令/卷/网络(通用 + 项目对照)
├── 02-dockerfile.md     ← Dockerfile 编写:多阶段/缓存/镜像选择/安全
├── 03-compose.md        ← Compose 编排:依赖/网络/卷/健康检查/资源限制
├── 04-config-secrets.md ← 配置与密钥:env 分层/密钥管理/初始化凭证
├── 05-ops.md            ← 运维:备份恢复/监控告警/日志/迁移/部署流程
└── 06-ci-cd.md          ← CI/CD:从服务器构建到 GitHub Actions + GHCR 镜像分发
```

每篇可独立阅读。新手建议按顺序读完 01;有经验的可直接跳到关心的主题。

## 部署架构

```
                    ┌─────────────┐
   公网 :80  ──────►│   nginx     │  唯一公网入口,终止 TLS
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼                         ▼
      ┌──────────────┐         ┌───────────────┐
      │  admin-web   │         │    server     │  中间层(:3000)
      │  Next.js     │         │  OAuth proxy  │
      │  :3001(内部) │         └───┬───┬───┬───┘
      └──────────────┘             │   │   │
                          ┌────────┘   │   └─────────┐
                          ▼            ▼             ▼
                   ┌────────────┐ ┌─────────┐ ┌──────────────┐
                   │company-mock│ │postgres │ │    redis     │
                   │ :4000(内部)│ │ pg_data │ │  redis_data  │
                   └────────────┘ └─────────┘ └──────────────┘
                                     命名卷        命名卷
```

**关键设计**:只有 nginx 暴露 :80;postgres/redis/company-mock/server/admin-web 全部只在内部网络可见,互用服务名通信。数据通过命名卷(`pg_data`/`redis_data`)持久化。详见 [03-compose](./03-compose.md)。

## 一条核心原则

> **配置外置、密钥不进镜像、容器只读可重建。**

这是整套部署设计的出发点。违反任何一条都会在某个时刻让你付出代价——配置丢、密钥泄、环境漂移。后续各篇都在反复阐释它。

## 相关文件

| 文件 | 作用 | 详解 |
|------|------|------|
| `Dockerfile.server` / `Dockerfile.admin-web` / `Dockerfile.company-mock` | 三个镜像的构建配方 | [02](./02-dockerfile.md) |
| `docker-compose.yml` | 7 个服务的编排 | [03](./03-compose.md) |
| `.dockerignore` | 构建上下文控制 | [02](./02-dockerfile.md#5-dockerignore-详解) |
| `nginx.conf` | 反代路由 | [03](./03-compose.md#2-网络隔离设计) |
| `deploy.sh` | 一键远程部署 | [05](./05-ops.md#5-一键部署流程解读) |
| `ops/backup.sh` / `restore.sh` / `healthcheck.sh` | 运维脚本 | [05](./05-ops.md) |
| `.env`(服务器,不进 git) | 密钥与配置 | [04](./04-config-secrets.md) |

---

下一步:[01-basics — Docker 入门基础 →](./01-basics.md)
