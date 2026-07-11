-- 040_execute_sql_rls_block_base.sql
-- #5 修复（#1 修复 security_invoker+基表GRANT 后放大）：
-- authenticated 可经 execute_sql_rls 直查 report_daily_sales/category 基表，绕 _v 的 can_see_cost 列脱敏看 total_profit。
-- execute_sql_rls 内禁查这两个基表（强制走 _v 视图，_v 有 CASE 脱敏）。
-- report_daily_sales_v 含 "report_daily_sales" 前缀，用 regex report_daily_sales([^_v]|$) 精确匹配基表（非 _v）。
CREATE OR REPLACE FUNCTION execute_sql_rls(p_query TEXT)
RETURNS SETOF JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  u TEXT;
BEGIN
  u := UPPER(TRIM(p_query));
  IF u NOT LIKE 'SELECT%' THEN
    RETURN NEXT jsonb_build_object('error', 'only_select_allowed');
    RETURN;
  END IF;
  IF u LIKE '%INSERT%' OR u LIKE '%UPDATE%' OR u LIKE '%DELETE%'
     OR u LIKE '%DROP%' OR u LIKE '%TRUNCATE%' OR u LIKE '%ALTER%'
     OR u LIKE '%CREATE%' OR u LIKE '%GRANT%' OR u LIKE '%READ_PARQUET%' THEN
    RETURN NEXT jsonb_build_object('error', 'forbidden_statement');
    RETURN;
  END IF;
  -- #5: 禁查 report_daily_sales / report_daily_category 基表（强制走 _v，防 total_profit 列级绕过）
  -- regex 匹配基表名（后跟非 _v 字符或结尾），_v 视图不受影响
  IF lower(p_query) ~ 'report_daily_sales([^_v]|$)' OR lower(p_query) ~ 'report_daily_category([^_v]|$)' THEN
    RETURN NEXT jsonb_build_object('error', 'base_table_blocked_use_v_view');
    RETURN;
  END IF;
  RETURN QUERY EXECUTE 'SELECT to_jsonb(q) FROM (' || p_query || ') AS q';
END;
$$;
COMMENT ON FUNCTION execute_sql_rls IS 'agent 网关查 PG（SECURITY INVOKER 走 RLS）；禁查 report_* 基表强制走 _v';
DO $$ BEGIN RAISE NOTICE 'Migration 040_execute_sql_rls_block_base applied'; END $$;
