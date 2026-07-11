-- 043_canonical_product_carry.sql
-- C3 补：canonical_product（跨品牌商品合并视图）未 carry（031 注册 kind=view，被 carry-dims 的 kind='dim' 滤掉）。
-- 它本质是商品维表（跨品牌按 item_code 合并），改 kind=dim 让 carry-dims 自动 carry。
UPDATE datasets SET kind='dim', carry_enabled=true,
  source='s3://lemeng-datasource/dims/canonical_product.parquet',
  description='跨品牌商品合并视图(carry物化)；按 item_code 合并，JOIN 进明细用'
WHERE name='canonical_product';
DO $$ BEGIN RAISE NOTICE 'Migration 043_canonical_product_carry applied'; END $$;
