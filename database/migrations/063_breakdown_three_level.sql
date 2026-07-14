-- 063_breakdown_three_level.sql
-- 门店三级分解: targets 加 breakdown_level/war_zone/region_l2 + 3 RPC 重建 + 视图按 level 分派 LATERAL
-- 幂等: ADD COLUMN IF NOT EXISTS; DO 块改 UNIQUE; CREATE OR REPLACE FUNCTION 显式 SECURITY DEFINER; DROP+CREATE VIEW

-- 1. targets 加列
ALTER TABLE targets ADD COLUMN IF NOT EXISTS breakdown_level TEXT DEFAULT 'store';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS war_zone TEXT;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS region_l2 TEXT;
-- 总目标 breakdown_level 置 NULL(默认 'store' 会让 check_breakdown_balance 把总目标值计入 storeSum)
UPDATE targets SET breakdown_level=NULL WHERE target_level='total';
-- 门店级 breakdown 回填 war_zone/region_l2(从 dim_branch)
UPDATE targets t SET war_zone=b.first_level_region, region_l2=b.second_level_region
  FROM dim_branch b WHERE t.target_level='breakdown' AND t.branch_num<>'ALL'
  AND b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num;

-- 2. UNIQUE 改造(加 breakdown_level/war_zone/region_l2 区分三级)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_type_branch_cat_key') THEN
    ALTER TABLE targets DROP CONSTRAINT targets_type_branch_cat_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_type_level_wz_r2_key') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_type_level_wz_r2_key
      UNIQUE (system_book_code, target_type, branch_num, category, breakdown_level, war_zone, region_l2, start_date, end_date);
  END IF;
END $$;

-- 3. upsert_target_breakdown 重建: 支持 war_zone/region_l2/store 三级
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_level TEXT; v_branch TEXT; v_wz TEXT; v_r2 TEXT; v_m TEXT;
  v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_level := COALESCE(v_row->>'breakdown_level', 'store');
    v_branch := v_row->>'branch_num';
    v_wz := v_row->>'war_zone';
    v_r2 := v_row->>'region_l2';
    -- 门店级: 从 dim_branch 取 brand/war_zone/region_l2
    IF v_level='store' THEN
      SELECT system_book_code, first_level_region, second_level_region
        INTO v_store_sbc, v_wz, v_r2 FROM dim_branch WHERE branch_num=v_branch LIMIT 1;
      v_store_sbc := COALESCE(v_store_sbc, p_sbc);
    ELSE
      v_store_sbc := p_sbc;  -- 战区/区域级 brand 同 parent
    END IF;
    -- 定位已有 breakdown(按 level+key)
    IF v_level='store' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='store' AND branch_num=v_branch LIMIT 1;
    ELSIF v_level='war_zone' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='war_zone' AND war_zone=v_wz LIMIT 1;
    ELSIF v_level='region_l2' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='region_l2' AND war_zone=v_wz AND region_l2=v_r2 LIMIT 1;
    END IF;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, war_zone, region_l2, created_by, created_at)
      SELECT t.name||'-'||COALESCE(v_branch, v_wz, v_r2), v_store_sbc, COALESCE(v_branch,'ALL'), t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, t.target_type, v_level, v_wz, v_r2, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id RETURNING id INTO v_sub;
    ELSE
      UPDATE targets SET system_book_code=v_store_sbc, war_zone=v_wz, region_l2=v_r2 WHERE id=v_sub;
      DELETE FROM target_metric_values WHERE target_id=v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value) VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n:=n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count',n);
END $$;

-- 4. get_breakdown 重建: 返三级 {warZoneRows, regionRows, storeRows}
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_build_object(
    'warZoneRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='war_zone'),'[]'::jsonb),
    'regionRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'region_l2',t.region_l2,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone,t.region_l2) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='region_l2'),'[]'::jsonb),
    'storeRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('branch_num',b.branch_num,'branch_name',b.branch_name,
      'war_zone',b.first_level_region,'region_l2',b.second_level_region,'group',e.custom_group,
      'metrics',COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
        WHERE s.parent_target_id=p_parent_id AND s.breakdown_level='store' AND s.branch_num=b.branch_num),'{}'::jsonb))
      ORDER BY b.first_level_region,b.second_level_region,b.branch_num)
      FROM dim_branch b LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
      WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99'),'[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;

-- 5. check_breakdown_balance 重建: 三级校验
CREATE OR REPLACE FUNCTION check_breakdown_balance(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_out JSONB;
BEGIN
  SELECT jsonb_object_agg(metric_code, jsonb_build_object(
    'total', total_val, 'warZoneSum', wz_sum, 'regionSum', r2_sum, 'storeSum', st_sum,
    'warZoneBalanced', total_val=wz_sum, 'regionBalanced', wz_sum=r2_sum, 'storeBalanced', r2_sum=st_sum))
  INTO v_out FROM (
    SELECT mv.metric_code,
      MAX(CASE WHEN t.id=p_parent_id THEN mv.target_value END) AS total_val,
      SUM(CASE WHEN t.breakdown_level='war_zone' THEN mv.target_value ELSE 0 END) AS wz_sum,
      SUM(CASE WHEN t.breakdown_level='region_l2' THEN mv.target_value ELSE 0 END) AS r2_sum,
      SUM(CASE WHEN t.breakdown_level='store' THEN mv.target_value ELSE 0 END) AS st_sum
    FROM targets t JOIN target_metric_values mv ON mv.target_id=t.id
    WHERE (t.id=p_parent_id OR t.parent_target_id=p_parent_id) GROUP BY mv.metric_code
  ) x;
  RETURN COALESCE(v_out,'{}'::jsonb);
END $$;

-- 6. report_achievement_v 重建: sale/delivery LATERAL 按 breakdown_level 分派
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
  t.system_book_code, t.branch_num, t.target_level, t.parent_target_id, t.target_type, t.category,
  t.breakdown_level, t.war_zone, t.region_l2,
  b.branch_name, b.first_level_region AS war_zone_dim, b.second_level_region AS region_l2_dim, b.region_name, b.city,
  mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
  CASE WHEN t.status='closed' THEN sn.actual_value
       WHEN md.metric_code='sale' AND md.data_ready THEN sa.sale_actual
       WHEN md.metric_code='delivery' AND md.data_ready THEN dl.delivery_actual
       WHEN md.metric_code='outbound_amt' AND md.data_ready THEN ob.outbound_amt_actual
       WHEN md.metric_code='outbound_profit' AND md.data_ready THEN ob.outbound_profit_actual END AS actual_value,
  CASE WHEN t.status='closed' THEN sn.data_status
       WHEN md.metric_code='sale' AND md.data_ready THEN
         CASE WHEN sa.sale_days=0 THEN 'missing' WHEN sa.sale_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code='delivery' AND md.data_ready THEN
         CASE WHEN dl.delivery_days=0 THEN 'missing' WHEN dl.delivery_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code IN ('outbound_amt','outbound_profit') AND md.data_ready THEN
         CASE WHEN ob.outbound_days=0 THEN 'missing' WHEN ob.outbound_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       ELSE 'not_ready' END AS data_status,
  (t.end_date-t.start_date+1) AS total_days,
  GREATEST(LEAST(current_date,t.end_date)-t.start_date+1,0) AS days_elapsed,
  CASE WHEN mv.target_value>0 AND t.status='closed' THEN sn.achievement_rate
       WHEN mv.target_value>0 AND md.metric_code='sale' AND md.data_ready AND sa.sale_actual IS NOT NULL THEN round((sa.sale_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='delivery' AND md.data_ready AND dl.delivery_actual IS NOT NULL THEN round((dl.delivery_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='outbound_amt' AND md.data_ready AND ob.outbound_amt_actual IS NOT NULL THEN round((ob.outbound_amt_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='outbound_profit' AND md.data_ready AND ob.outbound_profit_actual IS NOT NULL THEN round((ob.outbound_profit_actual/mv.target_value)::numeric,4) END AS achievement_rate,
  CASE WHEN t.status='active' AND mv.target_value>0 AND md.data_ready AND (LEAST(current_date,t.end_date)-t.start_date+1)>0 THEN
    CASE WHEN md.metric_code='sale' AND sa.sale_actual IS NOT NULL THEN round((sa.sale_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         WHEN md.metric_code='delivery' AND dl.delivery_actual IS NOT NULL THEN round((dl.delivery_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         WHEN md.metric_code='outbound_amt' AND ob.outbound_amt_actual IS NOT NULL THEN round((ob.outbound_amt_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         WHEN md.metric_code='outbound_profit' AND ob.outbound_profit_actual IS NOT NULL THEN round((ob.outbound_profit_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4) END END AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id=t.id
JOIN metric_definitions md ON md.metric_code=mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id=t.id AND sn.metric_code=mv.metric_code
LEFT JOIN LATERAL (
  -- sale: 按 breakdown_level 分派(store=branch_num / war_zone=战区聚合 / region_l2=区域聚合 / total=全部)
  SELECT SUM(r.total_sale) AS sale_actual, count(DISTINCT r.biz_date) AS sale_days
  FROM report_daily_sales r
  WHERE (t.system_book_code='ALL' OR r.system_book_code=t.system_book_code)
    AND r.biz_date BETWEEN t.start_date AND t.end_date
    AND (t.breakdown_level IS NULL OR t.target_level='total' OR
         (t.breakdown_level='store' AND (t.branch_num='ALL' OR r.branch_num=t.branch_num)) OR
         (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone)) OR
         (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2)))
) sa ON md.metric_code='sale'
LEFT JOIN LATERAL (
  SELECT SUM(d.out_money) AS delivery_actual, count(DISTINCT d.biz_date) AS delivery_days
  FROM report_daily_delivery d
  WHERE (t.system_book_code='ALL' OR d.system_book_code=t.system_book_code)
    AND d.biz_date BETWEEN t.start_date AND t.end_date
    AND (t.breakdown_level IS NULL OR t.target_level='total' OR
         (t.breakdown_level='store' AND (t.branch_num='ALL' OR d.branch_num=t.branch_num)) OR
         (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone)) OR
         (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2)))
) dl ON md.metric_code='delivery'
LEFT JOIN LATERAL (
  SELECT SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
    SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) AS outbound_profit_actual,
    count(DISTINCT COALESCE(d.biz_date,w.biz_date)) AS outbound_days
  FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
    ON d.system_book_code=w.system_book_code AND d.biz_date=w.biz_date AND d.branch_num=w.branch_num AND d.category_group=w.category_group
  WHERE (t.system_book_code='ALL' OR COALESCE(d.system_book_code,w.system_book_code)=t.system_book_code)
    AND COALESCE(d.biz_date,w.biz_date) BETWEEN t.start_date AND t.end_date
    AND ((t.category IS NOT NULL AND (d.category_group=t.category OR w.category_group=t.category))
         OR (t.category IS NULL AND (d.category_group IN ('水果','标品耗材') OR w.category_group IN ('水果','标品耗材'))))
) ob ON md.metric_code IN ('outbound_amt','outbound_profit');
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION check_breakdown_balance(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 063_breakdown_three_level completed'; END $$;
