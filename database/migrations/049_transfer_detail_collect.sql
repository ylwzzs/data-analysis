-- 049_transfer_detail_collect.sql
-- 配送调出明细采集任务（仅 3120，配送中心99；64188 共用）+ 监控 + datasets 注册
-- 幂等：ON CONFLICT。设计见 memory lemeng-delivery-detail-api.md

-- ===== 1. 采集任务（只 3120）=====
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled) VALUES
 ('a0000000-0000-0000-0000-000000000010'::uuid, '乐檬-3120-配送调出明细采集',
  'a0000000-0000-0000-0000-000000000001'::uuid,   -- source = 3120
  'collect-delivery',
  '*/5 8-23 * * *',                               -- 同 retail 3120（当天增量+每小时全量）
  '{"task_type":"delivery","date_mode":"today","page_size":200,"distribution_branch_num":99}'::jsonb,
  true)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, params=EXCLUDED.params, enabled=true;

-- ===== 2. 采集失败告警（连续 3 次 partial/failed）=====
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-配送明细', 'collect_fail', 'a0000000-0000-0000-0000-000000000010',
  '{"consecutive":3,"window":5}'::jsonb, 'high',
  '连续 {consecutive_count} 次失败（最近 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template, enabled=true;

-- ===== 3. datasets 注册（让 LLM 字典 + agent-query 路由感知 delivery_detail）=====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
 ('delivery_detail','配送调出明细(乐檬配送毛利)','duckdb_view',
  's3://lemeng-datasource/lemeng/transfer_detail/*/*/all.parquet','fact',TRUE,FALSE,
  'order_time','YYYYMMDD',FALSE,TRUE,
  '配送中心调出门店的明细（每条=一个调出单的商品行）；含调出量out_amount/调出额out_money/毛利profit_money/成本cost_price/调入门店response_branch_num；全字符串列，数学运算须 CAST')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  columns_typed=EXCLUDED.columns_typed, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, description=EXCLUDED.description;

-- ===== 4. delivery_detail 列注册（成本/毛利组 is_sensitive=TRUE，按 can_see_cost 整组脱敏）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('delivery_detail','id','VARCHAR','单据',FALSE,NULL,'明细行唯一id（去重键）',1),
 ('delivery_detail','pos_order_num','VARCHAR','单据',FALSE,NULL,'调出单号',2),
 ('delivery_detail','pos_order_type','VARCHAR','单据',FALSE,NULL,'单据类型(调出单)',3),
 ('delivery_detail','order_time','VARCHAR','日期',FALSE,NULL,'调出业务日 YYYY-MM-DD HH:MM:SS（按日过滤用 order_time）',4),
 ('delivery_detail','sale_time','VARCHAR','日期',FALSE,NULL,'调出时间',5),
 ('delivery_detail','state','VARCHAR','单据',FALSE,NULL,'状态(未配货等)',6),
 ('delivery_detail','distribution_branch_num','VARCHAR','调出方',FALSE,NULL,'调出方(配送中心)号=99',7),
 ('delivery_detail','distribution_branch_name','VARCHAR','调出方',FALSE,NULL,'调出方名(管理中心)',8),
 ('delivery_detail','response_branch_num','VARCHAR','门店',FALSE,'dim_branch(system_book_code,branch_num)','调入门店号（JOIN 键，按店算拿货量/毛利）',9),
 ('delivery_detail','response_branch_name','VARCHAR','门店',FALSE,NULL,'调入门店名',10),
 ('delivery_detail','response_branch_region_name','VARCHAR','门店',FALSE,NULL,'调入门店战区',11),
 ('delivery_detail','storehouse_num','VARCHAR','仓库',FALSE,NULL,'仓库号',12),
 ('delivery_detail','storehouse_name','VARCHAR','仓库',FALSE,NULL,'仓名',13),
 ('delivery_detail','item_num','VARCHAR','商品',FALSE,'dim_item(system_book_code,item_num)','商品号（JOIN 键）',14),
 ('delivery_detail','pos_item_code','VARCHAR','商品',FALSE,'canonical_product(item_code)','商品业务码(跨品牌合并键)',15),
 ('delivery_detail','pos_item_name','VARCHAR','商品',FALSE,NULL,'商品名',16),
 ('delivery_detail','item_category','VARCHAR','商品',FALSE,NULL,'品类',17),
 ('delivery_detail','top_category_name','VARCHAR','商品',FALSE,NULL,'顶级品类(标品等)',18),
 ('delivery_detail','department','VARCHAR','商品',FALSE,NULL,'部门',19),
 ('delivery_detail','item_method','VARCHAR','商品',FALSE,NULL,'经营方式(购销等)',20),
 ('delivery_detail','spec','VARCHAR','商品',FALSE,NULL,'规格',21),
 ('delivery_detail','out_unit','VARCHAR','商品',FALSE,NULL,'调出单位',22),
 ('delivery_detail','lot_number','VARCHAR','批次',FALSE,NULL,'批次号',23),
 ('delivery_detail','out_amount','VARCHAR','数量',FALSE,NULL,'调出数量(拿货量，可负=退货)',24),
 ('delivery_detail','out_money','VARCHAR','金额',FALSE,NULL,'调出金额',25),
 ('delivery_detail','out_unit_price','VARCHAR','金额',FALSE,NULL,'调出单价',26),
 ('delivery_detail','cost_price','VARCHAR','成本',TRUE,NULL,'成本（无权限=NULL）',27),
 ('delivery_detail','cost_unit_price','VARCHAR','成本',TRUE,NULL,'成本单价（无权限=NULL）',28),
 ('delivery_detail','profit_money','VARCHAR','成本',TRUE,NULL,'毛利（无权限=NULL）',29),
 ('delivery_detail','no_tax_out_money','VARCHAR','金额',FALSE,NULL,'不含税调出额',30),
 ('delivery_detail','tax_money','VARCHAR','金额',FALSE,NULL,'税额',31),
 ('delivery_detail','base_amount','VARCHAR','数量',FALSE,NULL,'基本单位数量',32),
 ('delivery_detail','base_price','VARCHAR','金额',FALSE,NULL,'基本单价',33),
 ('delivery_detail','order_maker','VARCHAR','单据',FALSE,NULL,'制单人',34),
 ('delivery_detail','order_seller','VARCHAR','单据',FALSE,NULL,'销售员',35),
 ('delivery_detail','order_auditor','VARCHAR','单据',FALSE,NULL,'审核人',36)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type,
  semantic_group=EXCLUDED.semantic_group, is_sensitive=EXCLUDED.is_sensitive,
  join_to=EXCLUDED.join_to, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

DO $$ BEGIN RAISE NOTICE 'Migration 049_transfer_detail_collect completed'; END $$;
