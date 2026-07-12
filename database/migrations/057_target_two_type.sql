-- 057_target_two_type.sql
-- 两类目标：targets 加 target_type/category + UNIQUE改造 + metric_definitions加3指标 + view加2列 + hq品类分解RPC
-- 幂等：ADD COLUMN IF NOT EXISTS；DO块改UNIQUE；INSERT ON CONFLICT；DROP+CREATE VIEW；DROP FUNCTION旧签名+CREATE新签名
-- ⚠️ upsert_target_total 加参数须 DROP 旧签名(7参) 再 CREATE 新签名(8参)，否则重载残留

-- ===== 1. targets 加列 =====
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'store';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS category TEXT;

-- ===== 2. UNIQUE 改造（加 target_type + category，避免 hq 多品类行/hq vs store 总目标冲突）=====
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_system_book_code_branch_num_start_date_end_date_key') THEN
    ALTER TABLE targets DROP CONSTRAINT targets_system_book_code_branch_num_start_date_end_date_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_type_branch_cat_key') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_type_branch_cat_key
      UNIQUE (system_book_code, target_type, branch_num, category, start_date, end_date);
  END IF;
END $$;

-- ===== 3. metric_definitions 加3指标（data_ready=false，达成Phase2接）=====
INSERT INTO metric_definitions (metric_code, name, source_dataset, value_column, unit, data_ready, enabled, description) VALUES
  ('outbound_amt', '出库金额', NULL, NULL, '元', false, true,
   '配送金额+批发销售金额(delivery_detail.out_money + wholesale_detail.wholesale_money)'),
  ('outbound_profit', '出库毛利', NULL, NULL, '元', false, true,
   '配送毛利+批发毛利(delivery_detail.profit_money + wholesale_detail.wholesale_profit)'),
  ('delivery', '配送', NULL, NULL, '元', false, true,
   '门店调入额(delivery_detail.out_money by response_branch_num)')
ON CONFLICT (metric_code) DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, enabled=EXCLUDED.enabled, description=EXCLUDED.description;

-- ===== 4. report_achievement_v 加 target_type/category 列（DROP+CREATE）=====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num, t.target_level, t.parent_target_id,
    t.target_type, t.category,
    b.branch_name, b.first_level_region AS war_zone, b.second_level_region AS region_l2, b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
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

-- ===== 5. upsert_target_total：DROP旧签名(7参)+CREATE新签名(8参,加 p_target_type)=====
DROP FUNCTION IF EXISTS upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT);
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_sbc TEXT, p_start DATE, p_end DATE, p_metrics JSONB, p_target_type TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT; v_m JSONB;
BEGIN
  IF p_end < p_start THEN RETURN jsonb_build_object('ok',false,'error','周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, target_type, created_by, created_at)
    VALUES (p_name, p_sbc, 'ALL', p_start, p_end, 'active', 'total', COALESCE(p_target_type,'store'), p_by, NOW()) RETURNING id INTO v_id;
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

-- ===== 6. upsert_hq_category_breakdown：总部品类分解 rows:[{category,metrics:{code:val}}]=====
CREATE OR REPLACE FUNCTION upsert_hq_category_breakdown(
  p_parent_id BIGINT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_cat TEXT; v_m TEXT; v_sub BIGINT; v_sbc TEXT; n INT:=0;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_cat := v_row->>'category';
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND category=v_cat LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, category, created_by, created_at)
      SELECT t.name||'-'||v_cat, v_sbc, 'ALL', t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, 'hq', v_cat, p_by, NOW()
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

-- ===== 7. get_hq_category_breakdown：返 [{category, metrics:{code:val}}] =====
CREATE OR REPLACE FUNCTION get_hq_category_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_out JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', t.category, 'metrics',
    COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id), '{}'::jsonb)
  ) ORDER BY t.category), '[]'::jsonb)
  INTO v_out
  FROM targets t
  WHERE t.parent_target_id=p_parent_id AND t.category IS NOT NULL;
  RETURN v_out;
END $$;

-- ===== 8. get_target_type：取目标类型(给 route 分派用，绕 RLS) =====
CREATE OR REPLACE FUNCTION get_target_type(p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_t TEXT;
BEGIN
  SELECT target_type INTO v_t FROM targets WHERE id=p_id;
  RETURN v_t;
END $$;

GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_target_type(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 057_target_two_type completed'; END $$;
