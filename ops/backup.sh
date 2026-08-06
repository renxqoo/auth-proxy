#!/usr/bin/env bash
#
# PostgreSQL 定时备份(本地 + 可选异地推送 + 旧文件轮转)。
#
# 设计:
#   - 通过 docker compose exec 调 pg_dump,宿主机无需装 PG 客户端。
#   - 连接参数从 .env 读(POSTGRES_USER / POSTGRES_DB),不硬编码。
#   - 本地保留 N 天(默认 14),超期自动删。
#   - 异地推送可选:设 REMOTE_BACKUP_CMD 环境变量为一个把本地文件名传走的命令,
#     例如用 rclone:   REMOTE_BACKUP_CMD="rclone copyto {} oss:auth-proxy-backup/{/}"
#     或用 aws cli:    REMOTE_BACKUP_CMD="aws s3 cp {} s3://my-bucket/auth-proxy/{/}"
#     ({} = 本地完整路径,{/} = 文件名 basename,类 find -exec 语法)
#     不设则只做本地备份(⚠️ 本地备份≠真备份,务必配异地)。
#
# 安装(crontab -e):
#   0 3 * * * /opt/auth-proxy/ops/backup.sh >> /var/log/auth-proxy-backup.log 2>&1
#
set -euo pipefail

# ---------- 配置 ----------
COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${COMPOSE_DIR}/.env"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/postgres}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
PG_SERVICE="postgres"

# ---------- 从 .env 读 DB 凭据 ----------
if [ ! -f "$ENV_FILE" ]; then
  echo "[$(date '+%F %T')] ❌ 找不到 .env: $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing in .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing in .env}"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILE="${BACKUP_DIR}/auth-proxy_${TIMESTAMP}.sql"

echo "[$(date '+%F %T')] 开始备份 → ${FILE}"

# pg_dump 通过容器执行,-T 关闭 TTY(管道/脚本环境必须)
if ! docker compose -f "${COMPOSE_DIR}/docker-compose.yml" exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    "$PG_SERVICE" pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" > "$FILE"; then
  echo "[$(date '+%F %T')] ❌ pg_dump 失败,删掉残缺文件" >&2
  rm -f "$FILE"
  exit 1
fi

# 校验非空(避免"成功"但产了空文件)
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 100 ]; then
  echo "[$(date '+%F %T')] ❌ 备份文件过小(${SIZE}B),疑似失败,删除" >&2
  rm -f "$FILE"
  exit 1
fi

echo "[$(date '+%F %T')] ✅ 本地备份完成 (${SIZE} bytes)"

# ---------- 异地推送(可选)----------
if [ -n "${REMOTE_BACKUP_CMD:-}" ]; then
  BASENAME=$(basename "$FILE")
  CMD="${REMOTE_BACKUP_CMD//\{\}/$FILE}"
  CMD="${CMD//\{\/\}/$BASENAME}"
  echo "[$(date '+%F %T')] 推送异地: ${CMD}"
  if eval "$CMD"; then
    echo "[$(date '+%F %T')] ✅ 异地推送完成"
  else
    echo "[$(date '+%F %T')] ⚠️  异地推送失败(本地备份仍在)" >&2
    # 不 exit 1:本地备份已成功,推送失败只告警
  fi
else
  echo "[$(date '+%F %T')] ⚠️  未设 REMOTE_BACKUP_CMD,仅本地备份(强烈建议配置异地)"
fi

# ---------- 旧备份轮转 ----------
DELETED=$(find "$BACKUP_DIR" -name "auth-proxy_*.sql" -mtime +"$RETAIN_DAYS" -print -delete)
if [ -n "$DELETED" ]; then
  echo "[$(date '+%F %T')] 轮转:删除超过 ${RETAIN_DAYS} 天的备份"
  echo "$DELETED"
fi

echo "[$(date '+%F %T')] 备份流程结束"
