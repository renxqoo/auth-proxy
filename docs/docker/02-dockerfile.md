# 02 · Dockerfile 编写要点

> 本篇讲怎么写出**安全、高效、可靠**的 Dockerfile。每个要点都用 auth-proxy 的真实 Dockerfile 做实例,每个坑都是项目踩过或规避过的。

## 1. 多阶段构建(核心)

### 为什么必须多阶段

单阶段构建会把**所有东西**打进最终镜像:源码、devDependencies、构建工具、.git 历史。结果:

| | 单阶段 | 多阶段 |
|---|---|---|
| 镜像大小 | 1GB+ | ~200MB |
| 安全 | 源码、构建工具全在里面,攻击面大 | 只含运行时必需 |
| 缓存 | 一次改全部重来 | 分层缓存,deps 不变就跳过 install |

### 标准三阶段

```
stage 1: deps     装全量依赖(含 devDependencies,构建用)
   ▼
stage 2: build    编译产物(tsc / next build)
   ▼
stage 3: runtime  只装生产依赖 + COPY 产物  ← 最终镜像
```

关键:最终镜像(runtime)**只从 build 阶段 COPY 编译产物**,源码和 devDependencies 不进去。

### 项目实例:Dockerfile.server 逐行解读

`Dockerfile.server` 是标准三阶段结构:

```dockerfile
# ---------- stage 1: 全量依赖 ----------
FROM node:22-slim AS deps          # 第9行:基础镜像 + 命名阶段为 deps
WORKDIR /app                       # 第10行:工作目录
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate  # 启用 pnpm 并预下载
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./   # 先拷 workspace 配置
COPY tsconfig.base.json ./
COPY packages/*/package.json packages/*/                  # 共享包 package.json
COPY apps/*/package.json apps/*/                          # 应用 package.json
RUN pnpm install --frozen-lockfile # 装依赖(含 dev,供下一阶段构建用)

# ---------- stage 2: 构建 ----------
FROM deps AS build                 # 基于 deps,继承已装的依赖
COPY turbo.json ./
COPY packages/ packages/           # 拷共享包源码
COPY apps/server/ apps/server/     # 只拷 server 需要的源码(不拷 admin-web 等)
RUN pnpm --filter @auth-proxy/server... build               # 只构建 server 链路

# ---------- stage 3: 运行时 ----------
FROM node:22-slim AS runtime       # 全新基础镜像,不含 build 阶段的东西
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./   # 重拷配置
COPY packages/{shared,db}/package.json packages/          # server 运行时依赖的共享包
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod                  # 只装生产依赖
COPY --from=build /app/packages/*/dist/ ./packages/*/dist/  # 只从 build 拷产物
COPY --from=build /app/apps/server/dist/ ./apps/server/dist/
CMD ["node", "apps/server/dist/index.js"]
```

注意 stage 3 是**全新的 `FROM node:22-slim`**,不是 `FROM build`——这样源码、devDependencies、构建工具全被丢弃,只剩运行时必需。`COPY --from=build` 只精确拷贝 `dist/`。

### 坑

**【坑1】单阶段全量 COPY → 镜像 1GB+**
```dockerfile
# ❌ 反面教材
FROM node:22
COPY . .
RUN npm install
CMD ["node", "index.js"]
```
源码、node_modules、.git 全进镜像,1GB+,还暴露源码。

**【坑2】最终阶段 FROM build 而非全新基础镜像**
```dockerfile
# ❌ 这样 build 阶段的所有垃圾都带进 runtime
FROM build AS runtime
```
必须 `FROM node:22-slim AS runtime` 重新开始,再用 `COPY --from=build` 精确挑产物。

## 2. 层缓存优化

### 原则:不常变的层放前面

Docker 每条指令(RUN/COPY)产生一层,层层叠加。**只要某层变了,它和它之后的所有层缓存全部失效,重新执行。**

所以顺序原则:**最不可能变的 → 最可能变的**。

```
系统依赖(几乎不变)→ package.json(偶尔变)→ 源码(经常变)
```

### 坑:先 COPY 源码再 install

```dockerfile
# ❌ 缓存灾难
COPY . .                          # 源码一改,这层就变
RUN pnpm install                  # 于是每次都重新 install(几十秒~几分钟)
```

```dockerfile
# ✅ 正确:先拷 package.json(很少变),install 能被缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .                          # 源码在这层之后变,不影响上面的 install 缓存
```

### 项目实例

`Dockerfile.server:15-21` 严格遵循:先 COPY 所有 `package.json` 和 lockfile(第15-20行),再 `pnpm install`(第21行),最后才 COPY 源码(第28行)。你改 server 业务代码,install 这层直接命中缓存跳过,构建很快。

## 3. 基础镜像选择

### 对比表

| 镜像 | 大小 | 特点 | 适用 |
|------|------|------|------|
| `node:22` | ~900MB | 含完整 Debian + 编译工具链 | ❌ 太大,别用于生产 |
| `node:22-slim` | ~200MB | 精简 Debian,够用且兼容性好 | ✅ **auth-proxy 选用** |
| `node:22-alpine` | ~150MB | 用 musl libc,极小 | ⚠️ native 模块可能崩 |
| `gcr.io/distroless/nodejs22` | ~50MB | 无 shell、无包管理器,最安全 | 企业级首选 |

### 坑:alpine 的 musl libc

alpine 为了极小,用了 musl libc 而非 glibc。很多 npm 包(含 C/C++ 原生扩展,如 `bcrypt`、`sharp`、`node-sass`)在 musl 下会编译失败或运行时崩溃。

**auth-proxy 选 slim 的理由**:稳。项目用了 `qrcode`、`jose` 等,slim 的 glibc 兼容性零风险。多出的 50MB 换零踩坑,值。

### 企业级演进:distroless

distroless 镜像里**没有 shell、没有包管理器**,攻击者就算打进容器也无处下手(连 `ls` 都没有)。代价:没法 `docker exec sh` 进容器调试。企业级用 distroless + 临时 debug 容器(共享 pid namespace)解决。auth-proxy 当前 slim,可演进。

## 4. 构建工具:corepack / pnpm 下载

### 背景

auth-proxy 用 pnpm 作为包管理器,通过 Node 自带的 **corepack** 激活(`corepack enable`)。pnpm 的版本由根 `package.json` 的 `packageManager: "pnpm@11.1.2"` 锁定,corepack 负责按这个声明安装对应版本。

### 坑:corepack 构建时卡在下载 pnpm

**【坑】`RUN corepack enable` 不够,install 时才现下载 pnpm**

只写 `RUN corepack enable` 不会立即下载 pnpm,而是**等到第一次执行 `pnpm install` 时**才去 `registry.npmjs.org` 现下载。在国内服务器(如阿里云内网)上,访问 npmjs.org 很慢甚至超时,构建就会卡在:

```
#34 [company-mock deps 8/8] RUN pnpm install --frozen-lockfile
#34 0.875 ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.1.2.tgz
```

一卡就是几分钟,而且每个阶段(deps、runtime)都会重复下载。

### 解法:prepare 提前下载 + 国内镜像加速

auth-proxy 的三个 Dockerfile 都采用这套写法:

```dockerfile
# 指向淘宝镜像加速(默认是 registry.npmjs.org,国内慢)
ARG COREPACK_NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=${COREPACK_NPM_REGISTRY}
# enable + prepare:构建时立刻下载并激活 pnpm,不等 install 时才下
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
```

两个关键改进:
1. **`corepack prepare pnpm@11.1.2 --activate`**:构建时立刻下载并激活,把"下载 pnpm"这一步前置到独立层(还能被 docker 缓存),不再拖到 install 时才发现卡住
2. **`COREPACK_NPM_REGISTRY=https://registry.npmmirror.com`**:corepack 读这个环境变量决定从哪下 pnpm,指向淘宝镜像,阿里云内网秒级完成

实测效果:从淘宝源 prepare 仅 **0.03 秒**(对比从 npmjs.org 卡几分钟)。

### 为什么用 ARG 而非硬编码

用 `ARG COREPACK_NPM_REGISTRY=默认值` 而不是写死镜像源,是为了**可逆**——海外或能直连 npmjs 的环境可以覆盖回官方源:

```bash
# 海外/能直连的环境,覆盖回官方源构建
docker compose build --build-arg COREPACK_NPM_REGISTRY=https://registry.npmjs.org
```

不传 `--build-arg` 时用淘宝默认。compose 的 `build:` 块无需配 `args`,ARG 默认值自动生效。

### 涉及位置

三个 Dockerfile 共 5 处 corepack,都已统一改造:

| Dockerfile | 位置 |
|------------|------|
| Dockerfile.server | deps 阶段 + runtime 阶段(2 处) |
| Dockerfile.company-mock | deps 阶段 + runtime 阶段(2 处) |
| Dockerfile.admin-web | deps 阶段(1 处) |

runtime 阶段也需要改,因为它继承自全新的 `FROM node:22-slim`(不继承 deps 阶段的 ENV 和 corepack 缓存),同样会在 `pnpm install --prod` 时触发下载。

### 关联:依赖包本身的下载源

注意:corepack 下载的是 **pnpm 工具本身**(一个包),而 `pnpm install` 下载的是**项目的依赖包**(react/hono 等几百个)。两者是不同的下载源:
- pnpm 工具:走 `COREPACK_NPM_REGISTRY`(本节解决)
- 项目依赖:走 pnpm 的 registry 配置(默认 npmjs.org,国内可在 `.npmrc` 配 `registry=https://registry.npmmirror.com`)

如果改完 corepack 后,`pnpm install` 下依赖包本身仍慢,那是第二个问题,需另配 `.npmrc`。auth-proxy 目前依赖包少、lockfile 命中缓存快,暂未遇到。

## 5. .dockerignore 详解

### 为什么必须管构建上下文

`docker build` 时,**当前目录所有没被 .dockerignore 排除的文件都会被打包上传给 Docker daemon**。不排除垃圾 → 上传慢 + 可能进镜像 + 安全风险。

### 项目实例:auth-proxy 的排除演进

auth-proxy 的 `.dockerignore` 经过几轮加固,最终排除清单:

| 排除项 | 理由 |
|--------|------|
| `node_modules` / `**/dist` | 依赖和产物,镜像里自己装/自己生成 |
| `**/.next` | Next.js 本地构建产物,镜像内重新 build |
| `**/test` / `*.test.ts` | 测试代码,生产镜像不跑 |
| `**/.env` / `**/.env.*` | 环境变量文件,**密钥绝不进镜像** |
| `.zcode` / `.oxlintrc.json` | 本地工具配置 |

> 历史:早期还排除了 `cli`(CLI 曾是本仓库的 workspace 成员,但不部署到 docker)。CLI 现已拆为独立仓库 [renxqoo/rxcli](https://github.com/renxqoo/rxcli),本仓库不再含 cli 目录。

### 坑

**【坑1】模式只匹配根目录**
```dockerignore
# ❌ 这只匹配构建根的 .env.*,匹配不到 auth-proxy/.env.example
.env.*
```
```dockerignore
# ✅ 用 ** 前缀匹配任意层级
**/.env.*
```
这是 dockerignore 和 gitignore 的差异点,极易踩。

**【坑2】全局生效约束**
`.dockerignore` 对所有 Dockerfile 生效。你想"只给 server 排掉某目录,但 admin-web 需要",全局排会误伤。解法:Docker ≥1.2 支持每个 Dockerfile 单独的 ignore 文件,命名 `<Dockerfile名>.dockerignore`(如 `Dockerfile.server.dockerignore`),只对该镜像生效。

## 6. 运行时安全(非 root)

### 为什么

容器默认以 **root** 运行。一旦有容器逃逸漏洞(把容器里的 root 变成宿主机的 root),攻击者直接接管整台机器。

### 做法

```dockerfile
# node 镜像内置了非 root 用户 node
USER node
```
但要注意:runtime 阶段 COPY 的文件默认 owner 是 root,node 用户可能读不了。需要 `chown`:
```dockerfile
COPY --chown=node:node --from=build /app/dist ./dist
USER node
```

### 现状

> ⚠️ **auth-proxy 当前所有服务都以 root 运行,未设 `USER node`。** 这是待加固项。postgres/nginx 官方镜像已内置非 root 用户,主要需调整的是 server/admin-web/company-mock 这三个自建镜像——加 `USER node` + `--chown`。优先级:中(内网部署风险较低,公网暴露的服务应优先)。

## 7. monorepo 构建策略

### 问题

auth-proxy 是 pnpm monorepo,有 5 个 workspace 包(shared/db/server/company-mock/admin-web)。如果 Dockerfile 里跑 `pnpm build`(全量),会把**不需要的包也编译**——比如构建 server 镜像时,admin-web、company-mock 全被构建,白费时间。

### 解法:turbo --filter

`turbo` 是 auth-proxy 用的构建编排工具,`--filter` 可指定只构建目标包及其依赖:

```dockerfile
# 只构建 server 及其依赖链(shared → db → server)
RUN pnpm --filter @auth-proxy/server... build
```

`...` 后缀表示"包含其所有 workspace 依赖"。实测:全量 build 构建 5 个包,filter 后只构建 3 个。

### 三个镜像各自的范围

| 镜像 | filter | 构建的包 |
|------|--------|---------|
| Dockerfile.server | `@auth-proxy/server...` | shared + db + server |
| Dockerfile.company-mock | `@auth-proxy/company-mock...` | shared + company-mock |
| Dockerfile.admin-web | `admin-web...` | admin-web(无 workspace 依赖) |

> 历史:CLI 曾是第 6 个 workspace 包,但不部署到 docker。现已拆为独立仓库 [renxqoo/rxcli](https://github.com/renxqoo/rxcli)。

### 坑

**【坑】忘记 filter 导致全量构建**
早期 Dockerfile.server 用 `pnpm build`(无 filter),每次构建都白编译 admin-web(Next.js 构建很慢)。加 `--filter` 后 server 构建时间显著下降。

## 8. 健康检查(HEALTHCHECK)

### 为什么

容器"在跑"≠ "能用"。进程没退出但数据库连不上、端口没监听,这种半死不活状态,没有 healthcheck 的话 compose/编排器识别不了。

### 项目实例

`Dockerfile.server:56` 定义了健康检查,用 Node 自带的 `fetch`(不依赖 curl,slim 镜像没装 curl):

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.SERVER_PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

- `--start-period=10s`:启动后 10 秒内的失败不计入(给应用启动时间)
- `--retries=3`:连续 3 次失败才标记 unhealthy
- 这让 docker compose 的 `depends_on: condition: service_healthy` 能真正等到 server 就绪

> compose 级也可以定义 healthcheck(postgres/redis 就是在 compose 里定义的),两者效果一样。见 [03-compose](./03-compose.md)。

---

下一篇:[03-compose — Compose 编排设计 →](./03-compose.md)
[← 返回总览](./README.md)
