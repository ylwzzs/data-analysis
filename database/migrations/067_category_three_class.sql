-- 067_category_three_class.sql
-- 商品品类改三类映射(用户确认): 生鲜→水果 / 标品+废弃档案+广西柳州→标品 / 包装耗材+运费仓储→耗材
-- 总部目标(outbound)所有类别全部统计, 分三类汇总(不再排除"其他", 6个L1全覆盖)
-- 1. daily_delivery + daily_wholesale sql_template 品类CASE改三类
-- 2. 视图 outbound LATERAL 品类列表 水果/标品/耗材; delivery UNION ALL(066) + sale(4战区) 不变
-- 幂等: UPDATE sql_template; DROP+CREATE VIEW; 须重算 delivery+wholesale + restart postgrest

-- 1. daily_delivery 品类映射改三类
UPDATE report_definitions SET sql_template = $$
 SELECT
   regexp_extract(d.filename,'transfer_detail/([0-9]+)/', 1) AS system_book_code,
   substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) AS biz_date_raw,
   response_branch_num AS branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果'
     WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
     WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
     ELSE '其他' END AS category_group,
   CAST(SUM(CAST(out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS out_money,
   CAST(SUM(CAST(profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS profit_money
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet') di ON di.system_book_code=regexp_extract(d.filename, 'transfer_detail/([0-9]+)/', 1) AND di.item_num=d.item_num
 WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4
 ORDER BY 1,2,3,4
$$ WHERE report_type='daily_delivery';

-- 2. daily_wholesale 品类映射改三类(保留066的 client_name→64188店映射)
UPDATE report_definitions SET sql_template = $$
 SELECT
   COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/', 1)) AS system_book_code,
   substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
   COALESCE(db.branch_num, '99') AS branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果'
     WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
     WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
     ELSE '其他' END AS category_group,
   CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_money,
   CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet') di ON di.system_book_code=regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1) AND di.item_num=d.item_num
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
 WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
$$ WHERE report_type='daily_wholesale';

-- 3. 重建视图: outbound LATERAL 品类列表 水果/标品/耗材(三类全部); sale(4战区)+delivery UNION ALL(066含64188店) 不变
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
  SELECT SUM(amt) AS delivery_actual, count(DISTINCT bd) AS delivery_days FROM (
    SELECT d.out_money AS amt, d.biz_date AS bd
    FROM report_daily_delivery d
    WHERE (t.system_book_code='ALL' OR d.system_book_code=t.system_book_code) AND d.biz_date BETWEEN t.start_date AND t.end_date
      AND (
        ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND is_assessed_war_zone(db.first_level_region)))
        OR (t.breakdown_level='store' AND d.branch_num=t.branch_num)
        OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone))
        OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
      )
    UNION ALL
    SELECT w.wholesale_money AS amt, w.biz_date AS bd
    FROM report_daily_wholesale w
    WHERE (t.system_book_code='ALL' OR w.system_book_code=t.system_book_code) AND w.biz_date BETWEEN t.start_date AND t.end_date
      AND (
        ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=w.branch_num AND db.system_book_code=w.system_book_code AND is_assessed_war_zone(db.first_level_region)))
        OR (t.breakdown_level='store' AND w.branch_num=t.branch_num)
        OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=w.branch_num AND db.system_book_code=w.system_book_code AND db.first_level_region=t.war_zone))
        OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=w.branch_num AND db.system_book_code=w.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
      )
  ) x
) dl ON md.metric_code='delivery'
LEFT JOIN LATERAL (
  -- 出库(总部目标): 全公司, 三类(水果/标品/耗材)全部统计
  SELECT SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
    SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) AS outbound_profit_actual,
    count(DISTINCT COALESCE(d.biz_date,w.biz_date)) AS outbound_days
  FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
    ON d.system_book_code=w.system_book_code AND d.biz_date=w.biz_date AND d.branch_num=w.branch_num AND d.category_group=w.category_group
  WHERE (t.system_book_code='ALL' OR COALESCE(d.system_book_code,w.system_book_code)=t.system_book_code)
    AND COALESCE(d.biz_date,w.biz_date) BETWEEN t.start_date AND t.end_date
    AND ((t.category IS NOT NULL AND (d.category_group=t.category OR w.category_group=t.category))
         OR (t.category IS NULL AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))))
) ob ON md.metric_code IN ('outbound_amt','outbound_profit');
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 067_category_three_class completed (须重算 delivery+wholesale + restart postgrest)'; END $$;
