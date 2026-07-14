-- 062_breakdown_all_brand.sql
-- 全公司目标(system_book_code='ALL')分解支持两品牌门店:
-- - get_breakdown: parent sbc='ALL' 时返两品牌全部门店(不只单品牌)
-- - upsert_target_breakdown: 每门店 system_book_code 从 dim_branch 查(按 branch_num 定品牌),不依赖单一 p_sbc
-- 幂等: CREATE OR REPLACE FUNCTION(显式 SECURITY DEFINER,防默认 INVOKER 致 permission denied,061 踩过)

-- 1. get_breakdown: ALL 时返两品牌门店
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'branch_num', b.branch_num, 'branch_name', b.branch_name,
    'war_zone', b.first_level_region, 'region_l2', b.second_level_region, 'group', e.custom_group,
    'system_book_code', b.system_book_code,
    'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value)
      FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
      WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num), '{}'::jsonb)
  ) ORDER BY b.first_level_region, b.second_level_region, b.branch_num), '[]'::jsonb)
  INTO v_out
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99';
  RETURN v_out;
END $$;

-- 2. upsert_target_breakdown: 每门店 system_book_code 从 dim_branch 查(按 branch_num 定品牌),p_sbc 仅 fallback
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_branch TEXT; v_m TEXT; v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_branch := v_row->>'branch_num';
    -- 该门店的品牌(从 dim_branch 查),查不到 fallback p_sbc
    SELECT system_book_code INTO v_store_sbc FROM dim_branch WHERE branch_num=v_branch LIMIT 1;
    v_store_sbc := COALESCE(v_store_sbc, p_sbc);
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND branch_num=v_branch LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, created_by, created_at)
      SELECT t.name||'-'||v_branch, v_store_sbc, v_branch, t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id
      RETURNING id INTO v_sub;
    ELSE
      UPDATE targets SET system_book_code=v_store_sbc WHERE id=v_sub;
      DELETE FROM target_metric_values WHERE target_id=v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value)
      VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n := n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count',n);
END $$;

GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 062_breakdown_all_brand completed'; END $$;
