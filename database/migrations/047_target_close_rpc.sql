-- 047_target_close_rpc.sql
-- scheduler 定时固化用：取 end_date < today 的 active 目标 id（SECURITY DEFINER 绕 RLS 取全量到期）
CREATE OR REPLACE FUNCTION get_due_targets() RETURNS TABLE(id BIGINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM targets WHERE status = 'active' AND end_date < current_date ORDER BY id;
$$;
GRANT EXECUTE ON FUNCTION get_due_targets() TO authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 047_target_close_rpc applied'; END $$;
