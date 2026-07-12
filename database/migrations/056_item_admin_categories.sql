-- 056_item_admin_categories.sql
-- item_admin_v 加 category_l1/l2/l3/l4（从 category_path 按 '->' split + btrim）
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（CLAUDE.md 坑：不用 CREATE OR REPLACE）
-- 零改表：dim_item.category_path 源不变，视图派生拆列。深度分布：1级35%/2级20%/3级44%/4+级1%
-- top_category(SX|生鲜 编码|名称) 保留作溯源；category_l1(生鲜 纯名称) 用于展示/筛选
DROP VIEW IF EXISTS item_admin_v;
CREATE VIEW item_admin_v AS
SELECT
  i.system_book_code, i.item_num, i.item_code, i.bar_code,
  i.item_name, i.category_name, i.category_path, i.top_category,
  btrim(split_part(i.category_path, '->', 1)) AS category_l1,
  btrim(split_part(i.category_path, '->', 2)) AS category_l2,
  btrim(split_part(i.category_path, '->', 3)) AS category_l3,
  btrim(split_part(i.category_path, '->', 4)) AS category_l4,
  i.item_brand, i.item_tags, i.is_active,
  e.custom_group, e.note
FROM dim_item i
LEFT JOIN dim_item_ext e ON e.system_book_code = i.system_book_code AND e.item_num = i.item_num
WHERE i.is_active = true;
ALTER VIEW item_admin_v OWNER TO postgres;
ALTER VIEW item_admin_v SET (security_invoker = true);
GRANT SELECT ON item_admin_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 056_item_admin_categories completed'; END $$;
