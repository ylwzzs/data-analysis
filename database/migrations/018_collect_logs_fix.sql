-- 修复 collect_logs 写读不匹配：代码已写 duration_ms / response_summary，但表无此二列
BEGIN;
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS response_summary JSONB;
COMMENT ON COLUMN collect_logs.duration_ms IS '单次采集耗时(毫秒)';
COMMENT ON COLUMN collect_logs.response_summary IS '采集结果结构化摘要(jsonb)';
COMMIT;
