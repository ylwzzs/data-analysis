-- 048_target_admin_rpc.sql
-- D admin route RPC（SECURITY DEFINER 绕 RLS）
-- 背景：admin route 用 INSFORGE_API_KEY(role=anon)，而 targets/report_achievement_v 的 RLS policy
--       是 TO authenticated + GRANT 只给 authenticated → anon 既无 GRANT 又被 RLS 挡，看板返回空。
-- 解法：admin 操作走 SECURITY DEFINER RPC（以 owner=postgres 身份绕 RLS），照 collect_stats 先例。
-- 问数出口仍用 authenticated JWT + 视图 security_invoker RLS（用户按店裁），不受影响。

-- admin 看板：返回 report_achievement_v 全量（jsonb 数组）
CREATE OR REPLACE FUNCTION get_targets_admin() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (SELECT * FROM report_achievement_v) t;
$$;
GRANT EXECUTE ON FUNCTION get_targets_admin() TO authenticated, anon;

-- admin 录入：upsert 目标 + 指标值（校验 branch/日期；绕 RLS）
CREATE OR REPLACE FUNCTION upsert_target_admin(
    p_name text, p_sbc text, p_branch text, p_start date, p_end date,
    p_metrics jsonb, p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint;
BEGIN
  IF p_name IS NULL OR p_sbc IS NULL OR p_branch IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing required field');
  END IF;
  IF p_end < p_start THEN RETURN jsonb_build_object('ok', false, 'error', 'end_date < start_date'); END IF;
  IF NOT EXISTS (SELECT 1 FROM dim_branch WHERE system_book_code=p_sbc AND branch_num=p_branch AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'store not in dim_branch or inactive');
  END IF;
  INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, created_by)
  VALUES(p_name, p_sbc, p_branch, p_start, p_end, p_created_by)
  ON CONFLICT (system_book_code, branch_num, start_date, end_date)
  DO UPDATE SET name=EXCLUDED.name, updated_at=now()
  RETURNING id INTO v_id;
  DELETE FROM target_metric_values WHERE target_id=v_id;
  INSERT INTO target_metric_values(target_id, metric_code, target_value)
  SELECT v_id, e->>'metric_code', (e->>'target_value')::numeric
  FROM jsonb_array_elements(COALESCE(p_metrics, '[]'::jsonb)) e
  WHERE e->>'metric_code' IS NOT NULL AND (e->>'target_value') IS NOT NULL;
  RETURN jsonb_build_object('ok', true, 'target_id', v_id);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_admin(text,text,text,date,date,jsonb,text) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 048_target_admin_rpc applied'; END $$;
