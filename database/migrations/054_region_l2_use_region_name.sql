-- 054_region_l2_use_region_name.sql
-- region_l2 改用 dim_branch.region_name（257 全覆盖，vs second_level_region 157/61%），二者同值
-- branch_admin_v 重建 + get_breakdown 重定义（region_l2=region_name，ORDER BY 战区+二级区域保证合并单元格连续）
-- 幂等：DROP+CREATE VIEW；CREATE OR REPLACE FUNCTION（RETURNS JSONB 不变）

DROP VIEW IF EXISTS branch_admin_v;
CREATE VIEW branch_admin_v AS
SELECT
  b.system_book_code, b.branch_num, b.branch_id, b.branch_code, b.branch_name,
  b.region_name, b.province, b.city, b.district, b.address, b.phone,
  b.enable, b.is_active,
  b.first_level_region AS war_zone,
  b.region_name AS region_l2,                  -- 二级区域用 region_name（全覆盖）
  b.branch_groups,
  e.custom_group, e.note,
  CASE WHEN b.first_level_region IS NULL THEN true ELSE false END AS unmapped
FROM dim_branch b
LEFT JOIN dim_branch_ext e ON e.system_book_code = b.system_book_code AND e.branch_num = b.branch_num
WHERE b.is_active = true;
ALTER VIEW branch_admin_v OWNER TO postgres;
ALTER VIEW branch_admin_v SET (security_invoker = true);
GRANT SELECT ON branch_admin_v TO authenticated, anon;

-- get_breakdown：region_l2 用 region_name；ORDER BY 战区+二级区域（合并单元格需要连续）
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_metrics JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_agg(jsonb_build_object(
    'branch_num', b.branch_num, 'branch_name', b.branch_name,
    'war_zone', b.first_level_region, 'region_l2', b.region_name,
    'group', e.custom_group,
    'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value) FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num), '{}'::jsonb)
  ) ORDER BY b.first_level_region NULLS LAST, b.region_name NULLS LAST, b.branch_num)
  INTO v_metrics
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE b.system_book_code=v_sbc AND b.is_active=true AND b.branch_num<>'99';
  RETURN COALESCE(v_metrics, '[]'::jsonb);
END $$;

DO $$ BEGIN RAISE NOTICE 'Migration 054 completed: region_l2 用 region_name(全覆盖)'; END $$;
