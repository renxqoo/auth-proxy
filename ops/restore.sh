#!/usr/bin/env bash
#
# PostgreSQL 恢复(从 backup.sh 产生的 .sql 导回)。
#
# ⚠️ 这是破坏性操作:会把 SQL 流导入当前库。pg_dump 默认不含 DROP DATABASE,
#    所以不会删表,但若备份里有 CREATE TABLE 且表已存在会冲突。稳妥用法见下。
#
# 用法:
#   # 1. 列出可用备份
#   ./ops/restore.sh --list
#
#   # 2. 恢复指定备份(默认行为:导入到现有库,适合增量/补救)
#   ./ops/restore.sh /opt/backups/postgres/auth-proxy_20260806_030000.sql
#
#   # 3. 灾后全量重建:先清空再导(危险!二次确认)
#   ./ops/restore.sh --reset /opt/backups/postgres/auth-proxy_20260806_030000.sql
#
# 强烈建议:恢复前先在测试库验证备份有效性(没验证过的备份=没有备份)。
#
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${COMPOSE_DIR}/.env"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/postgres}"
PG_SERVICE="postgres"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ 找不到 .env: $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${POSTGRES_USER:?POSTGRES_USER missing in .env}"
: "${POSTGRES_DB:?POSTGRES_DB missing in .env}"

COMPOSE="docker compose -f ${COMPOSE_DIR}/docker-compose.yml"

# ---------- --list:列出备份 ----------
if [ "${1:-}" = "--list" ]; then
  echo "可用备份(在 ${BACKUP_DIR}):"
  ls -lh "$BACKUP_DIR"/auth-proxy_*.sql 2>/dev/null | awk '{print "  " $9 "  (" $5 ")"}' || echo "  (无)"
  exit 0
fi

# ---------- 解析参数 ----------
RESET=0
SQL_FILE=""
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1 ;;
    -*) echo "未知参数: $arg" >&2; exit 1 ;;
    *) SQL_FILE="$arg" ;;
  esac
done

if [ -z "$SQL_FILE" ]; then
  echo "用法: $0 [--reset] <备份文件.sql>  |  $0 --list" >&2
  exit 1
fi
if [ ! -f "$SQL_FILE" ]; then
  echo "❌ 备份文件不存在: $SQL_FILE" >&2
  exit 1
fi

# ---------- 二次确认 ----------
echo "======================== 恢复操作确认 ========================"
echo "  目标库:    ${POSTGRES_DB} (用户 ${POSTGRES_USER})"
echo "  备份文件:  ${SQL_FILE} ($(wc -c < "$SQL_FILE") bytes)"
if [ "$RESET" = "1" ]; then
  echo "  模式:      ⚠️ RESET — 会 DROP 并重建所有表(数据全丢后重建)"
else
  echo "  模式:      增量导入(不删表,已存在的表 CREATE 会冲突报错)"
fi
echo "============================================================="
printf "确认继续? 输入大写 YES: "
read -r CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "已取消。"
  exit 0
fi

# ---------- 确认 postgres 容器在跑 ----------
if ! $COMPOSE ps "$PG_SERVICE" | grep -q "Up\|running"; then
  echo "❌ postgres 容器未运行,先 docker compose up -d postgres" >&2
  exit 1
fi

# ---------- RESET 模式:先清表 ----------
if [ "$RESET" = "1" ]; then
  echo "→ DROP 所有表 (CASCADE)..."
  # 用 psql 执行动态 SQL:删掉 public schema 下所有表
  $COMPOSE exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$PG_SERVICE" \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
    "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${POSTGRES_USER}; GRANT ALL ON SCHEMA public TO public;"

  echo "→ 重新跑 migrate 重建表结构..."
  $COMPOSE run --rm -T migrate sh -c "node packages/db/dist/migrate.js" || {
    echo "⚠️ migrate 失败,请手动检查表结构" >&2
  }
fi

# ---------- 导入 ----------
echo "→ 导入 ${SQL_FILE} ..."
if $COMPOSE exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$PG_SERVICE" \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" < "$SQL_FILE"; then
  echo "✅ 恢复完成。建议手动验证:登录 admin 后台看数据是否正常。"
else
  echo "❌ 导入过程出错(部分语句可能已执行)。检查上面的输出。" >&2
  exit 1
fi
