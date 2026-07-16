-- 069_collect_window_reconcile.sql
-- 采集窗口扩到 8:00-24:00（加 0 点，覆盖 23-24 点数据），保持 4 任务错开防并发
-- 配合 scheduler 对账驱动（迁移外，代码层）：full 只在对账失败时触发，减请求量反爬
-- 幂等: UPDATE

UPDATE collect_tasks SET schedule_cron = '*/5 0,8-23 * * *' WHERE name = '乐檬-3120-销售订单明细采集';
UPDATE collect_tasks SET schedule_cron = '3-59/5 0,8-23 * * *' WHERE name = '乐檬-64188-销售订单明细采集';
UPDATE collect_tasks SET schedule_cron = '1-59/5 0,8-23 * * *' WHERE name = '乐檬-3120-配送调出明细采集';
UPDATE collect_tasks SET schedule_cron = '2-59/5 0,8-23 * * *' WHERE name = '乐檬-3120-批发销售明细采集';

DO $$ BEGIN RAISE NOTICE 'Migration 069_collect_window_reconcile completed'; END $$;
