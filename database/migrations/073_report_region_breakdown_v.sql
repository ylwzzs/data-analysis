-- 073_report_region_breakdown_v.sql
-- 门店零售/出库数据报表下钻视图（大区→小区→门店三层）
-- 幂等: DROP VIEW IF EXISTS + CREATE VIEW
-- 部署后需重启 postgrest: docker compose restart postgrest

-- 视图逻辑：
-- 1. 从 targets + target_metric_values 获取目标值
-- 2. 从 dim_branch 获取大区/小区层级关系
-- 3. 从 report_daily_sales/report_daily_delivery 聚合实际值
-- 4. 三层 UNION ALL：大区层(level='region') + 小区层(level='sub_region') + 门店层(level='store')

DROP VIEW IF EXISTS report_region_breakdown_v;

CREATE VIEW report_region_breakdown_v AS
WITH
-- 目标基础数据（只取 sale/delivery 指标）
target_base AS (
  SELECT
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    t.breakdown_level,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = 'active'
    AND t.breakdown_level = 'store'  -- 只有门店级目标才有下钻数据
),

-- 销售目标值
sale_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'sale'
),

-- 出库目标值
delivery_targets AS (
  SELECT tmv.target_id, tmv.target_value AS delivery_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'delivery'
),

-- 门店维表（含大区/小区层级）
branch_dim AS (
  SELECT
    branch_num,
    branch_name,
    first_level_region AS war_zone,
    second_level_region AS region_l2
  FROM dim_branch
  WHERE is_assessed_war_zone(first_level_region)  -- 只取考核战区
),

-- 销售实际值（按门店+目标聚合）
sale_actuals AS (
  SELECT
    tb.target_id,
    rds.branch_num,
    SUM(rds.total_sale) AS sale_actual,
    SUM(CASE WHEN rds.biz_date = tb.start_date + tb.days_elapsed - 1 THEN rds.total_sale ELSE 0 END) AS daily_sale
  FROM report_daily_sales rds
  JOIN target_base tb ON rds.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE rds.system_book_code = '64188'  -- 主品牌
  GROUP BY tb.target_id, rds.branch_num
),

-- 出库实际值（按门店+目标聚合，delivery+wholesale 合并）
delivery_actuals AS (
  SELECT
    tb.target_id,
    d.branch_num,
    SUM(COALESCE(d.out_money, 0)) AS delivery_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN COALESCE(d.out_money, 0) ELSE 0 END) AS daily_delivery
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE d.system_book_code = '64188'
  GROUP BY tb.target_id, d.branch_num
),

-- 门店层基础数据
store_level AS (
  SELECT
    tb.target_id,
    'store' AS level,
    bd.region_l2 AS parent_code,  -- 门店的上级是小区
    bd.war_zone AS region_code,
    bd.war_zone AS region_name,
    bd.region_l2 AS sub_region_code,
    bd.region_l2 AS sub_region_name,
    bd.branch_num,
    bd.branch_name,
    COALESCE(st.sale_target, 0) AS sale_target,
    COALESCE(sa.sale_actual, 0) AS sale_actual,
    CASE WHEN st.sale_target > 0 THEN ROUND(sa.sale_actual / st.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(dt.delivery_target, 0) AS delivery_target,
    COALESCE(da.delivery_actual, 0) AS delivery_actual,
    CASE WHEN dt.delivery_target > 0 THEN ROUND(da.delivery_actual / dt.delivery_target, 4) ELSE NULL END AS delivery_rate,
    COALESCE(sa.daily_sale, 0) AS daily_sale,
    COALESCE(da.daily_delivery, 0) AS daily_delivery,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND st.sale_target > 0
      THEN ROUND((st.sale_target - sa.sale_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_sale_target,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND dt.delivery_target > 0
      THEN ROUND((dt.delivery_target - da.delivery_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_delivery_target
  FROM target_base tb
  CROSS JOIN branch_dim bd
  LEFT JOIN sale_targets st ON st.target_id = tb.target_id
  LEFT JOIN sale_actuals sa ON sa.target_id = tb.target_id AND sa.branch_num = bd.branch_num
  LEFT JOIN delivery_targets dt ON dt.target_id = tb.target_id
  LEFT JOIN delivery_actuals da ON da.target_id = tb.target_id AND da.branch_num = bd.branch_num
),

-- 小区层（汇总门店）
sub_region_level AS (
  SELECT
    target_id,
    'sub_region' AS level,
    region_code AS parent_code,  -- 小区的上级是大区
    region_code,
    region_name,
    sub_region_code,
    sub_region_name,
    NULL AS branch_num,
    NULL AS branch_name,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target,
    SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale,
    SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM store_level
  GROUP BY target_id, region_code, region_name, sub_region_code, sub_region_name
),

-- 大区层（汇总小区）
region_level AS (
  SELECT
    target_id,
    'region' AS level,
    NULL AS parent_code,  -- 大区无上级
    region_code,
    region_name,
    NULL AS sub_region_code,
    NULL AS sub_region_name,
    NULL AS branch_num,
    NULL AS branch_name,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target,
    SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale,
    SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM sub_region_level
  GROUP BY target_id, region_code, region_name
)

SELECT * FROM region_level
UNION ALL
SELECT * FROM sub_region_level
UNION ALL
SELECT * FROM store_level;

ALTER VIEW report_region_breakdown_v OWNER TO postgres;
ALTER VIEW report_region_breakdown_v SET (security_invoker = true);
GRANT SELECT ON report_region_breakdown_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 073 completed: report_region_breakdown_v created'; END $$;
