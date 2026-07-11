-- 032_report_security_views.sql
-- C0: report_* 列级成本脱敏（spec §3.2）。daily_sales/category 有 total_profit → 建 _v 按 can_see_cost 脱敏；
--     weekly_trend 无成本列，不建 _v（保持原表）。原表收回 SELECT，查询走 _v（DB 层权威，防绕过）。
-- 幂等：视图用 DROP+CREATE（CLAUDE.md 坑：CREATE OR REPLACE 给视图加列后重跑报 cannot drop columns）。

DROP VIEW IF EXISTS report_daily_sales_v;
DROP VIEW IF EXISTS report_daily_category_v;

CREATE VIEW report_daily_sales_v AS
SELECT biz_date, branch_num, branch_name, total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_sales;

CREATE VIEW report_daily_category_v AS
SELECT biz_date, branch_num, branch_name, category, total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_category;

COMMENT ON VIEW report_daily_sales_v IS '每日门店销售汇总（成本列按 can_see_cost 脱敏；spec C0）';
COMMENT ON VIEW report_daily_category_v IS '每日品类汇总（成本列按 can_see_cost 脱敏；spec C0）';

-- 原表收回 SELECT（service 写账号仍可写，authenticated 改查 _v）
REVOKE SELECT ON report_daily_sales FROM anon, authenticated;
REVOKE SELECT ON report_daily_category FROM anon, authenticated;
GRANT SELECT ON report_daily_sales_v TO authenticated;
GRANT SELECT ON report_daily_category_v TO authenticated;
-- weekly_trend 无敏感列，009 已 GRANT SELECT 给 authenticated，保持

-- datasets 注册：_v 暴露，原表移出 exposed
UPDATE datasets SET exposed = false WHERE name IN ('report_daily_sales', 'report_daily_category');

INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
  ('report_daily_sales_v',  '每日门店销售汇总(脱敏)', 'pg_table', 'report_daily_sales_v',  'summary', FALSE, TRUE, 'biz_date', 'YYYY-MM-DD', FALSE, TRUE, '成本列 total_profit 按 can_see_cost 脱敏（spec C0）'),
  ('report_daily_category_v','每日品类汇总(脱敏)',    'pg_table', 'report_daily_category_v','summary', FALSE, TRUE, 'biz_date', 'YYYY-MM-DD', FALSE, TRUE, '成本列 total_profit 按 can_see_cost 脱敏（spec C0）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, exposed=EXCLUDED.exposed, description=EXCLUDED.description;

-- dataset_columns: _v 的 total_profit 标 is_sensitive（成本组）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
  ('report_daily_sales_v',  'total_profit', 'DECIMAL', '金额', TRUE, NULL, '利润（can_see_cost=false→NULL）', 7),
  ('report_daily_category_v','total_profit','DECIMAL', '金额', TRUE, NULL, '利润（can_see_cost=false→NULL）', 8)
ON CONFLICT (dataset_name, name) DO UPDATE SET is_sensitive=EXCLUDED.is_sensitive, description=EXCLUDED.description;

DO $$ BEGIN RAISE NOTICE 'Migration 032_report_security_views applied'; END $$;
