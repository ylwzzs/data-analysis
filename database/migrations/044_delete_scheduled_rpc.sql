-- 044_delete_scheduled_rpc.sql
-- C4 删除管理：delete_scheduled_report RPC（SECURITY DEFINER，只删 owner 自己的，防孤儿 cron）
CREATE OR REPLACE FUNCTION delete_scheduled_report(p_owner TEXT, p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  DELETE FROM scheduled_reports WHERE owner_wecom_id = p_owner AND cron_job_id = p_cron_job_id RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN 'not_found_or_not_owner'; END IF;
  RETURN 'deleted';
END;
$$;
GRANT EXECUTE ON FUNCTION delete_scheduled_report(TEXT,TEXT) TO authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 044_delete_scheduled_rpc applied'; END $$;
