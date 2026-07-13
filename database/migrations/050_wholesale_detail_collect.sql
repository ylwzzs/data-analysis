-- 050_wholesale_detail_collect.sql
-- 批发销售明细采集任务（仅 3120）+ 监控 + datasets 注册。照 049（配送）模式。
-- 幂等：ON CONFLICT。接口实测：nhsoft.amazon.wholesale.item.detail（dateFrom/dateTo + dateType:"审核时间" + isPaging + branchNums:[]）

-- ===== 1. 采集任务（只 3120）=====
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled) VALUES
 ('a0000000-0000-0000-0000-000000000011'::uuid, '乐檬-3120-批发销售明细采集',
  'a0000000-0000-0000-0000-000000000001'::uuid,   -- source = 3120
  'collect-wholesale',
  '2-59/5 8-23 * * *',                            -- 错开零售0/配送1分,避并发/transform串扰(server.js共享conn+temp_raw)
  '{"task_type":"wholesale","date_mode":"today","page_size":200}'::jsonb,
  true)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, params=EXCLUDED.params, enabled=true;

-- ===== 2. 采集失败告警（连续 3 次 partial/failed）=====
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-批发明细', 'collect_fail', 'a0000000-0000-0000-0000-000000000011',
  '{"consecutive":3,"window":5}'::jsonb, 'high',
  '连续 {consecutive_count} 次失败（最近 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template, enabled=true;

-- ===== 3. datasets 注册 =====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
 ('wholesale_detail','批发销售明细(乐檬批发销售查询)','duckdb_view',
  's3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet','fact',TRUE,FALSE,
  'audit_time','YYYYMMDD',FALSE,TRUE,
  '批发销售明细（每条=一个批发销售单的商品行）；含批发量wholesale_num/批发额wholesale_money/毛利wholesale_profit/成本wholesale_cost/客户client_name/销售门店branch_num；全字符串列，数学运算须 CAST')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  columns_typed=EXCLUDED.columns_typed, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, description=EXCLUDED.description;

-- ===== 4. wholesale_detail 列注册（成本/毛利组 is_sensitive=TRUE）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('wholesale_detail','id','VARCHAR','单据',FALSE,NULL,'明细行唯一id（去重键）',1),
 ('wholesale_detail','pos_order_num','VARCHAR','单据',FALSE,NULL,'批发单号',2),
 ('wholesale_detail','pos_order_type','VARCHAR','单据',FALSE,NULL,'单据类型(批发销售)',3),
 ('wholesale_detail','audit_time','VARCHAR','日期',FALSE,NULL,'审核时间 YYYY-MM-DD HH:MM:SS（按日过滤用 audit_time）',4),
 ('wholesale_detail','sale_time','VARCHAR','日期',FALSE,NULL,'销售时间',5),
 ('wholesale_detail','order_type','VARCHAR','单据',FALSE,NULL,'订单类型',6),
 ('wholesale_detail','settlement_status','VARCHAR','单据',FALSE,NULL,'结算状态(未结算等)',7),
 ('wholesale_detail','branch_num','VARCHAR','门店',FALSE,'dim_branch(system_book_code,branch_num)','销售门店号（JOIN 键）',8),
 ('wholesale_detail','client_code','VARCHAR','客户',FALSE,NULL,'批发客户号',9),
 ('wholesale_detail','client_name','VARCHAR','客户',FALSE,NULL,'批发客户名',10),
 ('wholesale_detail','storehouse_num','VARCHAR','仓库',FALSE,NULL,'仓库号',11),
 ('wholesale_detail','storehouse_name','VARCHAR','仓库',FALSE,NULL,'仓名',12),
 ('wholesale_detail','item_num','VARCHAR','商品',FALSE,'dim_item(system_book_code,item_num)','商品号（JOIN 键）',13),
 ('wholesale_detail','pos_item_code','VARCHAR','商品',FALSE,'canonical_product(item_code)','商品业务码(跨品牌合并键)',14),
 ('wholesale_detail','pos_item_name','VARCHAR','商品',FALSE,NULL,'商品名',15),
 ('wholesale_detail','pos_item_category','VARCHAR','商品',FALSE,NULL,'品类号',16),
 ('wholesale_detail','pos_item_category_name','VARCHAR','商品',FALSE,NULL,'品类名',17),
 ('wholesale_detail','pos_item_bar_code','VARCHAR','商品',FALSE,NULL,'条码',18),
 ('wholesale_detail','department','VARCHAR','商品',FALSE,NULL,'部门',19),
 ('wholesale_detail','spec','VARCHAR','商品',FALSE,NULL,'规格',20),
 ('wholesale_detail','unit','VARCHAR','商品',FALSE,NULL,'单位',21),
 ('wholesale_detail','lot_number','VARCHAR','批次',FALSE,NULL,'批次号',22),
 ('wholesale_detail','wholesale_num','VARCHAR','数量',FALSE,NULL,'批发数量',23),
 ('wholesale_detail','wholesale_money','VARCHAR','金额',FALSE,NULL,'批发金额',24),
 ('wholesale_detail','wholesale_unit_price','VARCHAR','金额',FALSE,NULL,'批发单价',25),
 ('wholesale_detail','wholesale_cost','VARCHAR','成本',TRUE,NULL,'批发成本（无权限=NULL）',26),
 ('wholesale_detail','wholesale_profit','VARCHAR','成本',TRUE,NULL,'批发毛利（无权限=NULL）',27),
 ('wholesale_detail','no_tax_money','VARCHAR','金额',FALSE,NULL,'不含税额',28),
 ('wholesale_detail','no_tax_unit_price','VARCHAR','金额',FALSE,NULL,'不含税单价',29),
 ('wholesale_detail','tax_money','VARCHAR','金额',FALSE,NULL,'税额',30),
 ('wholesale_detail','tax_rate','VARCHAR','金额',FALSE,NULL,'税率',31),
 ('wholesale_detail','wholesale_return_num','VARCHAR','数量',FALSE,NULL,'批发退货数',32),
 ('wholesale_detail','wholesale_replenishment_money','VARCHAR','金额',FALSE,NULL,'补货金额',33),
 ('wholesale_detail','order_maker','VARCHAR','单据',FALSE,NULL,'制单人',34),
 ('wholesale_detail','order_seller','VARCHAR','单据',FALSE,NULL,'销售员',35),
 ('wholesale_detail','order_auditor','VARCHAR','单据',FALSE,NULL,'审核人',36)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type,
  semantic_group=EXCLUDED.semantic_group, is_sensitive=EXCLUDED.is_sensitive,
  join_to=EXCLUDED.join_to, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

DO $$ BEGIN RAISE NOTICE 'Migration 050_wholesale_detail_collect completed'; END $$;
