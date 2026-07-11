-- 042_revert_041_rpc.sql
-- 回退 041：check claim.sub='agent-query' 误伤了 serviceJwt（agent-query upsert 返 service_only），
-- 断了 C4 反查(get_scheduled_run_as)/insert。serviceJwt 的 sub 经 PostgREST 注入到 claim 的路径待确认。
-- 恢复 036 版 RPC（无 sub check），C4 恢复。#4 改用 service 角色分离或调试 claim.sub 注入路径后续做。
CREATE OR REPLACE FUNCTION get_scheduled_run_as(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT run_as FROM scheduled_reports WHERE cron_job_id = $1 AND enabled LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION insert_scheduled_report(
  p_owner TEXT, p_cron_job_id TEXT, p_name TEXT, p_mode TEXT, p_template_key TEXT, p_query_intent TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  INSERT INTO scheduled_reports (owner_wecom_id, cron_job_id, name, mode, template_key, query_intent, delivery_to, run_as)
  VALUES (p_owner, p_cron_job_id, p_name, p_mode, p_template_key, p_query_intent, p_owner, p_owner)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
CREATE OR REPLACE FUNCTION get_scheduled_delivery_to(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT delivery_to FROM scheduled_reports WHERE cron_job_id = $1 AND enabled LIMIT 1;
$$;
DO $$ BEGIN RAISE NOTICE 'Migration 042 revert 041 applied'; END $$;
