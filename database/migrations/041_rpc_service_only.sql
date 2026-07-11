-- 041_rpc_service_only.sql
-- #4 修复：3 个 C4 RPC 收紧，只允许 agent-query service（sub=agent-query）调用，
-- 防 authenticated 用户直调 PostgREST 绕 plugin：get_scheduled_run_as 泄露创建者 userid、
-- insert_scheduled_report 孤儿绑定注入。
-- serviceJwt 由 agent-query signJwt({sub:"agent-query"}) 生成，RPC 内校验 claim.sub。
CREATE OR REPLACE FUNCTION get_scheduled_run_as(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub TEXT; v_run TEXT;
BEGIN
  v_sub := current_setting('request.jwt.claims.sub', true);
  IF v_sub IS DISTINCT FROM 'agent-query' THEN RAISE EXCEPTION 'service_only'; END IF;
  SELECT run_as INTO v_run FROM scheduled_reports WHERE cron_job_id = p_cron_job_id AND enabled LIMIT 1;
  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION insert_scheduled_report(
  p_owner TEXT, p_cron_job_id TEXT, p_name TEXT, p_mode TEXT, p_template_key TEXT, p_query_intent TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub TEXT; v_id UUID;
BEGIN
  v_sub := current_setting('request.jwt.claims.sub', true);
  IF v_sub IS DISTINCT FROM 'agent-query' THEN RAISE EXCEPTION 'service_only'; END IF;
  INSERT INTO scheduled_reports (owner_wecom_id, cron_job_id, name, mode, template_key, query_intent, delivery_to, run_as)
  VALUES (p_owner, p_cron_job_id, p_name, p_mode, p_template_key, p_query_intent, p_owner, p_owner)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_scheduled_delivery_to(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sub TEXT; v_to TEXT;
BEGIN
  v_sub := current_setting('request.jwt.claims.sub', true);
  IF v_sub IS DISTINCT FROM 'agent-query' THEN RAISE EXCEPTION 'service_only'; END IF;
  SELECT delivery_to INTO v_to FROM scheduled_reports WHERE cron_job_id = p_cron_job_id AND enabled LIMIT 1;
  RETURN v_to;
END;
$$;
DO $$ BEGIN RAISE NOTICE 'Migration 041_rpc_service_only applied'; END $$;
