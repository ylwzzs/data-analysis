-- 071_freshness_max.sql
-- 修正 get_data_freshness: 用各表最新一次 /compute 时间(MAX updated_at) 的最早(LEAST)
-- 即"当前数据涉及的3个compute(sales/delivery/wholesale)中最早跑完的那个", 代表最旧表的新鲜度
-- (旧版用 MIN(updated_at) 取最旧行, 错; 应取各表最新compute的最早)
-- 幂等: CREATE OR REPLACE FUNCTION

CREATE OR REPLACE FUNCTION get_data_freshness() RETURNS TIMESTAMPTZ
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT LEAST(
    (SELECT MAX(updated_at) FROM report_daily_sales),
    (SELECT MAX(updated_at) FROM report_daily_delivery),
    (SELECT MAX(updated_at) FROM report_daily_wholesale))
$$;
GRANT EXECUTE ON FUNCTION get_data_freshness() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 071_freshness_max completed'; END $$;
