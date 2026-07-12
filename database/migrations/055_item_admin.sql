-- 055_item_admin.sql
-- 商品档案维护后台：item_admin_v 视图(dim_item JOIN ext) + 2 个 SECURITY DEFINER RPC + GRANT
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（不用 CREATE OR REPLACE，CLAUDE.md 坑）；GRANT 幂等
-- 零改表：dim_item_ext(custom_group/note) 已由 024_master_data.sql 建好，本迁移不动表结构

-- ===== 1. item_admin_v：dim_item LEFT JOIN dim_item_ext =====
DROP VIEW IF EXISTS item_admin_v;
CREATE VIEW item_admin_v AS
SELECT
  i.system_book_code, i.item_num, i.item_code, i.bar_code,
  i.item_name, i.category_name, i.category_path, i.top_category,
  i.item_brand, i.item_tags, i.is_active,
  e.custom_group, e.note                                          -- 来自 dim_item_ext（人工维护）
FROM dim_item i
LEFT JOIN dim_item_ext e ON e.system_book_code = i.system_book_code AND e.item_num = i.item_num
WHERE i.is_active = true;
ALTER VIEW item_admin_v OWNER TO postgres;
ALTER VIEW item_admin_v SET (security_invoker = true);
GRANT SELECT ON item_admin_v TO authenticated, anon;

-- ===== 2. upsert_item_ext：单行 ext(custom_group/note)，SECURITY DEFINER 绕 RLS =====
CREATE OR REPLACE FUNCTION upsert_item_ext(
  p_sbc TEXT, p_item TEXT, p_group TEXT, p_note TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
  VALUES (p_sbc, p_item, p_group, p_note, p_by, NOW())
  ON CONFLICT (system_book_code, item_num) DO UPDATE
    SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 3. upsert_items_ext_batch：批量 upsert ext（勾选多行设分组/备注）=====
-- p_rows 元素 = {system_book_code, item_num, custom_group, note, updated_by}（全值，前端拼）
CREATE OR REPLACE FUNCTION upsert_items_ext_batch(p_rows JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
    VALUES (r->>'system_book_code', r->>'item_num', r->>'custom_group', r->>'note', r->>'updated_by', NOW())
    ON CONFLICT (system_book_code, item_num) DO UPDATE
      SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'count', n);
END $$;

GRANT EXECUTE ON FUNCTION upsert_item_ext(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_items_ext_batch(JSONB) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 055_item_admin completed'; END $$;
