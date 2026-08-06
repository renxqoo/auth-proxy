#!/usr/bin/env bash
#
# 定时健康巡检 + 告警。
#
# 检查项:
#   1. 公网入口 nginx(80)是否 200
#   2. 内部 server(3000)是否 200(通过容器网络直查,绕过 nginx)
#   3. postgres / redis 容器是否 healthy
# 任一异常 → 调用告警 webhook(默认飞书格式,可适配钉钉/企业微信)。
#
# 告警去抖:同一故障 30 分钟内不重复发(状态文件 /tmp/auth-proxy-alert.state)。
#
# 告警配置(.env):
#   ALERT_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
#   ALERT_HOST=auth-proxy-prod   # 告警里显示的标识,默认本机 hostname
#
# 安装(crontab -e,每 5 分钟):
#   */5 * * * * /opt/auth-proxy/ops/healthcheck.sh >> /var/log/auth-proxy-health.log 2>&1
#
set -euo pipefail

COMPOSE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${COMPOSE_DIR}/.env"
STATE_FILE="/tmp/auth-proxy-alert.state"
COOLDOWN_SEC=1800  # 30 分钟去抖
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }

HOST_LABEL="${ALERT_HOST:-$(hostname)}"
WEBHOOK="${ALERT_WEBHOOK:-}"
CHECK_URL="${HEALTHCHECK_URL:-http://localhost:80/}"
DEBOUNCE_NOW=$(date +%s)

# ---------- 收集异常 ----------
FAILS=()

# 1. 公网/反代入口
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$CHECK_URL" 2>/dev/null || echo "000")
if [ "$CODE" != "200" ]; then
  FAILS+=("入口 HTTP 非 200(实际 ${CODE}): ${CHECK_URL}")
fi

# 2. 容器健康状态(postgres / redis / server)
COMPOSE="docker compose -f ${COMPOSE_DIR}/docker-compose.yml"
for svc in postgres redis server; do
  STATUS=$($COMPOSE ps "$svc" 2>/dev/null | tail -n +2 | awk '{print $NF}' || echo "unknown")
  # docker compose ps 输出形如 "Up (healthy)" / "Up" / "Exit 1"
  if ! echo "$STATUS" | grep -qi "up"; then
    FAILS+=("容器 ${svc} 非运行状态: ${STATUS:-empty}")
  fi
done

# ---------- 告警去抖判断 ----------
should_alert=1
if [ ${#FAILS[@]} -gt 0 ]; then
  if [ -f "$STATE_FILE" ]; then
    LAST_ALERT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
    DIFF=$((DEBOUNCE_NOW - LAST_ALERT))
    if [ "$DIFF" -lt "$COOLDOWN_SEC" ]; then
      should_alert=0
      echo "[$(date '+%F %T')] 故障持续中,冷却期内(${DIFF}s < ${COOLDOWN_SEC}s),跳过告警"
    fi
  fi
fi

# ---------- 发送告警 ----------
if [ ${#FAILS[@]} -gt 0 ] && [ "$should_alert" = "1" ]; then
  echo "[$(date '+%F %T')] 🔴 检测到 ${#FAILS[@]} 项异常,发送告警"
  printf '  - %s\n' "${FAILS[@]}"

  if [ -z "$WEBHOOK" ]; then
    echo "[$(date '+%F %T')] ⚠️  未配 ALERT_WEBHOOK,告警未发送(故障已记录到本日志)"
  else
    # 拼成单条文本(适配飞书/钉钉/企微 text 消息)
    CONTENT="${HOST_LABEL} 健康检查失败 (${DEBOUNCE_NOW}):"$'\n'"$(printf '  - %s\n' "${FAILS[@]}")"
    PAYLOAD=$(jq -nc --arg text "$CONTENT" '{msg_type:"text",content:{text:$text}}' 2>/dev/null \
      || printf '{"msg_type":"text","content":{"text":"%s"}}' "${CONTENT//$'\n'/\\n}")
    if curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$WEBHOOK" \
         -H 'Content-Type: application/json' -d "$PAYLOAD" | grep -q '^2'; then
      echo "$DEBOUNCE_NOW" > "$STATE_FILE"
      echo "[$(date '+%F %T')] ✅ 告警已发送"
    else
      echo "[$(date '+%F %T')] ⚠️  webhook 调用失败,下次巡检重试" >&2
    fi
  fi
elif [ ${#FAILS[@]} -eq 0 ]; then
  echo "[$(date '+%F %T')] ✅ 全部正常"
  # 恢复时清状态(下次故障能立刻告警)
  rm -f "$STATE_FILE" 2>/dev/null || true
fi
