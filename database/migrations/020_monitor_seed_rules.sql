-- 监控告警体系 v1 种子规则（service_down ×6 + token_expire 占位；token_expire 按数据源补 target）
BEGIN;

-- service_down：6 个服务，每服务一条规则（target=服务名）
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled)
VALUES
  ('web 存活', 'service_down', 'web', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] web 不可达({detail})', 300, true),
  ('duckdb 存活', 'service_down', 'duckdb', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] DuckDB 不可达({detail})，影响采集/查询', 300, true),
  ('insforge 存活', 'service_down', 'insforge', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] InsForge 不可达({detail})，告警通道可能受影响', 300, true),
  ('postgres 存活', 'service_down', 'postgres', '{}'::jsonb, 'critical', '@default', '🔴 [{severity}] PostgreSQL 不可达({detail})', 300, true),
  ('deno 存活', 'service_down', 'deno', '{}'::jsonb, 'high', '@default', '🔴 [{severity}] Deno(edge function) 不可达({detail})', 300, true),
  ('openclaw 存活', 'service_down', 'openclaw', '{}'::jsonb, 'high', '@default', '🔴 [{severity}] OpenClaw 不可达({detail})，影响问数 bot', 300, true)
ON CONFLICT DO NOTHING;

-- token_expire：临过期前 24h 预警。target=数据源 id（部署后按实际乐檬数据源 id 补/改）。
-- 这里先插一条 target=NULL 的模板（disabled），运维确认数据源 id 后 enabled=true 并填 target。
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled)
VALUES
  ('乐檬 token 临过期', 'token_expire', NULL, '{"before_hours":24}'::jsonb, 'critical', '@default', '🔴 [{severity}] 乐檬-{brand} token 将在 {remain_hours}h 后过期，请尽快更新', 3600, false)
ON CONFLICT DO NOTHING;

COMMIT;
