#!/usr/bin/env bash
# scripts/check-functions.sh
# Edge Function 本地校验脚本
# 检查所有 function 的语法和基本结构

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FUNCTIONS_DIR="$ROOT/functions"

if [ ! -d "$FUNCTIONS_DIR" ]; then
  echo "❌ functions 目录不存在"
  exit 1
fi

errors=0
total=0

echo "🔍 检查 Edge Functions..."
echo ""

for dir in "$FUNCTIONS_DIR"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  
  # 支持 .js 和 .ts
  js_file="$dir/index.js"
  ts_file="$dir/index.ts"
  
  total=$((total + 1))

  # 检查入口文件是否存在
  if [ ! -f "$js_file" ] && [ ! -f "$ts_file" ]; then
    echo "❌ $name: 缺少 index.js 或 index.ts"
    errors=$((errors + 1))
    continue
  fi

  # 选择存在的文件
  file="$js_file"
  [ -f "$js_file" ] || file="$ts_file"

  # JavaScript 语法检查
  if [[ "$file" == *.js ]]; then
    if ! node -c "$file" 2>/dev/null; then
      echo "❌ $name: 语法错误"
      node -c "$file" 2>&1 | head -3
      errors=$((errors + 1))
      continue
    fi
    
    # 检查是否有 module.exports (Node.js Edge Function)
    if ! grep -qE "module.exports" "$file"; then
      echo "⚠️  $name: 缺少 module.exports"
    fi
  fi

  # TypeScript 文件检查导出或 serve (Deno Edge Function)
  if [[ "$file" == *.ts ]]; then
    if ! grep -qE "export|serve\(" "$file"; then
      echo "❌ $name: TypeScript 文件缺少导出或 serve"
      errors=$((errors + 1))
      continue
    fi
  fi

  echo "✅ $name"
done

echo ""
echo "📊 检查完成: $total 个 function，$errors 个错误"

[ "$errors" -eq 0 ] || exit 1
