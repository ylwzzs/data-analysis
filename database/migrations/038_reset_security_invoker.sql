-- 038_reset_security_invoker.sql
-- 037 加的 security_invoker=true 有副作用：视图以 authenticated 身份查基表，但基表已 REVOKE SELECT
-- → authenticated 查 _v 也被拒（permission denied），破坏正常问数。
-- 正确方案：SECURITY DEFINER 视图（默认 security_invoker=false，owner=postgres 查基表，基表 REVOKE 不影响 owner）
--           + FORCE RLS（037 已加，让 owner 走 RLS，policy 用调用者会话 claim 裁行）。
ALTER VIEW report_daily_sales_v RESET (security_invoker);
ALTER VIEW report_daily_category_v RESET (security_invoker);
DO $$ BEGIN RAISE NOTICE 'Migration 038_reset_security_invoker applied'; END $$;
