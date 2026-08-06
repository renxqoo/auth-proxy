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
#   - admin 首个管理员凭证同样由首次部署随机生成(ADMIN_USERNAME 固定为 admin,
#     ADMIN_PASSWORD 随机),写入 .env 并一次性打印。seed 仅在 admins 表空时用它创建
#     一个管理员;之后改密码走 admin 后台,数据库为准。后续部署绝不覆盖你改过的密码。
#   - 绝不自动删数据卷(避免丢你改过的数据/密码)。
#   - .env 只存在于服务器,不上传、不进 git、不进镜像。
#   - compose 用 ${VAR:?...} 强制校验:任何必需变量缺失则拒绝启动(防弱默认值)。
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
  # 机器级密钥(cookie HMAC / DB 密码)+ admin 首个管理员凭证。
  # admin 用户名固定 admin,密码随机生成;seed 仅在 admins 表空时用它创建一次,
  # 之后改密码走 admin 后台。部署绝不覆盖你改过的密码。
  SEC_ADMIN_SESSION=$(openssl rand -hex 32)
  SEC_POSTGRES_PASSWORD=$(openssl rand -hex 16)
  SEC_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  {
    echo "# 由 deploy.sh 自动生成,勿手动编辑。重新生成用 FORCE_NEW_SECRETS=1 ./deploy.sh"
    echo "# admin session cookie HMAC 密钥(≥32 字节,防 cookie 伪造)"
    echo "ADMIN_SESSION_SECRET=${SEC_ADMIN_SESSION}"
    echo "# Postgres 凭据(首次部署生成;之后稳定,勿轻易改)"
    echo "POSTGRES_USER=auth-proxy"
    echo "POSTGRES_PASSWORD=${SEC_POSTGRES_PASSWORD}"
    echo "POSTGRES_DB=auth-proxy"
    echo "# 首个管理员凭证(seed 仅在 admins 表空时创建一次;之后改密码走后台)"
    echo "ADMIN_USERNAME=admin"
    echo "ADMIN_PASSWORD=${SEC_ADMIN_PASSWORD}"
    echo "# 对外公网地址(拼 verification_uri,防 host header 注入钓鱼)"
    echo "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}"
  } > .env
  chmod 600 .env
  echo "    ✅ .env 已生成(权限 600)"
  echo "    ⚠️  首次部署 admin 初始凭证(登录后请立即改密码):"
  echo "        username: admin"
  echo "        password: ${SEC_ADMIN_PASSWORD}"
else
  echo "    .env 已存在,保留现有密钥"
  # 老环境升级:增量补全后来新增的必需变量(不动已有密钥)。
  # 例:本次新增 ADMIN_USERNAME/ADMIN_PASSWORD,老 .env 里没有 → 补上随机值。
  # 已存在的变量绝不覆盖(你改过的密码 / 旧 PG 密钥都安全)。
  ENV_CHANGED=0
  if ! grep -q '^ADMIN_USERNAME=' .env; then
    echo "ADMIN_USERNAME=admin" >> .env
    echo "    ➕ 补全 ADMIN_USERNAME=admin"
    ENV_CHANGED=1
  fi
  if ! grep -q '^ADMIN_PASSWORD=' .env; then
    SEC_ADMIN_PASSWORD_UPGRADE=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
    echo "ADMIN_PASSWORD=${SEC_ADMIN_PASSWORD_UPGRADE}" >> .env
    echo "    ➕ 补全 ADMIN_PASSWORD(随机生成)"
    echo "    ℹ️  此密码仅在 admins 表为空时被 seed 使用。你的数据库已有管理员,"
    echo "        seed 会跳过,不会改你现有账号。请继续用你原有的管理员密码登录。"
    ENV_CHANGED=1
  fi
  if [ "$ENV_CHANGED" = "1" ]; then
    chmod 600 .env
  fi
fi

# 校验 .env 含必需变量(含 admin 首个凭证)
for v in ADMIN_SESSION_SECRET POSTGRES_PASSWORD ADMIN_USERNAME ADMIN_PASSWORD; do
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
# 3. 构建 + 校验 compose 配置(env 缺失会被 ${VAR:?} 拒绝)
# ----------------------------------------------------------------------------
echo "==> [3/6] 构建镜像..."
ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/auth-proxy
docker compose config >/dev/null
docker compose build
REMOTE_SCRIPT

# ----------------------------------------------------------------------------
# 4. 启动(migrate 自动跑一次,然后起 server)
# ----------------------------------------------------------------------------
echo "==> [4/6] 启动服务..."
ssh ${SSH_OPTS} "${SSH_ADDR}" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/auth-proxy
docker compose down
docker compose up -d
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
