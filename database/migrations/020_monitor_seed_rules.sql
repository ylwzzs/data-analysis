-- 监控告警体系 v1 种子规则（service_down ×6；token_expire 真实规则在 022）。
-- 幂等依赖 023 的唯一索引（同 check_type+target 不重复）；空 target 的 token_expire 模板已移除（020 早期版本的 NULL 模板会每次部署重复插入，由 023 清理）。
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

COMMIT;
