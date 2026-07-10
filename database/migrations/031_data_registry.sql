-- 031_data_registry.sql
-- 子系统B 数据注册中心：datasets + dataset_columns + get_data_dictionary() RPC
-- 取代 SKILL.md / agent-query 两处硬编码的数据知识。幂等（IF NOT EXISTS / ON CONFLICT）。
-- 设计：docs/superpowers/specs/2026-07-10-data-registry-design.md

-- ===== 1. datasets：可查数据集注册表 =====
CREATE TABLE IF NOT EXISTS datasets (
    name            TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    engine          TEXT NOT NULL,             -- 'duckdb_view' | 'pg_table'
    source          TEXT NOT NULL,             -- duckdb_view: parquet glob；pg_table: PG 表名/视图名
    kind            TEXT NOT NULL,             -- 'fact' | 'summary' | 'dim' | 'view'
    is_realtime     BOOLEAN NOT NULL DEFAULT FALSE,
    columns_typed   BOOLEAN NOT NULL DEFAULT FALSE,
    date_column     TEXT,
    date_format     TEXT,
    carry_enabled   BOOLEAN NOT NULL DEFAULT FALSE,  -- 维表：C 是否已接小表搬运（可 JOIN 进 DuckDB）
    exposed         BOOLEAN NOT NULL DEFAULT TRUE,   -- 进 LLM 字典 + 引擎可路由
    description     TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by      TEXT
);
COMMENT ON TABLE datasets IS '数据注册中心：可查数据集（LLM 字典 + agent-query 路由/脱敏单一事实源）';

DROP TRIGGER IF EXISTS update_datasets_updated_at ON datasets;
CREATE TRIGGER update_datasets_updated_at BEFORE UPDATE ON datasets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 2. dataset_columns：列注册表 =====
CREATE TABLE IF NOT EXISTS dataset_columns (
    dataset_name    TEXT NOT NULL REFERENCES datasets(name) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    data_type       TEXT,
    semantic_group  TEXT,
    is_sensitive    BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE → 按 can_see_cost 整组脱敏
    join_to         TEXT,
    description     TEXT,
    ordinal         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dataset_name, name)
);
CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset ON dataset_columns(dataset_name);
COMMENT ON TABLE dataset_columns IS '数据集列注册表；is_sensitive 整组按 can_see_cost 脱敏';

-- ===== 3. get_data_dictionary() RPC =====
CREATE OR REPLACE FUNCTION get_data_dictionary()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE ds JSONB; cols JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.kind, d.name), '[]'::jsonb)
      INTO ds
      FROM (SELECT name, display_name, engine, kind, is_realtime, columns_typed,
                   date_column, date_format, carry_enabled, description
              FROM datasets WHERE exposed) d;
    SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.dataset_name, c.ordinal), '[]'::jsonb)
      INTO cols
      FROM (SELECT col.dataset_name, col.name, col.data_type, col.semantic_group,
                   col.is_sensitive, col.join_to, col.description, col.ordinal
              FROM dataset_columns col JOIN datasets ds ON ds.name = col.dataset_name
             WHERE ds.exposed) c;
    RETURN jsonb_build_object('datasets', ds, 'columns', cols);
END;
$$;
COMMENT ON FUNCTION get_data_dictionary IS '返回塑形数据字典（LLM 注入 + 引擎读取共用）';

-- ===== 4. 权限 =====
GRANT SELECT ON datasets, dataset_columns TO authenticated;
GRANT EXECUTE ON FUNCTION get_data_dictionary() TO authenticated;

-- ===== 5. 退役臆想的 data_sources_meta（同 lemeng_items 教训：只读保留备查）=====
REVOKE INSERT, UPDATE, DELETE ON data_sources_meta FROM anon, authenticated;

-- ===== 6. 种真实数据集 =====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
 ('retail_detail','销售明细(乐檬POS明细)','duckdb_view',
  's3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet','fact',TRUE,FALSE,
  'order_detail_bizday','YYYYMMDD',FALSE,TRUE,'实时增量明细（当天有）；全字符串列，数学运算须 CAST'),
 ('report_daily_sales','每日门店销售汇总','pg_table','report_daily_sales','summary',FALSE,TRUE,
  'biz_date','DATE',FALSE,TRUE,'按日+门店汇总（/compute 写入，滞后约1天）'),
 ('report_daily_category','每日门店品类汇总','pg_table','report_daily_category','summary',FALSE,TRUE,
  'biz_date','DATE',FALSE,TRUE,'按日+门店+品类汇总'),
 ('report_weekly_trend','周销售趋势','pg_table','report_weekly_trend','summary',FALSE,TRUE,
  'week_start','DATE',FALSE,TRUE,'按周+门店，含环比'),
 ('dim_item','商品档案','pg_table','dim_item','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'商品维表；直接查询 OK，JOIN 进明细待 C(carry_enabled)'),
 ('canonical_product','跨品牌商品合并视图','pg_table','canonical_product','view',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'按 item_code 跨品牌合并'),
 ('dim_branch','门店档案','pg_table','dim_branch','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'门店维表；直接查询 OK，JOIN 进明细待 C'),
 ('dim_region','战区字典','pg_table','dim_region','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'区域→战区映射（统一管理）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  columns_typed=EXCLUDED.columns_typed, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, description=EXCLUDED.description;

-- ===== 7. retail_detail 列（成本组 is_sensitive=TRUE，整组脱敏）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('retail_detail','order_no','VARCHAR','订单',FALSE,NULL,'订单号',1),
 ('retail_detail','order_detail_num','VARCHAR','订单',FALSE,NULL,'明细号',2),
 ('retail_detail','order_time','VARCHAR','订单',FALSE,NULL,'下单时间 YYYY-MM-DD HH:MM:SS',3),
 ('retail_detail','order_detail_bizday','VARCHAR','订单',FALSE,NULL,'业务日 YYYYMMDD（按日过滤用）',4),
 ('retail_detail','order_sale_channel','VARCHAR','订单',FALSE,NULL,'销售渠道',5),
 ('retail_detail','order_sale_type','VARCHAR','订单',FALSE,NULL,'销售类型',6),
 ('retail_detail','state','VARCHAR','订单',FALSE,NULL,'状态',7),
 ('retail_detail','branch_num','VARCHAR','门店',FALSE,'dim_branch(system_book_code,branch_num)','门店号（JOIN 键）',8),
 ('retail_detail','branch_code','VARCHAR','门店',FALSE,NULL,'门店编码',9),
 ('retail_detail','branch_name','VARCHAR','门店',FALSE,NULL,'门店名',10),
 ('retail_detail','item_num','VARCHAR','商品',FALSE,'dim_item(system_book_code,item_num)','商品号（JOIN 键）',11),
 ('retail_detail','item_code','VARCHAR','商品',FALSE,'canonical_product(item_code)','商品业务码（跨品牌合并键）',12),
 ('retail_detail','item_name','VARCHAR','商品',FALSE,NULL,'商品名',13),
 ('retail_detail','item_category','VARCHAR','商品',FALSE,NULL,'品类',14),
 ('retail_detail','item_spec','VARCHAR','商品',FALSE,NULL,'规格',15),
 ('retail_detail','item_unit','VARCHAR','商品',FALSE,NULL,'单位',16),
 ('retail_detail','department','VARCHAR','商品',FALSE,NULL,'部门',17),
 ('retail_detail','item_regular_price','VARCHAR','商品',FALSE,NULL,'正常售价',18),
 ('retail_detail','supplier_num','VARCHAR','供应商',FALSE,NULL,'供应商号',19),
 ('retail_detail','supplier_name','VARCHAR','供应商',FALSE,NULL,'供应商名',20),
 ('retail_detail','supplier_code','VARCHAR','供应商',FALSE,NULL,'供应商码',21),
 ('retail_detail','sale_money','VARCHAR','金额',FALSE,NULL,'销售金额',22),
 ('retail_detail','discount_money','VARCHAR','金额',FALSE,NULL,'折扣金额',23),
 ('retail_detail','payment_receipt_money','VARCHAR','金额',FALSE,NULL,'收款金额',24),
 ('retail_detail','order_detail_price','VARCHAR','金额',FALSE,NULL,'明细单价',25),
 ('retail_detail','total_amount','VARCHAR','金额',FALSE,NULL,'总金额',26),
 ('retail_detail','tax_money','VARCHAR','金额',FALSE,NULL,'税额',27),
 ('retail_detail','discount_rate','VARCHAR','折扣率',FALSE,NULL,'折扣率',28),
 ('retail_detail','overall_discount_rate','VARCHAR','折扣率',FALSE,NULL,'整体折扣率',29),
 ('retail_detail','management_style_type','VARCHAR','经营',FALSE,NULL,'经营方式',30),
 ('retail_detail','order_payee','VARCHAR','经营',FALSE,NULL,'收款人',31),
 ('retail_detail','order_sold_by','VARCHAR','经营',FALSE,NULL,'销售员',32),
 ('retail_detail','item_cost_price','VARCHAR','成本',TRUE,NULL,'成本价（无权限=NULL）',33),
 ('retail_detail','order_detail_cost','VARCHAR','成本',TRUE,NULL,'明细成本（无权限=NULL）',34),
 ('retail_detail','order_detail_grade_cost','VARCHAR','成本',TRUE,NULL,'分级成本（无权限=NULL）',35),
 ('retail_detail','cost','VARCHAR','成本',TRUE,NULL,'成本（无权限=NULL）',36),
 ('retail_detail','profit','VARCHAR','成本',TRUE,NULL,'利润（无权限=NULL）',37),
 ('retail_detail','sale_profit_rate','VARCHAR','成本',TRUE,NULL,'利润率（无权限=NULL）',38)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type,
  semantic_group=EXCLUDED.semantic_group, is_sensitive=EXCLUDED.is_sensitive,
  join_to=EXCLUDED.join_to, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

-- ===== 8. 汇总表列（已 typed，直接算无需 CAST）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, description, ordinal) VALUES
 ('report_daily_sales','biz_date','DATE','日期',FALSE,'业务日',1),
 ('report_daily_sales','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_daily_sales','branch_name','VARCHAR','门店',FALSE,'门店名',3),
 ('report_daily_sales','total_orders','INTEGER','订单',FALSE,'订单数',4),
 ('report_daily_sales','total_items','INTEGER','销量',FALSE,'商品件数',5),
 ('report_daily_sales','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',6),
 ('report_daily_sales','total_profit','DECIMAL(12,2)','成本',FALSE,'利润',7),
 ('report_daily_category','biz_date','DATE','日期',FALSE,'业务日',1),
 ('report_daily_category','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_daily_category','category','VARCHAR','商品',FALSE,'品类',3),
 ('report_daily_category','total_items','INTEGER','销量',FALSE,'商品件数',4),
 ('report_daily_category','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',5),
 ('report_daily_category','total_profit','DECIMAL(12,2)','成本',FALSE,'利润',6),
 ('report_weekly_trend','week_start','DATE','日期',FALSE,'周起始日',1),
 ('report_weekly_trend','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_weekly_trend','branch_name','VARCHAR','门店',FALSE,'门店名',3),
 ('report_weekly_trend','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',4),
 ('report_weekly_trend','prev_week_sale','DECIMAL(12,2)','金额',FALSE,'上周销售额',5),
 ('report_weekly_trend','growth_rate','DECIMAL(5,2)','金额',FALSE,'环比增长率',6)
ON CONFLICT (dataset_name, name) DO NOTHING;

-- ===== 9. 维表关键列（直接查询用；JOIN 提示标 carry_enabled 状态）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('dim_item','system_book_code','TEXT','品牌',FALSE,NULL,'品牌(3120/64188)',1),
 ('dim_item','item_num','TEXT','商品',FALSE,'retail_detail(item_num)','商品号（品牌内）',2),
 ('dim_item','item_code','TEXT','商品',FALSE,'canonical_product(item_code)','跨品牌合并键',3),
 ('dim_item','item_name','TEXT','商品',FALSE,NULL,'商品名',4),
 ('dim_item','top_category','TEXT','商品',FALSE,NULL,'顶级品类',5),
 ('dim_item','category_path','TEXT','商品',FALSE,NULL,'品类全路径',6),
 ('canonical_product','item_code','TEXT','商品',FALSE,'retail_detail(item_code)','跨品牌合并键',1),
 ('canonical_product','display_name','TEXT','商品',FALSE,NULL,'展示名',2),
 ('canonical_product','top_category','TEXT','商品',FALSE,NULL,'顶级品类',3),
 ('canonical_product','brand_count','INTEGER','品牌',FALSE,NULL,'覆盖品牌数',4),
 ('dim_branch','system_book_code','TEXT','品牌',FALSE,NULL,'品牌',1),
 ('dim_branch','branch_num','TEXT','门店',FALSE,'retail_detail(branch_num)','门店号（JOIN 键）',2),
 ('dim_branch','branch_name','TEXT','门店',FALSE,NULL,'门店名',3),
 ('dim_branch','region_name','TEXT','门店',FALSE,NULL,'区域名',4),
 ('dim_branch','province','TEXT','门店',FALSE,NULL,'省',5),
 ('dim_branch','city','TEXT','门店',FALSE,NULL,'市',6),
 ('dim_branch','is_active','BOOLEAN','门店',FALSE,NULL,'是否启用',7),
 ('dim_region','region_name','TEXT','门店',FALSE,NULL,'区域名',1),
 ('dim_region','war_zone','TEXT','门店',FALSE,NULL,'战区（统一管理）',2)
ON CONFLICT (dataset_name, name) DO NOTHING;

-- ===== 完成 =====
DO $$ BEGIN RAISE NOTICE 'Migration 031_data_registry completed successfully'; END $$;
