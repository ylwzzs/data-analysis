-- 083_register_customer_dimension.sql
-- 注册 customer 维度（单层 derived），仿 077 branch/item
-- derived 维度：validate_semantic_registry 跳过 join_key 物化校验（物化由 082 + /derive 保证）
-- 幂等：ON CONFLICT；部署后重启 postgrest

INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter) VALUES
 ('customer','客户','批发客户维度（从 wholesale_detail 派生）','derived','dim_customer','client_code','wholesale_detail',
  '从批发明细 DISTINCT client_code 派生（乐檬无客户档案 API）', false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, source_type=EXCLUDED.source_type,
  join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key,
  source_fact_table=EXCLUDED.source_fact_table, business_rule=EXCLUDED.business_rule,
  is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level, rollup_strategy) VALUES
 ('customer','customer','客户',0,'client_code','client_name', NULL, 'sum')
ON CONFLICT (dim_code, level_code) DO UPDATE SET
  level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column,
  name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level, rollup_strategy=EXCLUDED.rollup_strategy;

DO $$ BEGIN RAISE NOTICE 'Migration 083: registered customer dimension (single level, derived)'; END $$;
