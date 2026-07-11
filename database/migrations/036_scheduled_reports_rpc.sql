-- 036_scheduled_reports_rpc.sql
-- C4 阶段2: scheduled_reports 管理 RPC（plugin 经 agent-query 调，SECURITY DEFINER 绕 RLS 但 CHECK run_as=owner）

-- 写绑定（create_scheduled_report 工具调；run_as=delivery_to=p_owner 钉死）
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
GRANT EXECUTE ON FUNCTION insert_scheduled_report(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated;

-- 查 delivery_to（push_report 工具调；强制收件人来自绑定，不信 LLM）
CREATE OR REPLACE FUNCTION get_scheduled_delivery_to(p_cron_job_id TEXT) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT delivery_to FROM scheduled_reports WHERE cron_job_id = $1 AND enabled LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION get_scheduled_delivery_to(TEXT) TO authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 036_scheduled_reports_rpc applied'; END $$;
