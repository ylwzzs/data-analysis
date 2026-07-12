-- 058_outbound_achievement.sql
-- 出库/配送达成底座：2 日汇总表 + 2 /compute 配置 + metric_definitions data_ready + report_achievement_v 扩 delivery/outbound LATERAL
-- 口径：出库金额=delivery.out_money+wholesale.wholesale_money; 出库毛利=delivery.profit_money+wholesale.wholesale_profit
--       配送(门店,by调入店,全品类)=delivery.out_money; 出库(by品类)=水果(生鲜)+标品耗材(标品+包装耗材); 其他品类不计入出库目标
-- 幂等：CREATE TABLE IF NOT EXISTS；ON CONFLICT；DROP+CREATE VIEW；CREATE POLICY IF NOT EXISTS（用 DROP IF EXISTS 兜底）
-- ⚠️ report_achievement_v 加 LATERAL 须 DROP VIEW + CREATE（非 OR REPLACE）

-- ===== 1. report_daily_delivery：日×调入店×品类组 配送额/毛利 =====
CREATE TABLE IF NOT EXISTS report_daily_delivery (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, branch_num VARCHAR(20) NOT NULL,
  category_group VARCHAR(20) NOT NULL,   -- 水果/标品耗材/其他
  out_money NUMERIC(14,2) DEFAULT 0, profit_money NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (biz_date, system_book_code, branch_num, category_group)
);
CREATE INDEX IF NOT EXISTS idx_rdd_brand_branch ON report_daily_delivery(system_book_code, branch_num, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdd_brand_cat ON report_daily_delivery(system_book_code, category_group, biz_date);
DROP TRIGGER IF EXISTS update_report_daily_delivery_updated_at ON report_daily_delivery;
CREATE TRIGGER update_report_daily_delivery_updated_at BEFORE UPDATE ON report_daily_delivery FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
ALTER TABLE report_daily_delivery ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_delivery;
CREATE POLICY report_rls_branch_nums ON report_daily_delivery FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
);
GRANT SELECT ON report_daily_delivery TO authenticated, anon;

-- ===== 2. report_daily_wholesale：日×店×品类组 批发额/毛利 =====
CREATE TABLE IF NOT EXISTS report_daily_wholesale (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, branch_num VARCHAR(20) NOT NULL,
  category_group VARCHAR(20) NOT NULL,
  wholesale_money NUMERIC(14,2) DEFAULT 0, wholesale_profit NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (biz_date, system_book_code, branch_num, category_group)
);
CREATE INDEX IF NOT EXISTS idx_rdw_brand_branch ON report_daily_wholesale(system_book_code, branch_num, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdw_brand_cat ON report_daily_wholesale(system_book_code, category_group, biz_date);
DROP TRIGGER IF EXISTS update_report_daily_wholesale_updated_at ON report_daily_wholesale;
CREATE TRIGGER update_report_daily_wholesale_updated_at BEFORE UPDATE ON report_daily_wholesale FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
ALTER TABLE report_daily_wholesale ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_wholesale;
CREATE POLICY report_rls_branch_nums ON report_daily_wholesale FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
);
GRANT SELECT ON report_daily_wholesale TO authenticated, anon;

-- ===== 3. report_definitions：daily_delivery / daily_wholesale（/compute 从 parquet 聚合 + JOIN dim_item 映射品类组）=====
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys, enabled) VALUES
('daily_delivery', '每日门店品类配送汇总', 'report_daily_delivery',
 's3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet',
 $SQL$
 SELECT
   regexp_extract(filename, 'transfer_detail/([0-9]+)/', 1) AS system_book_code,
   substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) AS biz_date_raw,
   response_branch_num AS branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果'
     WHEN '标品' THEN '标品耗材'
     WHEN '包装耗材' THEN '标品耗材'
     ELSE '其他' END AS category_group,
   CAST(SUM(CAST(out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS out_money,
   CAST(SUM(CAST(profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS profit_money
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN dim_item di ON di.system_book_code=regexp_extract(d.filename, 'transfer_detail/([0-9]+)/', 1) AND di.item_num=d.item_num
 WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4
 ORDER BY 1,2,3,4
 $SQL$,
 '{"system_book_code":{"type":"TEXT","pg_column":"system_book_code"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"branch_num":{"type":"VARCHAR","pg_column":"branch_num"},"category_group":{"type":"VARCHAR","pg_column":"category_group"},"out_money":{"type":"DECIMAL(14,2)","pg_column":"out_money"},"profit_money":{"type":"DECIMAL(14,2)","pg_column":"profit_money"}}'::jsonb,
 'order_time', 'YYYYMMDD', '["biz_date","system_book_code","branch_num","category_group"]'::jsonb, true),
('daily_wholesale', '每日门店品类批发汇总', 'report_daily_wholesale',
 's3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet',
 $SQL$
 SELECT
   regexp_extract(filename, 'wholesale_detail/([0-9]+)/', 1) AS system_book_code,
   substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
   branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果'
     WHEN '标品' THEN '标品耗材'
     WHEN '包装耗材' THEN '标品耗材'
     ELSE '其他' END AS category_group,
   CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_money,
   CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN dim_item di ON di.system_book_code=regexp_extract(d.filename, 'wholesale_detail/([0-9]+)/', 1) AND di.item_num=d.item_num
 WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4
 ORDER BY 1,2,3,4
 $SQL$,
 '{"system_book_code":{"type":"TEXT","pg_column":"system_book_code"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"branch_num":{"type":"VARCHAR","pg_column":"branch_num"},"category_group":{"type":"VARCHAR","pg_column":"category_group"},"wholesale_money":{"type":"DECIMAL(14,2)","pg_column":"wholesale_money"},"wholesale_profit":{"type":"DECIMAL(14,2)","pg_column":"wholesale_profit"}}'::jsonb,
 'audit_time', 'YYYYMMDD', '["biz_date","system_book_code","branch_num","category_group"]'::jsonb, true)
ON CONFLICT (report_type) DO UPDATE SET name=EXCLUDED.name, target_table=EXCLUDED.target_table, source_pattern=EXCLUDED.source_pattern,
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, conflict_keys=EXCLUDED.conflict_keys, enabled=true;

-- ===== 4. metric_definitions 翻 data_ready（达成现可算）=====
UPDATE metric_definitions SET data_ready=true,
  source_dataset=CASE metric_code WHEN 'delivery' THEN 'report_daily_delivery' ELSE NULL END,
  value_column=CASE metric_code WHEN 'delivery' THEN 'out_money' ELSE NULL END,
  description=CASE metric_code
    WHEN 'outbound_amt' THEN '出库金额(delivery.out_money+wholesale.wholesale_money, 按品类水果/标品耗材)'
    WHEN 'outbound_profit' THEN '出库毛利(delivery.profit_money+wholesale.wholesale_profit, 按品类)'
    WHEN 'delivery' THEN '门店调入额(report_daily_delivery.out_money by 调入店, 全品类)'
  END
WHERE metric_code IN ('outbound_amt','outbound_profit','delivery');

-- ===== 5. report_achievement_v 重建：加 delivery / outbound LATERAL + 达成率/进度率泛化 =====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num, t.target_level, t.parent_target_id,
    t.target_type, t.category,
    b.branch_name, b.first_level_region AS war_zone, b.second_level_region AS region_l2, b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
    CASE WHEN t.status='closed' THEN sn.actual_value
         WHEN md.metric_code='sale' AND md.data_ready THEN sa.sale_actual
         WHEN md.metric_code='delivery' AND md.data_ready THEN dl.delivery_actual
         WHEN md.metric_code='outbound_amt' AND md.data_ready THEN ob.outbound_amt_actual
         WHEN md.metric_code='outbound_profit' AND md.data_ready THEN ob.outbound_profit_actual
    END AS actual_value,
    CASE WHEN t.status='closed' THEN sn.data_status
         WHEN md.metric_code='sale' AND md.data_ready THEN
           CASE WHEN sa.sale_days=0 THEN 'missing'
                WHEN sa.sale_days < (t.end_date-t.start_date+1) THEN 'partial'
                ELSE 'complete' END
         WHEN md.metric_code='delivery' AND md.data_ready THEN
           CASE WHEN dl.delivery_days=0 THEN 'missing'
                WHEN dl.delivery_days < (t.end_date-t.start_date+1) THEN 'partial'
                ELSE 'complete' END
         WHEN md.metric_code IN ('outbound_amt','outbound_profit') AND md.data_ready THEN
           CASE WHEN ob.outbound_days=0 THEN 'missing'
                WHEN ob.outbound_days < (t.end_date-t.start_date+1) THEN 'partial'
                ELSE 'complete' END
         ELSE 'not_ready' END AS data_status,
    (t.end_date-t.start_date+1) AS total_days,
    GREATEST(LEAST(current_date,t.end_date)-t.start_date+1,0) AS days_elapsed,
    CASE WHEN mv.target_value>0 AND t.status='closed' THEN sn.achievement_rate
         WHEN mv.target_value>0 AND md.metric_code='sale' AND md.data_ready
              AND sa.sale_actual IS NOT NULL THEN round((sa.sale_actual/mv.target_value)::numeric,4)
         WHEN mv.target_value>0 AND md.metric_code='delivery' AND md.data_ready
              AND dl.delivery_actual IS NOT NULL THEN round((dl.delivery_actual/mv.target_value)::numeric,4)
         WHEN mv.target_value>0 AND md.metric_code='outbound_amt' AND md.data_ready
              AND ob.outbound_amt_actual IS NOT NULL THEN round((ob.outbound_amt_actual/mv.target_value)::numeric,4)
         WHEN mv.target_value>0 AND md.metric_code='outbound_profit' AND md.data_ready
              AND ob.outbound_profit_actual IS NOT NULL THEN round((ob.outbound_profit_actual/mv.target_value)::numeric,4)
    END AS achievement_rate,
    CASE WHEN t.status='active' AND mv.target_value>0 AND md.data_ready
              AND (LEAST(current_date,t.end_date)-t.start_date+1)>0 THEN
         CASE
           WHEN md.metric_code='sale' AND sa.sale_actual IS NOT NULL THEN round((sa.sale_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
           WHEN md.metric_code='delivery' AND dl.delivery_actual IS NOT NULL THEN round((dl.delivery_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
           WHEN md.metric_code='outbound_amt' AND ob.outbound_amt_actual IS NOT NULL THEN round((ob.outbound_amt_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
           WHEN md.metric_code='outbound_profit' AND ob.outbound_profit_actual IS NOT NULL THEN round((ob.outbound_profit_actual/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         END
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
) sa ON md.metric_code='sale'
LEFT JOIN LATERAL (
    SELECT SUM(d.out_money) AS delivery_actual, count(DISTINCT d.biz_date) AS delivery_days
    FROM report_daily_delivery d
    WHERE d.system_book_code=t.system_book_code
      AND (t.branch_num='ALL' OR d.branch_num=t.branch_num)
      AND d.biz_date BETWEEN t.start_date AND t.end_date
) dl ON md.metric_code='delivery'
LEFT JOIN LATERAL (
    SELECT
      SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
      SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) AS outbound_profit_actual,
      count(DISTINCT COALESCE(d.biz_date,w.biz_date)) AS outbound_days
    FROM report_daily_delivery d
    FULL OUTER JOIN report_daily_wholesale w
      ON d.system_book_code=w.system_book_code AND d.biz_date=w.biz_date
         AND d.branch_num=w.branch_num AND d.category_group=w.category_group
    WHERE COALESCE(d.system_book_code,w.system_book_code)=t.system_book_code
      AND COALESCE(d.biz_date,w.biz_date) BETWEEN t.start_date AND t.end_date
      AND ((t.category IS NOT NULL AND (d.category_group=t.category OR w.category_group=t.category))
           OR (t.category IS NULL AND (d.category_group IN ('水果','标品耗材') OR w.category_group IN ('水果','标品耗材'))))
) ob ON md.metric_code IN ('outbound_amt','outbound_profit');
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 058_outbound_achievement completed'; END $$;
