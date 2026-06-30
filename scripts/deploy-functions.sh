#!/usr/bin/env bash
# scripts/deploy-functions.sh
# 遍历 functions/*/index.js，用 INSFORGE_API_KEY 直调 InsForge API 部署每个 edge function
# （OSS 的 `functions deploy` CLI 走 cloud OAuth、headless 不可用，故直调 API）。
# 随后把 WECOM_* 注入为 function secret（function 用 Deno.env.get 读取）。
# 依赖：jq、curl；InsForge 后端已运行且 7130 端口对本机可达（dev 映射 / prod 的 127.0.0.1 绑定）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCS_DIR="$ROOT/functions"

cd "$ROOT/deploy"
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

API_URL="${INSFORGE_URL:-http://localhost:7130}"
API_KEY="${INSFORGE_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "❌ INSFORGE_API_KEY 未设置（见 deploy/.env）" >&2
  exit 1
fi
AUTH="Authorization: Bearer $API_KEY"

deploy_one() {
  local dir="$1"
  local slug; slug="$(basename "$dir")"
  local code_file="$dir/index.js"
  if [ ! -f "$code_file" ]; then
    echo "  ⊘ 跳过 ${slug}（无 index.js）"
    return
  fi

  echo "▶ function: $slug"
  local body
  body=$(jq -n \
    --arg slug "$slug" \
    --arg name "$slug" \
    --arg desc "$slug edge function" \
    --rawfile code "$code_file" \
    '{slug:$slug, name:$name, description:$desc, code:$code, status:"active"}')

  if curl -sf -H "$AUTH" "$API_URL/api/functions/$slug" >/dev/null 2>&1; then
    echo "  · 已存在 → PUT 更新"
    curl -sf -X PUT -H "$AUTH" -H "Content-Type: application/json" \
      -d "$body" "$API_URL/api/functions/$slug" >/dev/null
  else
    echo "  · 新建 → POST 创建"
    curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "$body" "$API_URL/api/functions" >/dev/null
  fi
  echo "  ✅ $slug"
}

# 部署除 mcp 外的所有 function（mcp 为占位 mock，且 ESM 写法与 OSS CommonJS runtime 冲突）
for dir in "$FUNCS_DIR"/*/; do
  [ -d "$dir" ] || continue
  slug="$(basename "$dir")"
  [ "$slug" = "mcp" ] && { echo "⊘ 跳过 mcp（占位，暂不部署）"; continue; }
  deploy_one "$dir"
done

# 注入 function secrets（WECOM_*）
echo "▶ 注入 function secrets（WECOM_*）..."
set_secret() {
  local k="$1" v="$2"
  if [ -z "$v" ]; then
    echo "  · $k 未配置，跳过"
    return
  fi
  local body; body=$(jq -n --arg k "$k" --arg v "$v" '{name:$k, value:$v}')
  if curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "$body" "$API_URL/api/secrets" >/dev/null; then
    echo "  ✅ $k"
  else
    echo "  ⚠ $k 设置失败（端点/格式可能不符，请核对 /api/secrets）"
  fi
}
set_secret "WECOM_CORP_ID" "${WECOM_CORP_ID:-}"
set_secret "WECOM_SECRET" "${WECOM_SECRET:-}"
set_secret "WECOM_AGENT_ID" "${WECOM_AGENT_ID:-}"

echo "✅ function 部署完成"
