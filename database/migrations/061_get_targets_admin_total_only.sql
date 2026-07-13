-- 061_get_targets_admin_total_only.sql
-- get_targets_admin 只返 total 行(列表用),避免算全量 520 行 LATERAL(897ms→<50ms)。
-- 源码只 /api/admin/targets route 调用(列表),breakdown 用 get_breakdown RPC。
-- SECURITY DEFINER 绕 report_daily_sales 等权限(security_invoker 视图 LATERAL)。
-- CREATE OR REPLACE 改 body(加 WHERE target_level='total'),保持原 SECURITY DEFINER + GRANT。
CREATE OR REPLACE FUNCTION get_targets_admin() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (SELECT * FROM report_achievement_v WHERE target_level='total') t;
$function$;
GRANT EXECUTE ON FUNCTION get_targets_admin() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 061_get_targets_admin_total_only completed'; END $$;
