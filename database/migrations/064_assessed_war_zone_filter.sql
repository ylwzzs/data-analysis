-- 064_assessed_war_zone_filter.sql
-- 目标考核范围收窄到 4 大战区(东部/南部/西部/中部): 其余战区门店不参与考核
-- - is_assessed_war_zone() 白名单函数(单一真相源, 改名单只改这里)
-- - report_achievement_v: total 行 actual 加战区过滤(sale/delivery/outbound); store/war_zone/region_l2 行天然按店/战区不变
-- - get_breakdown: storeRows 只返 4 战区门店
-- - check_breakdown_balance: 各级 sum 加战区过滤(非4战区目标不参与校验)
-- - 清理非 4 战区 breakdown 目标行(store/war_zone/region_l2)
-- 幂等: CREATE OR REPLACE FUNCTION(显式 SECURITY DEFINER); DROP+CREATE VIEW; DELETE 重跑删0行
-- ⚠️ 加视图/RPC 后须 restart postgrest 刷 schema 缓存(GHA migrate 不保证重启)

-- 0. 白名单函数
CREATE OR REPLACE FUNCTION is_assessed_war_zone(p TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT p IN ('东部战区','南部战区','西部战区','中部战区') $$;

-- 0b. 重新回填 store breakdown 的 war_zone/region_l2(防 063 回填遗漏致误删)
UPDATE targets t SET war_zone=b.first_level_region, region_l2=b.second_level_region
  FROM dim_branch b
  WHERE t.target_level='breakdown' AND t.breakdown_level='store' AND t.branch_num<>'ALL'
    AND b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num;

-- 1. report_achievement_v 重建: total 行 actual 限定 4 战区门店
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
  -- sale: total 行限定 4 战区门店; store/war_zone/region_l2 按店/战区
  SELECT SUM(r.total_sale) AS sale_actual, count(DISTINCT r.biz_date) AS sale_days
  FROM report_daily_sales r
  WHERE (t.system_book_code='ALL' OR r.system_book_code=t.system_book_code)
    AND r.biz_date BETWEEN t.start_date AND t.end_date
    AND (
      ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND is_assessed_war_zone(db.first_level_region)))
      OR (t.breakdown_level='store' AND (t.branch_num='ALL' OR r.branch_num=t.branch_num))
      OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone))
      OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
    )
) sa ON md.metric_code='sale'
LEFT JOIN LATERAL (
  SELECT SUM(d.out_money) AS delivery_actual, count(DISTINCT d.biz_date) AS delivery_days
  FROM report_daily_delivery d
  WHERE (t.system_book_code='ALL' OR d.system_book_code=t.system_book_code)
    AND d.biz_date BETWEEN t.start_date AND t.end_date
    AND (
      ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND is_assessed_war_zone(db.first_level_region)))
      OR (t.breakdown_level='store' AND (t.branch_num='ALL' OR d.branch_num=t.branch_num))
      OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone))
      OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
    )
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
    AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=COALESCE(d.branch_num,w.branch_num) AND db.system_book_code=COALESCE(d.system_book_code,w.system_book_code) AND is_assessed_war_zone(db.first_level_region))
) ob ON md.metric_code IN ('outbound_amt','outbound_profit');
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

-- 2. get_breakdown: storeRows 只返 4 战区门店
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
      WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99'
        AND is_assessed_war_zone(b.first_level_region)),'[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;

-- 3. check_breakdown_balance: 各级 sum 加战区过滤(非4战区目标不参与校验)
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
      SUM(CASE WHEN t.breakdown_level='war_zone' AND is_assessed_war_zone(t.war_zone) THEN mv.target_value ELSE 0 END) AS wz_sum,
      SUM(CASE WHEN t.breakdown_level='region_l2' AND is_assessed_war_zone(t.war_zone) THEN mv.target_value ELSE 0 END) AS r2_sum,
      SUM(CASE WHEN t.breakdown_level='store' AND is_assessed_war_zone(t.war_zone) THEN mv.target_value ELSE 0 END) AS st_sum
    FROM targets t JOIN target_metric_values mv ON mv.target_id=t.id
    WHERE (t.id=p_parent_id OR t.parent_target_id=p_parent_id) GROUP BY mv.metric_code
  ) x;
  RETURN COALESCE(v_out,'{}'::jsonb);
END $$;

-- 4. 清理非 4 战区 breakdown 目标行(store/war_zone/region_l2 级)及对应指标值
DELETE FROM target_metric_values WHERE target_id IN (
  SELECT id FROM targets WHERE target_level='breakdown' AND breakdown_level IN ('store','war_zone','region_l2')
    AND NOT is_assessed_war_zone(war_zone)
);
DELETE FROM targets WHERE target_level='breakdown' AND breakdown_level IN ('store','war_zone','region_l2')
  AND NOT is_assessed_war_zone(war_zone);

GRANT EXECUTE ON FUNCTION is_assessed_war_zone(TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION check_breakdown_balance(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 064_assessed_war_zone_filter completed'; END $$;
