# 06 · CI/CD:从服务器构建到镜像分发

> 本篇回答一个关键架构问题:**为什么不应该在服务器上构建镜像,而应该在 CI 构建好再发布?** 以及怎么用 GitHub Actions + GHCR 实现。

## 1. 当前方案的问题:在服务器上构建

auth-proxy 当前的 `deploy.sh` 流程(见 [05 部署流程](./05-ops.md#5-一键部署流程解读)):

```
你的电脑                服务器
  │  scp 上传整个源码      │
  │ ─────────────────────► │
  │                        │  docker compose build  ← 在这编译!
  │                        │  (pnpm install + tsc + next build)
  │                        │  ← corepack 卡、下依赖慢,都在这发生
  │                        │  docker compose up
```

**所有构建都在生产服务器上做**。这正是 `corepack 卡住`、`依赖下载慢` 的根本原因(见 [02 构建工具章节](./02-dockerfile.md#4-构建工具corepack--pnpm-下载))——在弱网的生产机上跑构建。

### 为什么这是反模式

| 问题 | 后果 |
|------|------|
| 生产机兼构建机 | 构建消耗 CPU/内存/磁盘,影响正在跑的服务 |
| 服务器网络差 | 下依赖慢,corepack 卡住,部署耗时长 |
| 构建环境不一致 | 谁的电脑构建结果可能不同,排查"在我这是好的"地狱 |
| 无构建产物版本 | 没有镜像 tag,跑的到底是哪次构建说不清,无法回滚 |
| 无审计 | 谁在什么时候触发部署、构建内容是什么,无记录 |

## 2. 正确模式:CI 构建 + 镜像分发

```
你的电脑          GitHub Actions         镜像仓库         服务器
  │ git push        │                     │                │
  │ ──────────────► │                     │                │
  │                 │ docker build        │                │
  │                 │ (CI 跑,带宽好)      │                │
  │                 │ docker push ───────► │                │
  │                 │ 触发部署 ─────────── ┼───────────────► │
  │                 │                     │ docker pull ◄── │
  │                 │                     │ docker compose up
```

核心转变:**构建在 CI(带宽好、缓存全、环境锁死),服务器只拉镜像跑**。

### 解决了什么

| 当前痛点 | CI 模式如何解决 |
|---------|----------------|
| 服务器 corepack 卡 | CI 在 GitHub 机房跑,带宽好,镜像可缓存 |
| 每次部署都重装依赖 | CI 构建一次推镜像,服务器只 pull(有缓存) |
| 构建不一致 | CI 是唯一构建源,环境固定 |
| 无版本/无回滚 | 镜像带 tag(git sha / 版本号),可追溯可回滚 |
| SSH 手触发 | push 即部署,或点按钮 |

## 3. 用 GitHub 就够了:Actions + GHCR

不用开阿里云 ACR,GitHub 自带你需要的一切:

| 需要的能力 | GitHub 提供 | 说明 |
|-----------|------------|------|
| CI 跑构建 | **GitHub Actions** | 写 `.github/workflows/*.yml`,push 自动触发 |
| 镜像仓库 | **GHCR**(Container Registry) | `ghcr.io/用户名/镜像名`,免费,和 Actions 同机房 |

GHCR 与 Actions 同在 GitHub 网络,`docker push` 极快。

### ⚠️ 必须知道的现实:服务器拉镜像会慢

这是整个方案里**唯一的坑**:

```
GitHub Actions(海外) → push → GHCR(海外)
                                    ↓ docker pull
                        你的阿里云服务器(国内)  ← 首次可能慢
```

GHCR 在海外,阿里云服务器首次拉 ~200MB 镜像可能要几分钟。但 Docker 有**本地层缓存**:只要基础镜像层(node:22-slim)和依赖层不变,后续 pull 只拉变化的那几层(几 MB),很快。

**总耗时权衡**:
- 当前方案:服务器 build(慢)+ 不传输
- CI 方案:CI build(快)+ 服务器 pull(首次慢,后续快)

CI 方案总耗时可能不占优,但它换来当前方案没有的**结构优势**:一致性、可追溯、可回滚、生产机不被构建拖累。**这个选择不是"快不快",而是"愿不愿意用首次 pull 的等待,换掉当前方案的所有缺陷"。**

### 镜像仓库对比(GHCR vs ACR)

| | GHCR(GitHub) | ACR(阿里云) |
|---|---------------|-------------|
| 开通成本 | 零(GitHub 自带) | 要开通阿里云容器镜像服务 |
| Actions 推送 | 同机房,极快 | 跨网络,稍慢 |
| **服务器拉取** | ⚠️ 海外,首次慢 | ✅ 阿里云内网,极快 |
| 费用 | 免费额度足够 | 有免费额度,超了计费 |
| 适合 | 中小项目、不想开额外服务 | 大镜像、对拉取速度敏感 |

**推荐**:auth-proxy 这种规模,**先用 GHCR**(零开通成本)。如果后续服务器拉镜像成为瓶颈,再迁 ACR(改动很小,只改镜像地址)。

## 4. 实施方案(workflow 设计)

> 这是方案设计,暂未实施。确认要落地时按此执行。

### 目录结构

```
auth-proxy/
├── .github/
│   └── workflows/
│       ├── build.yml      # push 时构建并推镜像
│       └── deploy.yml     # 镜像构建后触发部署(可选,先手动触发)
```

### build.yml(核心:CI 构建 + 推 GHCR)

```yaml
name: Build & Push Images

on:
  push:
    branches: [main]           # push 到 main 触发
  workflow_dispatch:           # 也允许手动触发

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ${{ github.repository }}   # → ghcr.io/<用户名>/auth-proxy

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write          # 推 GHCR 需要的权限
    strategy:
      matrix:
        include:
          - dockerfile: Dockerfile.server
            image: server
          - dockerfile: Dockerfile.admin-web
            image: admin-web
          - dockerfile: Dockerfile.company-mock
            image: company-mock
    steps:
      - uses: actions/checkout@v4

      - name: Set image tag (git sha)
        run: echo "TAG=${GITHUB_SHA::7}" >> $GITHUB_ENV

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}   # 内置,无需配

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}/${{ matrix.image }}:${{ env.TAG }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_PREFIX }}/${{ matrix.image }}:latest
```

要点:
- **matrix 策略** 三个镜像并行构建
- **tag 用 git sha 前 7 位**(如 `a1b2c3d`)+ `latest` 双标签,既可精确追溯又可拉最新
- `GITHUB_TOKEN` 是 Actions 内置的,推 GHCR 无需额外配密钥
- 海外 CI 构建不会卡 corepack,可去掉 [02](./02-dockerfile.md#4-构建工具corepack--pnpm-下载) 里的 `COREPACK_NPM_REGISTRY` 镜像加速(留着也无妨,ARG 默认值不传即用官方源)

### deploy.yml(触发服务器更新)

```yaml
name: Deploy

on:
  workflow_run:
    workflows: ["Build & Push Images"]
    types: [completed]
    branches: [main]
  workflow_dispatch:       # 允许手动点按钮部署

jobs:
  deploy:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - name: Trigger server pull & up
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/auth-proxy
            # 服务器只需 pull + up,不再 build
            docker compose pull
            docker compose up -d
```

要点:
- build 成功后自动触发(`workflow_run`)
- SSH 凭据存 GitHub Secrets(`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_SSH_KEY`)
- 服务器只做 `pull` + `up`,**不再 `build`**

### docker-compose.yml 改造(从 build 改 image)

当前 compose 用 `build:` 从源码构建,CI 模式改为拉镜像:

```yaml
# 改造前(当前)
server:
  build:
    context: .
    dockerfile: Dockerfile.server

# 改造后(CI 模式)
server:
  image: ghcr.io/<用户名>/auth-proxy/server:${IMAGE_TAG:-latest}
  # 不再 build,从 GHCR 拉
```

三个服务(server/admin-web/company-mock)都这么改。`${IMAGE_TAG:-latest}` 让你能用环境变量切版本(回滚时改 tag)。

### 需要配的 GitHub Secrets

| Secret | 值 | 用途 |
|--------|-----|------|
| `DEPLOY_HOST` | `<your-server-ip>` | 服务器 IP |
| `DEPLOY_USER` | `root` | SSH 用户 |
| `DEPLOY_SSH_KEY` | 服务器的 SSH 私钥 | SSH 登录 |

`GITHUB_TOKEN` 内置无需配。GHCR 镜像默认 private,push 后要在 GitHub → Packages 里设为 public,或给服务器配 pull token。

## 5. 迁移步骤(确认实施时按此走)

1. **GitHub 开 Packages 权限**:仓库 Settings → Actions → workflow permissions 设为 read and write
2. **配 3 个 Secrets**:`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY`
3. **写 `.github/workflows/build.yml`**,push 测试,确认 GHCR 里出现三个镜像
4. **改造 docker-compose.yml**:三个服务从 `build:` 改成 `image: ghcr.io/...`
5. **写 deploy.yml**,测试自动部署
6. **服务器准备**:首次 `docker login ghcr.io -u <用户名>`(若镜像 private)
7. **废弃 deploy.sh 的 build 环节**:保留作为应急手动部署,但日常走 CI

> ⚠️ 迁移期可并行:CI 推镜像 + deploy.sh 仍可本地构建,双轨运行验证稳定后再删 deploy.sh 的 build。

## 6. 这种模式带来的额外能力

| 能力 | 当前方案 | CI 模式 |
|------|---------|---------|
| **回滚** | ❌ 改代码重新部署 | ✅ `IMAGE_TAG=a1b2c3d docker compose up` 即回滚到任意历史版本 |
| **构建审计** | ❌ 无 | ✅ 每次构建关联 commit/PR,GitHub 可查 |
| **多人协作** | ⚠️ 谁本地环境都可能不同 | ✅ CI 唯一构建源,人人一致 |
| **生产机隔离** | ❌ 构建拖累生产 | ✅ 生产机只跑容器,不编译 |
| **部署门禁** | ❌ 谁都能 deploy.sh | ✅ 可加 CI 审批、分支保护 |

## 7. 何时该上,何时不上

**该上 CI 模式**:
- 团队 ≥2 人
- 服务器网络差(构建慢,你正是)
- 需要部署历史/回滚
- 想要"push 即部署"的体验

**暂时可以缓**:
- 纯个人项目、服务器网络好、不在意可追溯
- 镜像仓库还没决定(GHCR 拉取慢不可接受时,先评估 ACR)

auth-proxy 当前属于"该上"——服务器 corepack 卡、依赖下载慢,都是当前方案的结构性问题,CI 能根治。

---

[← 返回总览](./README.md)
