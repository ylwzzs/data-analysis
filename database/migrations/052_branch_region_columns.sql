-- 052_branch_region_columns.sql
-- dim_branch 加 first_level_region(战区)/second_level_region(二级) 从 raw 抽（采集自带，跨品牌重合）
-- branch_admin_v 重建：去 dim_region JOIN，战区/二级直接读 dim_branch
-- get_unmapped_regions 重定义：查 first_level_region 空的门店（无战区）
-- 幂等：ADD COLUMN IF NOT EXISTS；UPDATE 每次重设；DROP+CREATE VIEW；CREATE OR REPLACE FUNCTION

-- ===== 1. dim_branch 加列 =====
ALTER TABLE dim_branch ADD COLUMN IF NOT EXISTS first_level_region TEXT;
ALTER TABLE dim_branch ADD COLUMN IF NOT EXISTS second_level_region TEXT;

-- 回填历史（从 raw 抽；migrate 每次重跑都重设，幂等）
UPDATE dim_branch SET first_level_region = raw->'first_level_region'->>'name' WHERE raw ? 'first_level_region';
UPDATE dim_branch SET second_level_region = raw->'second_level_region'->>'name' WHERE raw ? 'second_level_region';

-- ===== 2. branch_admin_v 重建（去 dim_region，战区/二级直接读 dim_branch）=====
DROP VIEW IF EXISTS branch_admin_v;
CREATE VIEW branch_admin_v AS
SELECT
  b.system_book_code, b.branch_num, b.branch_id, b.branch_code, b.branch_name,
  b.region_name, b.province, b.city, b.district, b.address, b.phone,
  b.enable, b.is_active,
  b.first_level_region AS war_zone,          -- 一级战区(跨品牌重合：东部/中部/南部/西部战区)
  b.second_level_region AS region_l2,        -- 二级区域
  b.branch_groups,
  e.custom_group, e.note,
  CASE WHEN b.first_level_region IS NULL THEN true ELSE false END AS unmapped
FROM dim_branch b
LEFT JOIN dim_branch_ext e ON e.system_book_code = b.system_book_code AND e.branch_num = b.branch_num
WHERE b.is_active = true;
ALTER VIEW branch_admin_v OWNER TO postgres;
ALTER VIEW branch_admin_v SET (security_invoker = true);
GRANT SELECT ON branch_admin_v TO authenticated, anon;

-- ===== 3. get_unmapped_regions 重定义：无战区(first_level_region 空)的门店 =====
DROP FUNCTION IF EXISTS get_unmapped_regions();
CREATE FUNCTION get_unmapped_regions() RETURNS TABLE(system_book_code TEXT, branch_num TEXT, branch_name TEXT, region_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT b.system_book_code, b.branch_num, b.branch_name, b.region_name
    FROM dim_branch b
    WHERE b.is_active = true AND b.first_level_region IS NULL
    ORDER BY b.system_book_code, b.branch_num;
END $$;
GRANT EXECUTE ON FUNCTION get_unmapped_regions() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 052 completed: dim_branch +first/second_level_region, branch_admin_v 去 dim_region, get_unmapped_regions 改查无战区门店'; END $$;
