#!/usr/bin/env bash
# scripts/setup-hooks.sh
# 手动设置 Git hooks（需要执行一次）

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "🔧 设置 Git pre-commit hook..."

cat > "$ROOT/.git/hooks/pre-commit" << 'HOOK'
#!/usr/bin/env bash
set -e

echo "🔍 Running lint-staged..."
cd web && npx lint-staged

echo "🔍 Checking edge functions..."
cd .. && bash scripts/check-functions.sh

echo "✅ Pre-commit checks passed"
HOOK

chmod +x "$ROOT/.git/hooks/pre-commit"

echo "✅ Git hooks 已设置完成"
echo ""
echo "现在每次 git commit 都会自动运行："
echo "  - lint-staged (检查修改的 ts/tsx 文件)"
echo "  - check-functions.sh (检查 edge functions)"
