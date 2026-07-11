-- 037_security_fixes.sql
-- 安全审查修复（2026-07-11）：
-- #1 高: report_*_v 视图绕行级 RLS（security-definer 视图 owner=postgres 绕 RLS → 全门店越权读）
-- #2 中: scheduled_reports.delivery_to 无 DB 约束（owner 可改推送给他人）

-- #1 修复：security_invoker=true 让视图以调用者身份查基表 → RLS branch_nums 生效（PG15 支持）
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
ALTER VIEW report_daily_category_v SET (security_invoker = true);
-- 双保险：FORCE ROW LEVEL SECURITY（表 owner 也走 RLS，防 security_invoker 之外的绕过）
ALTER TABLE report_daily_sales FORCE ROW LEVEL SECURITY;
ALTER TABLE report_daily_category FORCE ROW LEVEL SECURITY;

-- #2 修复：delivery_to 钉死=owner（DB 级约束，防 owner UPDATE 改推送收件人）
-- 幂等：PG ADD CONSTRAINT 不支持 IF NOT EXISTS，用 DO 块判断（migrate.sh 每次重跑全部迁移）
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_is_owner' AND conrelid='scheduled_reports'::regclass) THEN
    ALTER TABLE scheduled_reports ADD CONSTRAINT delivery_is_owner CHECK (delivery_to = owner_wecom_id);
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'Migration 037_security_fixes applied'; END $$;
