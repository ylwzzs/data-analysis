-- 028_dim_item_soft_delete.sql
-- 商品主数据软删除：is_active 标记。采集时本次未见到的商品标 false（乐檬已淘汰的不再当活态商品）。
-- 幂等（migrate 每次重跑全部迁移）。

ALTER TABLE dim_item ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_dim_item_brand_active ON dim_item(system_book_code) WHERE is_active = TRUE;

-- canonical_product 增加 is_active_any（任一品牌 active 即视该商品为活态）
DROP VIEW IF EXISTS canonical_product;
CREATE VIEW canonical_product AS
SELECT item_code,
       (ARRAY_AGG(item_name ORDER BY item_name))[1] AS display_name,
       (ARRAY_AGG(category_name ORDER BY item_name))[1] AS category_name,
       (ARRAY_AGG(top_category ORDER BY item_name))[1] AS top_category,
       COUNT(DISTINCT system_book_code) AS brand_count,
       ARRAY_AGG(DISTINCT system_book_code) AS brands,
       BOOL_OR(is_active) AS is_active_any
FROM dim_item
WHERE item_code IS NOT NULL
GROUP BY item_code;
COMMENT ON VIEW canonical_product IS '跨品牌合并层（按 item_code）；is_active_any=任一品牌活态';
GRANT SELECT ON canonical_product TO anon, authenticated;
