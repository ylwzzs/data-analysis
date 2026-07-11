-- 039_v_security_invoker_grant.sql
-- #1 真正修复：038 的 FORCE RLS 对 superuser owner(postgres) 无效（PG superuser 绕 RLS，FORCE 覆盖不了）。
-- 改 security_invoker=true（视图以调用者 authenticated 身份查基表，authenticated 非 superuser 走 RLS，claim 裁行）
-- + 基表 GRANT SELECT（让视图能查；原 032 REVOKE 被覆盖）。
-- 代价：authenticated 直查基表能看到 total_profit（列级）——靠后续收紧 execute_sql_rls 仅 agent-query 可调来堵。
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
ALTER VIEW report_daily_category_v SET (security_invoker = true);
GRANT SELECT ON report_daily_sales TO authenticated;
GRANT SELECT ON report_daily_category TO authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 039 applied'; END $$;
