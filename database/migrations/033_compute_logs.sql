-- 033_compute_logs.sql
-- C1: /compute 执行日志（采集自动触发 / 手动 / cron）。失败 → status=failed → 接 collect_fail 告警（完整性规则第5点）。
CREATE TABLE IF NOT EXISTS compute_logs (
  id BIGSERIAL PRIMARY KEY,
  report_type TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL,              -- success | failed
  rows_written INTEGER,
  duration_ms INTEGER,
  error TEXT,
  triggered_by TEXT,                 -- 'collect:<task_id>' | 'manual' | 'cron:<job_id>'
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
GRANT SELECT ON compute_logs TO authenticated;
CREATE INDEX IF NOT EXISTS idx_compute_logs_started ON compute_logs(started_at DESC);
COMMENT ON TABLE compute_logs IS '报表计算日志（spec C1）';
DO $$ BEGIN RAISE NOTICE 'Migration 033_compute_logs applied'; END $$;
