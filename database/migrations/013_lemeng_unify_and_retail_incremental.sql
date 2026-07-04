-- 013_lemeng_unify_and_retail_incremental.sql
-- 1) 合并两个乐檬数据源为一个（符合「数据源→任务」架构，两任务共用唯一 token）
-- 2) 零售明细任务改为：当天数据、8:00-23:55 每 5 分钟增量、每小时全量核对
-- 幂等设计：UPDATE/DELETE 幂等；params 用 jsonb || 合并，保留运行时写入的 watermark。

-- ① 统一数据源：保留 a0000000-001（活 token 所在），改名「乐檬」
UPDATE data_sources SET name = '乐檬', updated_at = NOW()
WHERE id = 'a0000000-0000-0000-0000-000000000001';

-- ② 零售明细任务改挂到统一源（与商品档案任务同源 → 共用 token）
--    必须在 ④ 删除 d6939e91 之前完成（collect_tasks.source_id 对 data_sources 是 ON DELETE CASCADE）
UPDATE collect_tasks SET source_id = 'a0000000-0000-0000-0000-000000000001'
WHERE id = '999ad6d7-2edd-4b36-9e77-8b86d837dce5';

-- ③ 清理冗余源 d6939e91 的死 token（auth_credentials 随源级联删除，但显式删更稳）
DELETE FROM auth_credentials WHERE source_id = 'd6939e91-2288-4343-89d0-3243848aeb72';

-- ④ 删除冗余源（此时已无 collect_tasks 引用它；data_files 为空）
DELETE FROM data_sources WHERE id = 'd6939e91-2288-4343-89d0-3243848aeb72';

-- ⑤ 零售任务：cron 改当天 8-24 点每 5 分钟；params 用 jsonb 合并（保留 watermark）
--    date_mode=today → scheduler 运行时算当天日期；page_size=200
UPDATE collect_tasks
SET schedule_cron = '*/5 8-23 * * *',
    params = COALESCE(params, '{}'::jsonb) || '{"date_mode":"today","page_size":200}'::jsonb
WHERE id = '999ad6d7-2edd-4b36-9e77-8b86d837dce5';
