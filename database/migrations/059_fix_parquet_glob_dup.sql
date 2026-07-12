-- 059_fix_parquet_glob_dup.sql
-- 修复 /compute 通配 **/*.parquet 同时读「分区文件 + all.parquet」致 2x 重复
-- /transform /merge 都写 all.parquet(含全部去重记录) + 各 partition 文件(同内容按分片)
-- 通配 **/*.parquet 把两份都读 → 每条记录算两遍 → 所有汇总(daily_sales/category/weekly/delivery/wholesale) 2x 膨胀
-- 修：source_pattern **/*.parquet → **/all.parquet(只读合并文件)
-- 幂等：UPDATE 无副作用可重跑；REPLACE 已是 all.parquet 的不变
UPDATE report_definitions
SET source_pattern = REPLACE(source_pattern, '**/*.parquet', '**/all.parquet')
WHERE source_pattern LIKE '%**/*.parquet';

DO $$ BEGIN RAISE NOTICE 'Migration 059: report_definitions source_pattern **/*.parquet → **/all.parquet (修 2x 重复)'; END $$;
