-- 045_report_brand_scoping.sql
-- 修复 report_daily_sales/category/weekly_trend 串品牌 bug（D 前置）
-- 根因：两品牌 branch_num 重叠 127，原 PK 无 system_book_code，/compute 聚合(GROUP BY date,branch_num)
--       把两品牌同号门店合并累加（实测 branch 68: report 9964.74 = 3120的4272.34 + 64188的5692.40）
-- 解法：① 三表加 system_book_code 列 + 改 PK；② report_*_v 重建加列（脱敏 CASE 照抄）；
--       ③ report_definitions 配置改 read_parquet(filename=true)+regexp_extract 路径解析按品牌分组；
--       ④ 历史 report 数据串品牌已不可信 → 首次迁移时 TRUNCATE，由 /compute 全历史重算回填
-- ⚠️ 幂等关键：TRUNCATE 必须只在"首次（system_book_code 列不存在）"执行！
--    migrate.sh 每次部署重跑全部迁移，若每次 TRUNCATE 会清空每次部署前的全部 report 数据（实测踩坑）。
--    用 DO 块判断列是否存在：首次 TRUNCATE+加列+改PK；重跑（列已存在）整体跳过。
-- 不建 report_weekly_trend_v（现状无此视图，weekly_trend 无成本列不需要脱敏）
-- 依赖：009(表)/010(配置)/032+037-039(视图 security_invoker)

-- ===== 0. 先 DROP 视图（解开基表依赖，便于改 PK）=====
DROP VIEW IF EXISTS report_daily_sales_v;
DROP VIEW IF EXISTS report_daily_category_v;

-- ===== 1. report_daily_sales：仅首次（无 system_book_code 列）TRUNCATE+加列+改PK =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='report_daily_sales' AND column_name='system_book_code') THEN
    ALTER TABLE report_daily_sales DROP CONSTRAINT IF EXISTS report_daily_sales_pkey;
    TRUNCATE TABLE report_daily_sales;
    ALTER TABLE report_daily_sales ADD COLUMN system_book_code TEXT NOT NULL;
    ALTER TABLE report_daily_sales ADD CONSTRAINT report_daily_sales_pkey
        PRIMARY KEY (biz_date, system_book_code, branch_num);
    CREATE INDEX IF NOT EXISTS idx_report_daily_sales_brand_branch
        ON report_daily_sales(system_book_code, branch_num, biz_date);
    RAISE NOTICE '045: report_daily_sales 首次初始化(TRUNCATE+加列+改PK)';
  ELSE
    RAISE NOTICE '045: report_daily_sales 已含 system_book_code，跳过(幂等)';
  END IF;
END $$;

-- ===== 2. report_daily_category：仅首次 TRUNCATE+加列+改PK =====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='report_daily_category' AND column_name='system_book_code') THEN
    ALTER TABLE report_daily_category DROP CONSTRAINT IF EXISTS report_daily_category_pkey;
    TRUNCATE TABLE report_daily_category;
    ALTER TABLE report_daily_category ADD COLUMN system_book_code TEXT NOT NULL;
    ALTER TABLE report_daily_category ADD CONSTRAINT report_daily_category_pkey
        PRIMARY KEY (biz_date, system_book_code, branch_num, category);
    RAISE NOTICE '045: report_daily_category 首次初始化(TRUNCATE+加列+改PK)';
  ELSE
    RAISE NOTICE '045: report_daily_category 已含 system_book_code，跳过(幂等)';
  END IF;
END $$;

-- ===== 3. report_weekly_trend：仅首次 TRUNCATE+加列+改PK（无 _v 视图）=====
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='report_weekly_trend' AND column_name='system_book_code') THEN
    ALTER TABLE report_weekly_trend DROP CONSTRAINT IF EXISTS report_weekly_trend_pkey;
    TRUNCATE TABLE report_weekly_trend;
    ALTER TABLE report_weekly_trend ADD COLUMN system_book_code TEXT NOT NULL;
    ALTER TABLE report_weekly_trend ADD CONSTRAINT report_weekly_trend_pkey
        PRIMARY KEY (week_start, system_book_code, branch_num);
    RAISE NOTICE '045: report_weekly_trend 首次初始化(TRUNCATE+加列+改PK)';
  ELSE
    RAISE NOTICE '045: report_weekly_trend 已含 system_book_code，跳过(幂等)';
  END IF;
END $$;

-- ===== 4. 重建 report_*_v（加 system_book_code，脱敏 CASE 照抄 032，security_invoker=true）=====
-- 视图重建本身幂等（DROP+CREATE），每次重跑无副作用
CREATE VIEW report_daily_sales_v AS
SELECT biz_date, system_book_code, branch_num, branch_name,
       total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_sales;
ALTER VIEW report_daily_sales_v OWNER TO postgres;
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
COMMENT ON VIEW report_daily_sales_v IS '每日门店销售汇总安全视图（成本列按 can_see_cost 脱敏；含 system_book_code 品牌隔离）';
GRANT SELECT ON report_daily_sales_v TO authenticated;

CREATE VIEW report_daily_category_v AS
SELECT biz_date, system_book_code, branch_num, category,
       total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_category;
ALTER VIEW report_daily_category_v OWNER TO postgres;
ALTER VIEW report_daily_category_v SET (security_invoker = true);
COMMENT ON VIEW report_daily_category_v IS '每日门店品类汇总安全视图（成本列按 can_see_cost 脱敏；含 system_book_code）';
GRANT SELECT ON report_daily_category_v TO authenticated;

-- ===== 5. report_definitions 配置：read_parquet(filename=true) 解析路径 company → system_book_code，GROUP BY 加它 =====
-- retail_detail parquet 文件内无 company 列（乐檬 API 不返回），company 只在路径 retail_detail/{companyId}/
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_sales',
    '每日门店销售汇总',
    'report_daily_sales',
    's3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    {{date_column}} as biz_date_raw,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(COUNT(DISTINCT order_no) AS INTEGER) as total_orders,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "biz_date_raw": {"pg_column": "biz_date", "transform": "YYYYMMDD_to_YYYY-MM-DD"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "branch_name": {"pg_column": "branch_name"},
    "total_orders": {"pg_column": "total_orders", "type": "INTEGER"},
    "total_items": {"pg_column": "total_items", "type": "INTEGER"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"},
    "total_profit": {"pg_column": "total_profit", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["biz_date", "system_book_code", "branch_num"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;

INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_category',
    '每日门店品类汇总',
    'report_daily_category',
    's3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    {{date_column}} as biz_date_raw,
    branch_num,
    item_category as category,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  AND item_category IS NOT NULL AND item_category != ''
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num, item_category
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num, item_category
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "biz_date_raw": {"pg_column": "biz_date", "transform": "YYYYMMDD_to_YYYY-MM-DD"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "category": {"pg_column": "category"},
    "total_items": {"pg_column": "total_items", "type": "INTEGER"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"},
    "total_profit": {"pg_column": "total_profit", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["biz_date", "system_book_code", "branch_num", "category"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;

INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'weekly_trend',
    '周销售趋势汇总',
    'report_weekly_trend',
    's3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d'))::DATE as week_start,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1),
         DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d')), branch_num
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), week_start, branch_num
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "week_start": {"pg_column": "week_start", "type": "DATE"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "branch_name": {"pg_column": "branch_name"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["week_start", "system_book_code", "branch_num"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;

DO $$ BEGIN RAISE NOTICE 'Migration 045_report_brand_scoping applied'; END $$;
