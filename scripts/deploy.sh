#!/usr/bin/env bash
# scripts/deploy.sh
# 服务器一键部署（由 GitHub Actions 经 SSH 触发，或在服务器上手动执行）。
# 顺序刻意安排以解决 anon_key 的 chicken-egg：先起后端 → 取/校验 anon_key → 再 build 前端。
# 依赖：docker（含 compose 插件）、jq、curl、git。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
cd "$DEPLOY_DIR"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
API_URL="${INSFORGE_URL:-http://localhost:7130}"

echo "==== [1/5] 同步代码 ===="
cd "$ROOT"
git pull --ff-only
cd "$DEPLOY_DIR"

echo "==== [2/5] 起后端栈并等待就绪 ===="
$COMPOSE up -d postgres postgrest deno insforge
echo "  等待 insforge 接受连接..."
ready=0
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then
    echo "  ✅ insforge 就绪（HTTP ${code}）"
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "  ❌ insforge 30s 内未就绪" >&2; exit 1; }

echo "==== [3/5] 数据库迁移 ===="
bash "$ROOT/scripts/migrate.sh"

echo "==== [4/5] 部署 edge functions + secrets ===="
bash "$ROOT/scripts/deploy-functions.sh"

# 前端 build 所需的 anon_key（build-time 内联，必须此时就位）
if [ -z "${NEXT_PUBLIC_INSFORGE_ANON_KEY:-}" ]; then
  echo "" >&2
  echo "❌ deploy/.env 缺 NEXT_PUBLIC_INSFORGE_ANON_KEY —— 前端无法 build。" >&2
  echo "   这是首次部署的必经步骤：后端已起，请获取本实例的 anon_key 填入 deploy/.env，" >&2
  echo "   再重跑本脚本。获取方式：用 INSFORGE_API_KEY 调 InsForge 的 get-anon-key，" >&2
  echo "   或在 dashboard（http://服务器IP:7130 暂时映射后）查看。" >&2
  exit 1
fi
: "${NEXT_PUBLIC_INSFORGE_URL:=https://${DOMAIN:-localhost}}"
export NEXT_PUBLIC_INSFORGE_URL
echo "  · 前端将连接 $NEXT_PUBLIC_INSFORGE_URL"

echo "==== [5/5] 拉取前端镜像（天翼云）+ 起网关 ===="
# 由 DOMAIN 生成 nginx server.conf（替换模板里的 __DOMAIN__）
if [ -n "${DOMAIN:-}" ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" nginx/user_conf.d/server.conf.tpl > nginx/user_conf.d/server.conf
  echo "  ✅ nginx 配置已生成（server_name ${DOMAIN}）"
else
  echo "  ⚠ DOMAIN 未设置，nginx server.conf 未生成 —— Let's Encrypt 签发会失败" >&2
fi

# 前端镜像由 GitHub Actions 构建并推送到天翼云；此处从天翼云拉取（服务器需已 docker login 天翼云）
$COMPOSE pull web nginx
$COMPOSE up -d web nginx

echo ""
echo "==== ✅ 部署完成 ===="
$COMPOSE ps
echo ""
echo "访问：https://${DOMAIN:-<domain>}"
echo "（首次启动 nginx-certbot 会自动签发 Let's Encrypt 证书，约需 30-60s）"
