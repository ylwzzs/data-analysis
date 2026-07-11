-- 034_dim_carry_datasets.sql
-- C3: dim_* 改 duckdb_view（source=carry 出的 parquet），carry_enabled=true。
-- 明细 JOIN dim_* 走 DuckDB（parquet）；dim_* 单独查也走 DuckDB parquet（维表慢变，carry 对齐）。
UPDATE datasets SET engine='duckdb_view', carry_enabled=true, kind='dim', description='维表(carry物化)；JOIN 进明细 OK，直接查也走 parquet'
WHERE name IN ('dim_branch','dim_item','dim_region');
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_branch.parquet' WHERE name='dim_branch';
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_item.parquet'   WHERE name='dim_item';
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_region.parquet' WHERE name='dim_region';

-- dataset_columns: dim_item.item_cost_price 标 is_sensitive（view builder 据此对维表列 per-user 脱敏，与 retail_detail 成本列同机制）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
  ('dim_item','item_cost_price','TEXT','金额',TRUE,NULL,'成本价（can_see_cost=false→NULL，view builder 脱敏）',14)
ON CONFLICT (dataset_name, name) DO UPDATE SET is_sensitive=EXCLUDED.is_sensitive, description=EXCLUDED.description;

DO $$ BEGIN RAISE NOTICE 'Migration 034_dim_carry_datasets applied'; END $$;
