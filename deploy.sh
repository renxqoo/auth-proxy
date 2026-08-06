#!/usr/bin/env bash
#
# ⚠️ 应急手动部署脚本。日常部署走 GitHub Actions CI/CD:
#   - push 到 main → .github/workflows/build.yml 自动构建镜像推 GHCR
#   - 去 Actions 页面手动触发 .github/workflows/deploy.yml 部署
#
# 本脚本仅在 CI/CD 不可用时应急使用(如 GitHub 故障、需本地快速验证)。
# 它在服务器上从源码构建镜像(慢,可能卡 corepack),CI 模式则只拉取预构建镜像。
#
# 一键部署 auth-proxy 全栈到服务器。
#
# 安全设计:
#   - 服务器首次部署自动生成强随机"机器密钥"(ADMIN_SESSION_SECRET / POSTGRES_PASSWORD),
#     写入 ${REMOTE_DIR}/.env 并持久化。后续部署不覆盖,密钥稳定。
#   - admin 账号零默认:seed 不创建任何 admin,代码/脚本里没有任何默认 admin 凭证。
#     首个管理员由部署者用 create-admin 脚本手动创建(交互式输入,密码不落盘)。
#     这避免了公开仓库里 admin/admin123 之类的弱口令被利用的初始窗口。
#   - 绝不自动删数据卷(避免丢你改过的数据/密码)。
#   - .env 只存在于服务器,不上传、不进 git、不进镜像,且不含任何 admin 密码。
#   - compose 用 ${VAR:?...} 强制校验:机器密钥缺失则拒绝启动(防弱默认值)。
#   - server 容器 NODE_ENV=production,启动时 assertProductionConfig() 二次校验。
#
# 用法:
#   ./deploy.sh                  # 全量部署(上传 + 构建 + 重启)
#   RESTART_ONLY=1 ./deploy.sh   # 仅重启容器(代码已最新)
#   FORCE_NEW_SECRETS=1 ./deploy.sh  # 强制重新生成机器密钥(注意:改 POSTGRES_PASSWORD
#                                    # 后旧 pg_data 卷认证会失败,需手动 docker volume rm)
#
set -euo pipefail

# ============ 服务器配置(从环境变量读,避免硬编码进仓库)============
SSH_USER="${SSH_USER:-root}"
SSH_HOST="${SSH_HOST:?SSH_HOST 未设置,用法:SSH_HOST=服务器IP ./deploy.sh}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="/opt/auth-proxy"
# 对外可访问的公网地址(拼 verification_uri 用,防 host header 注入)
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://${SSH_HOST}}"
# ====================================

SSH_OPTS="-p ${SSH_PORT} -o StrictHostKeyChecking=accept-new"
SSH_ADDR="${SSH_USER}@${SSH_HOST}"
echo "==> 目标服务器: ${SSH_ADDR}:${SSH_PORT}${REMOTE_DIR}"
echo "==> PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}"

# ----------------------------------------------------------------------------
# 1. 上传代码(排除不该上服务器的:node_modules/dist/.git/.env 本地凭证等)
# ----------------------------------------------------------------------------
if [ "${RESTART_ONLY:-0}" != "1" ]; then
  echo "==> [1/6] 上传代码..."
  TMP_TAR="/tmp/auth-proxy-deploy.tar.gz"
  tar czf "${TMP_TAR}" \
    --exclude='node_modules' \
    --exclude='*/node_modules' \
    --exclude='*/dist' \
    --exclude='*/.next' \
    --exclude='*/.turbo' \
    --exclude='.turbo' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='deploy.sh' \
    --exclude='docs' \
    --exclude='coverage' \
    --exclude='*/coverage' \
    -C "$(pwd)" .
  scp -P ${SSH_PORT} -o StrictHostKeyChecking=accept-new "${TMP_TAR}" "${SSH_ADDR}:/tmp/auth-proxy-deploy.tar.gz"
  rm -f "${TMP_TAR}"
else
  echo "==> [1/5] RESTART_ONLY=1,跳过上传"
fi

# ----------------------------------------------------------------------------
# 2. 服务器:解包 + 确保 .env 存在(首次自动生成强随机密钥)
#
#    把"生成密钥"的逻辑整体放到一个独立的远程脚本里(quoted heredoc,
#    不在本地做任何变量展开),所有 $(openssl...) 在远程 shell 执行。
# ----------------------------------------------------------------------------
echo "==> [2/6] 准备 .env(首次自动生成密钥)..."
# 把本地控制变量通过 ssh 的环境传到远程 shell(单引号防本地再展开),
# 远程的 quoted heredoc 里用 \$PUBLIC_BASE_URL / \$FORCE_NEW_SECRETS 读取。
ssh ${SSH_OPTS} "${SSH_ADDR}" \
  "PUBLIC_BASE_URL='${PUBLIC_BASE_URL}' FORCE_NEW_SECRETS='${FORCE_NEW_SECRETS:-0}' RESTART_ONLY='${RESTART_ONLY:-0}' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="/opt/auth-proxy"
GEN_SECRETS=0

mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"

if [ "${RESTART_ONLY:-0}" != "1" ]; then
  rm -rf "${REMOTE_DIR:?}/"*
  tar xzf /tmp/auth-proxy-deploy.tar.gz -C "$REMOTE_DIR"
  rm -f /tmp/auth-proxy-deploy.tar.gz
fi

if [ ! -f .env ]; then
  GEN_SECRETS=1
elif [ "${FORCE_NEW_SECRETS:-0}" = "1" ]; then
  echo "    FORCE_NEW_SECRETS=1,重新生成密钥"
  GEN_SECRETS=1
fi

if [ "$GEN_SECRETS" = "1" ]; then
  echo "    生成强随机密钥..."
  # 只生成机器级密钥(cookie HMAC / DB 密码)。
  # 不生成 admin 密码 —— seed 不再创建任何 admin(代码零默认,避免公开仓库里的
  # 弱口令被利用)。首个 admin 由部署者用 create-admin 脚本手动创建。
  SEC_ADMIN_SESSION=$(openssl rand -hex 32)
  SEC_POSTGRES_PASSWORD=$(openssl rand -hex 16)
  {
    echo "# 由 deploy.sh 自动生成,勿手动编辑。重新生成用 FORCE_NEW_SECRETS=1 ./deploy.sh"
    echo "# admin session cookie HMAC 密钥(≥32 字节,防 cookie 伪造)"
    echo "ADMIN_SESSION_SECRET=${SEC_ADMIN_SESSION}"
    echo "# Postgres 凭据(首次部署生成;之后稳定,勿轻易改)"
    echo "POSTGRES_USER=auth-proxy"
    echo "POSTGRES_PASSWORD=${SEC_POSTGRES_PASSWORD}"
    echo "POSTGRES_DB=auth-proxy"
    echo "# 对外公网地址(拼 verification_uri,防 host header 注入钓鱼)"
    echo "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
  } > .env
  chmod 600 .env
  echo "    ✅ .env 已生成(权限 600)"
  echo "    ℹ️  seed 不会创建 admin。部署后用 create-admin 脚本手动建第一个管理员(见部署结束提示)"
else
  echo "    .env 已存在,保留现有密钥"
  # 老环境升级:若老 .env 里残留 ADMIN_USERNAME/ADMIN_PASSWORD(现已废弃,seed 不再读),
  # 清掉避免误导(数据库里的 admin 密码为准,不靠 .env)。
  if grep -q '^ADMIN_USERNAME=\|^ADMIN_PASSWORD=' .env; then
    echo "    🧹 清理 .env 里废弃的 ADMIN_USERNAME/ADMIN_PASSWORD(已改由数据库管理)"
    sed -i '/^# 首个管理员/d; /^ADMIN_USERNAME=/d; /^ADMIN_PASSWORD=/d' .env
    chmod 600 .env
  fi
fi

# 校验 .env 含必需变量(不含 admin 凭证 —— 那由数据库管理,手动 create-admin 创建)
for v in ADMIN_SESSION_SECRET POSTGRES_PASSWORD; do
  val=$(grep "^${v}=" .env | cut -d= -f2-)
  if [ -z "$val" ]; then
    echo "    ❌ .env 缺少或为空: $v"
    exit 1
  fi
done
# ADMIN_SESSION_SECRET 强度(≥32 字符,与 server assertProductionConfig 一致)
SECRET_VAL=$(grep '^ADMIN_SESSION_SECRET=' .env | cut -d= -f2-)
if [ ${#SECRET_VAL} -lt 32 ]; then
  echo "    ❌ ADMIN_SESSION_SECRET 长度不足(需 ≥32 字符,当前 ${#SECRET_VAL})"
  exit 1
fi
echo "    ✅ .env 校验通过"
REMOTE_SCRIPT

# ----------------------------------------------------------------------------
# 3. 从源码构建镜像 + 校验 compose 配置
#
#    注:docker-compose.yml 默认用 ghcr.io 预构建镜像(CI 模式)。本应急脚本
#    在服务器上从源码构建,标记成 compose 期望的镜像名,使 GH_OWNER/IMAGE_TAG
#    解析后等于本地 tag → docker compose up 直接用本地镜像,不拉 ghcr。
# ----------------------------------------------------------------------------
echo "==> [3/6] 构建镜像(从源码)..."
ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/auth-proxy
GH_OWNER="renxqoo"
TAG="latest"
# 构建三个应用镜像,tag 与 compose 的 image: 字段一致
docker build -f Dockerfile.server -t ghcr.io/${GH_OWNER}/auth-proxy/server:${TAG} .
docker build -f Dockerfile.company-mock -t ghcr.io/${GH_OWNER}/auth-proxy/company-mock:${TAG} .
docker build -f Dockerfile.admin-web -t ghcr.io/${GH_OWNER}/auth-proxy/admin-web:${TAG} .
# 校验 compose 配置(env 缺失会被 ${VAR:?} 拒绝)
GH_OWNER=${GH_OWNER} IMAGE_TAG=${TAG} docker compose config >/dev/null
REMOTE_SCRIPT

# ----------------------------------------------------------------------------
# 4. 启动(migrate 自动跑一次,然后起 server)
# ----------------------------------------------------------------------------
echo "==> [4/6] 启动服务..."
ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/auth-proxy
GH_OWNER=renxqoo IMAGE_TAG=latest docker compose down
# --pull never:用 step3 本地构建的镜像,不从 ghcr 拉
GH_OWNER=renxqoo IMAGE_TAG=latest docker compose up -d --pull never
REMOTE_SCRIPT

# ----------------------------------------------------------------------------
# 5. 健康检查(轮询直到 200 或超时)
# ----------------------------------------------------------------------------
echo "==> [5/6] 健康检查..."
HEALTH_OK=0
for i in $(seq 1 30); do
  CODE=$(ssh ${SSH_OPTS} "${SSH_ADDR}" "curl -s -o /dev/null -w '%{http_code}' http://localhost:80/" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    HEALTH_OK=1
    echo "    ✅ server 就绪 (HTTP 200,第 ${i} 次探测)"
    break
  fi
  echo "    等待中... (HTTP $CODE, 第 ${i}/30 次)"
  sleep 3
done

if [ "$HEALTH_OK" != "1" ]; then
  echo "    ⚠️  30 次探测未就绪。最近 server 日志:"
  ssh ${SSH_OPTS} "${SSH_ADDR}" "cd /opt/auth-proxy && docker compose logs --tail=40 server" 2>&1 | tail -40
  exit 1
fi

# ----------------------------------------------------------------------------
# 6. 安装运维 cron(定时备份 + 健康巡检)。幂等:已存在则更新,不重复添加。
# ----------------------------------------------------------------------------
echo "==> [6/6] 安装运维 cron(备份 03:00 / 巡检每 5 分钟)..."
ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
REMOTE_DIR="/opt/auth-proxy"

# 脚本可执行
chmod +x "$REMOTE_DIR"/ops/*.sh 2>/dev/null || true

# 准备日志目录
mkdir -p /var/log
touch /var/log/auth-proxy-backup.log /var/log/auth-proxy-health.log 2>/dev/null || true

# 幂等写入 cron:先删旧条目(以防路径/参数变了),再加新的
CRON_FILE=/etc/cron.d/auth-proxy
cat > "$CRON_FILE" <<EOF
# auth-proxy 运维任务(由 deploy.sh 管理,手动改会被覆盖)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 每天凌晨 3 点 PG 备份(异地推送需在 .env 配 REMOTE_BACKUP_CMD)
0 3 * * * root $REMOTE_DIR/ops/backup.sh >> /var/log/auth-proxy-backup.log 2>&1

# 每 5 分钟健康巡检(告警需在 .env 配 ALERT_WEBHOOK)
*/5 * * * * root $REMOTE_DIR/ops/healthcheck.sh >> /var/log/auth-proxy-health.log 2>&1
EOF
chmod 644 "$CRON_FILE"

# 兼容:有些系统 /etc/cron.d 需 reload cron 服务
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload cron 2>/dev/null || systemctl reload crond 2>/dev/null || true
fi

echo "    ✅ cron 已安装: /etc/cron.d/auth-proxy"
echo "    ℹ️  备份存于 /opt/backups/postgres(保留 14 天)"
echo "    ℹ️  异地备份:在 .env 设 REMOTE_BACKUP_CMD(强烈建议)"
echo "    ℹ️  故障告警:在 .env 设 ALERT_WEBHOOK(飞书/钉钉 webhook)"
REMOTE_SCRIPT

echo ""
echo "✅ 部署完成!"
echo "   中间层:  http://${SSH_HOST}/"
echo "   jwks:    http://${SSH_HOST}/.well-known/jwks.json"
echo "   admin:   http://${SSH_HOST}/admin/login"
echo "   CLI prod baseUrl = http://${SSH_HOST}"

# ----------------------------------------------------------------------------
# 检查是否已有 admin 账号;没有则提示手动创建(seed 不再创建任何 admin)。
# ----------------------------------------------------------------------------
ADMIN_COUNT=$(ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT' 2>/dev/null || echo "0"
set -euo pipefail
cd /opt/auth-proxy
# 从 .env 读 DB 凭据连库查 admins 行数;.env 里 PG_USER/PG_DB 可能叫别的名,统一用 compose 的
DB_USER=$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)
DB_NAME=$(grep '^POSTGRES_DB=' .env | cut -d= -f2-)
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM admins;" 2>/dev/null | tr -d '[:space:]' || echo "0"
REMOTE_SCRIPT
)

if [ -z "${ADMIN_COUNT:-0}" ] || [ "${ADMIN_COUNT:-0}" = "0" ]; then
  echo ""
  echo "⚠️  数据库无 admin 账号(seed 不再自动创建)。请手动创建第一个管理员:"
  echo "    ssh root@${SSH_HOST}"
  echo "    cd /opt/auth-proxy"
  echo "    docker compose exec -T \\"
  echo "      -e ADMIN_USERNAME=root -e ADMIN_PASSWORD='<你的强密码>' \\"
  echo "      server node packages/db/dist/scripts/create-admin.js"
  echo "    (或交互式:去掉 -e 参数,TTY 下输入用户名+密码,密码不回显)"
  echo "    创建后即可在 http://${SSH_HOST}/admin/login 登录"
else
  echo "   ℹ️  数据库已有 ${ADMIN_COUNT} 个 admin 账号,用现有账号登录后台"
fi
