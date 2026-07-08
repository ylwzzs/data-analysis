-- 监控告警体系 v1 表（架构文档 §8.1，spec docs/superpowers/specs/2026-07-08-monitoring-system-design.md）

-- 规则定义
CREATE TABLE IF NOT EXISTS monitor_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  check_type VARCHAR(50) NOT NULL,
  target TEXT,
  threshold JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity VARCHAR(20) NOT NULL DEFAULT 'high',
  touser TEXT,
  template TEXT,
  suppress_window_seconds INTEGER NOT NULL DEFAULT 1800,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_monitor_rules_check_type ON monitor_rules(check_type) WHERE enabled = TRUE;

-- 告警状态/事件（alert_key 唯一 → 同问题一行）
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id SERIAL PRIMARY KEY,
  alert_key TEXT NOT NULL UNIQUE,
  rule_id INTEGER NOT NULL REFERENCES monitor_rules(id) ON DELETE CASCADE,
  check_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  last_notify_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  context JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_status ON monitor_alerts(status);

-- 请求级埋点（request_fail 数据源，Phase B 用；先建好供 callLemengApi 写）
CREATE TABLE IF NOT EXISTS external_request_logs (
  id BIGSERIAL PRIMARY KEY,
  source_id INTEGER,
  endpoint TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status INTEGER,
  ok BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_req_ts ON external_request_logs(ts);

-- evaluator 跨轮运行态
CREATE TABLE IF NOT EXISTS monitor_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE monitor_rules IS '监控告警规则定义';
COMMENT ON TABLE monitor_alerts IS '告警状态/事件（alert_key 唯一，active/resolved）';
COMMENT ON TABLE external_request_logs IS '外部 API 请求级埋点（request_fail 数据源）';
COMMENT ON TABLE monitor_state IS 'evaluator 跨轮运行态键值';
COMMENT ON COLUMN monitor_alerts.alert_key IS '问题唯一标识，如 token:src_3120 / svc:duckdb';

ALTER TABLE monitor_rules DISABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_alerts DISABLE ROW LEVEL SECURITY;
ALTER TABLE external_request_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE monitor_state DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON monitor_rules, monitor_alerts TO anon, authenticated;
GRANT SELECT ON external_request_logs TO authenticated;
-- 写仅给服务端 service-role（INSFORGE_API_KEY），不对 anon 开
