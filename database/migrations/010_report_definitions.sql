-- 010_report_definitions.sql
-- 报表定义表：配置驱动的报表系统
-- 新增报表只需 INSERT 配置，无需修改代码

CREATE TABLE IF NOT EXISTS report_definitions (
    id SERIAL PRIMARY KEY,
    report_type VARCHAR(50) UNIQUE NOT NULL,    -- 报表类型标识（API 参数）
    name VARCHAR(100) NOT NULL,                  -- 报表名称（中文）
    target_table VARCHAR(100) NOT NULL,          -- PostgreSQL 目标表
    source_pattern VARCHAR(200) NOT NULL,        -- 数据源路径（S3 glob 模式）
    sql_template TEXT NOT NULL,                  -- 聚合 SQL 模板（支持占位符）
    field_mapping JSONB NOT NULL,                -- 字段映射配置
    date_column VARCHAR(100),                    -- 数据源日期列名
    date_format VARCHAR(20) DEFAULT 'YYYYMMDD',  -- 数据源日期格式
    conflict_keys JSONB DEFAULT '[]',            -- UPSERT 冲突键
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE report_definitions IS '报表定义配置表：新增报表只需插入配置';

COMMENT ON COLUMN report_definitions.report_type IS '报表类型标识，/compute API 参数';
COMMENT ON COLUMN report_definitions.target_table IS 'PostgreSQL 目标汇总表';
COMMENT ON COLUMN report_definitions.source_pattern IS '数据源路径，支持 S3 glob 模式';
COMMENT ON COLUMN report_definitions.sql_template IS '聚合 SQL，支持 {{占位符}}';
COMMENT ON COLUMN report_definitions.field_mapping IS '字段映射：Parquet 列 → PG 列 + 类型转换';
COMMENT ON COLUMN report_definitions.conflict_keys IS 'UPSERT 冲突键数组，如 ["biz_date", "branch_num"]';

-- 占位符说明：
-- {{source_pattern}}  → source_pattern 字段值
-- {{date_column}}      → date_column 字段值
-- {{date_from}}        → YYYY-MM-DD 格式
-- {{date_to}}          → YYYY-MM-DD 格式
-- {{date_from_compact}} → YYYYMMDD 格式（乐檬数据）
-- {{date_to_compact}}   → YYYYMMDD 格式

-- 字段映射格式：
-- {
--   "parquet_column": {
--     "pg_column": "pg_column_name",
--     "type": "VARCHAR|INTEGER|DECIMAL(12,2)|DATE",
--     "transform": "YYYYMMDD_to_YYYY-MM-DD | uppercase | null"
--   }
-- }

-- 权限
GRANT SELECT ON report_definitions TO authenticated;

-- 更新触发器（幂等：先删后建）
DROP TRIGGER IF EXISTS update_report_definitions_updated_at ON report_definitions;
CREATE TRIGGER update_report_definitions_updated_at
    BEFORE UPDATE ON report_definitions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 插入已有报表定义 =====

-- 1. 每日门店销售汇总
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_sales',
    '每日门店销售汇总',
    'report_daily_sales',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    {{date_column}} as biz_date_raw,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(COUNT(DISTINCT order_no) AS INTEGER) as total_orders,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}')
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY {{date_column}}, branch_num
ORDER BY {{date_column}}, branch_num
$SQL$,
    $JSON$
{
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
    '["biz_date", "branch_num"]'::jsonb
);

-- 2. 每日品类汇总
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_category',
    '每日门店品类汇总',
    'report_daily_category',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    {{date_column}} as biz_date_raw,
    branch_num,
    item_category as category,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}')
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  AND item_category IS NOT NULL AND item_category != ''
GROUP BY {{date_column}}, branch_num, item_category
ORDER BY {{date_column}}, branch_num, item_category
$SQL$,
    $JSON$
{
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
    '["biz_date", "branch_num", "category"]'::jsonb
);

-- 3. 周趋势汇总
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'weekly_trend',
    '周销售趋势汇总',
    'report_weekly_trend',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d'))::DATE as week_start,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale
FROM read_parquet('{{source_pattern}}')
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d')), branch_num
ORDER BY week_start, branch_num
$SQL$,
    $JSON$
{
    "week_start": {"pg_column": "week_start", "type": "DATE"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "branch_name": {"pg_column": "branch_name"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["week_start", "branch_num"]'::jsonb
);
