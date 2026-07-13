-- 014_multi_brand_64188.sql
-- 乐檬多品牌采集：3120 源改名 + 新增 64188 数据源与其零售明细采集任务。
--
-- 背景（详见 docs/architecture-data-collect.md「数据源粒度=(系统,品牌)」）：
--   乐檬一个账号可管多个品牌(company)，但 token 按 company 隔离（JWT payload 的 company_id）。
--   多品牌 token 可同时有效（实测切换品牌不互顶）。故每品牌一个 data_source，各持自己的 token。
--   brand_nums 传空数组 [] = 该品牌(company)全部门店（已实测 3120=13118、64188=8134/天）。
--
-- ⚠ token 不写在本迁移里（不进 git），部署后单独写入 64188 源的 auth_credentials。

BEGIN;

-- ① 3120 源改名（明确品牌归属；id 不变，原有凭证/任务不受影响）
UPDATE data_sources
SET name = '乐檬-3120', updated_at = NOW()
WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- ② 新增 64188 数据源（幂等）
INSERT INTO data_sources (id, name, auth_type, auth_config, enabled, created_at, updated_at)
SELECT 'c0000000-0000-0000-0000-000000000001',
       '乐檬-64188',
       'bearer',
       '{}'::jsonb,
       true,
       NOW(),
       NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM data_sources WHERE id = 'c0000000-0000-0000-0000-000000000001'
);

-- ③ 新增 64188 零售明细采集任务（幂等）
--    cron 错峰：3120 用 */5 8-23（每整 5 分），64188 用 2-59/5 8-23（偏移 2 分钟：2,7,12,...），
--    避免两品牌同秒并发打乐檬 API。已 node-cron.validate 通过。
--    branch_nums 传 [] = 64188 全部门店。
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled, storage_type, storage_path)
SELECT 'c0000000-0000-0000-0000-000000000002',
       '乐檬-64188-销售订单明细采集',
       'c0000000-0000-0000-0000-000000000001',
       'collect-lemeng',
       '3-59/5 8-23 * * *',                        -- 错开3120零售0/配送1/批发2分,避并发/transform串扰
       '{"date_mode":"today","page_size":200,"branch_nums":[]}'::jsonb,
       true,
       'oos',
       'data/lemeng/retail_detail_64188.json'
WHERE NOT EXISTS (
  SELECT 1 FROM collect_tasks WHERE id = 'c0000000-0000-0000-0000-000000000002'
);

COMMIT;
