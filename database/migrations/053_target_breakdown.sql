-- 053_target_breakdown.sql
-- 目标分解：targets 加 parent_target_id/target_level + report_achievement_v 重建(ALL全公司+war_zone=first_level_region) + 3 RPC
-- 幂等：ADD COLUMN IF NOT EXISTS；DROP+CREATE VIEW；CREATE OR REPLACE FUNCTION（新函数不冲突）

-- ===== 1. targets 加列（总/分解模型，向后兼容：默认 breakdown）=====
ALTER TABLE targets ADD COLUMN IF NOT EXISTS parent_target_id BIGINT;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_level TEXT DEFAULT 'breakdown';
CREATE INDEX IF NOT EXISTS idx_targets_parent ON targets(parent_target_id) WHERE parent_target_id IS NOT NULL;

-- ===== 2. report_achievement_v 重建：ALL→全公司达成 + war_zone=first_level_region =====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num, t.target_level, t.parent_target_id,
    b.branch_name,
    b.first_level_region AS war_zone,
    b.second_level_region AS region_l2,
    b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready,
    mv.target_value,
    CASE WHEN t.status='closed' THEN sn.actual_value
         WHEN md.metric_code='sale' AND md.data_ready THEN sa.sale_actual END AS actual_value,
    CASE WHEN t.status='closed' THEN sn.data_status
         WHEN md.metric_code='sale' AND md.data_ready THEN
           CASE WHEN sa.sale_days=0 THEN 'missing'
                WHEN sa.sale_days < (t.end_date-t.start_date+1) THEN 'partial'
                ELSE 'complete' END
         ELSE 'not_ready' END AS data_status,
    (t.end_date-t.start_date+1) AS total_days,
    GREATEST(LEAST(current_date,t.end_date)-t.start_date+1,0) AS days_elapsed,
    CASE WHEN mv.target_value>0 AND t.status='closed' THEN sn.achievement_rate
         WHEN mv.target_value>0 AND md.metric_code='sale' AND md.data_ready
         THEN round((COALESCE(sa.sale_actual,0)/mv.target_value)::numeric,4) END AS achievement_rate,
    CASE WHEN t.status='active' AND mv.target_value>0 AND md.metric_code='sale' AND md.data_ready
              AND (LEAST(current_date,t.end_date)-t.start_date+1)>0
         THEN round((COALESCE(sa.sale_actual,0)/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         END AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id=t.id
JOIN metric_definitions md ON md.metric_code=mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id=t.id AND sn.metric_code=mv.metric_code
LEFT JOIN LATERAL (
    SELECT SUM(r.total_sale) AS sale_actual, count(DISTINCT r.biz_date) AS sale_days
    FROM report_daily_sales r
    WHERE r.system_book_code=t.system_book_code
      AND (t.branch_num='ALL' OR r.branch_num=t.branch_num)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
) sa ON md.metric_code='sale';
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

-- ===== 3. upsert_target_total：建/改总目标(多指标)，返回 target_id =====
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_sbc TEXT, p_start DATE, p_end DATE, p_metrics JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT; v_m JSONB; v_check INT;
BEGIN
  -- 校验周期
  IF p_end < p_start THEN RETURN jsonb_build_object('ok',false,'error','周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, created_by, created_at)
    VALUES (p_name, p_sbc, 'ALL', p_start, p_end, 'active', 'total', p_by, NOW()) RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE targets SET name=p_name, start_date=p_start, end_date=p_end WHERE id=v_id AND target_level='total';
    DELETE FROM target_metric_values WHERE target_id=v_id;
  END IF;
  FOR v_m IN SELECT * FROM jsonb_array_elements(p_metrics) LOOP
    INSERT INTO target_metric_values(target_id, metric_code, target_value)
    VALUES (v_id, v_m->>'metric_code', (v_m->>'target_value')::numeric);
  END LOOP;
  RETURN jsonb_build_object('ok',true,'target_id',v_id);
END $$;

-- ===== 4. upsert_target_breakdown：批量 upsert 分解（rows: [{branch_num, metrics:{metric:value}}]）=====
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_branch TEXT; v_m JSONB; v_sub BIGINT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_branch := v_row->>'branch_num';
    -- 找/建分解 target（parent + branch）
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND branch_num=v_branch LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, created_by, created_at)
      SELECT t.name||'-'||v_branch, p_sbc, v_branch, t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id
      RETURNING id INTO v_sub;
    ELSE
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

-- ===== 5. check_breakdown_balance：校验分解总和 vs 总目标（每指标）=====
CREATE OR REPLACE FUNCTION check_breakdown_balance(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_object_agg(metric_code, jsonb_build_object('total', total_val, 'sum', sum_val, 'diff', total_val-sum_val, 'balanced', total_val=sum_val))
  INTO v_out
  FROM (
    SELECT mv.metric_code,
      MAX(CASE WHEN t.id=p_parent_id THEN mv.target_value END) AS total_val,
      SUM(CASE WHEN t.parent_target_id=p_parent_id THEN mv.target_value ELSE 0 END) AS sum_val
    FROM targets t
    JOIN target_metric_values mv ON mv.target_id=t.id
    WHERE (t.id=p_parent_id OR t.parent_target_id=p_parent_id)
    GROUP BY mv.metric_code
  ) x;
  RETURN COALESCE(v_out, '{}'::jsonb);
END $$;

-- ===== 6. get_breakdown：取某总目标的分解行（门店×指标）=====
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_metrics JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_agg(jsonb_build_object('branch_num',b.branch_num,'branch_name',b.branch_name,'war_zone',b.first_level_region,'group',e.custom_group,'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value) FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num),'{}'::jsonb)) ORDER BY b.first_level_region, b.branch_num)
  INTO v_metrics
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE b.system_book_code=v_sbc AND b.is_active=true AND b.branch_num<>'99';
  RETURN COALESCE(v_metrics, '[]'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION check_breakdown_balance(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 053 completed: targets 分解 + report_achievement_v ALL/war_zone 适配'; END $$;
