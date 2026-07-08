-- 启用乐檬两品牌的 token 临过期监控（target = data_sources.id，UUID）
BEGIN;
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, touser, template, suppress_window_seconds, enabled)
VALUES
  ('乐檬-3120 token 临过期', 'token_expire', 'a0000000-0000-0000-0000-000000000001', '{"before_hours":24}'::jsonb, 'critical', '@default', '🔴 [{severity}] 乐檬-3120 token 将在 {remain_hours}h 后过期，请尽快更新', 3600, true),
  ('乐檬-64188 token 临过期', 'token_expire', 'c0000000-0000-0000-0000-000000000001', '{"before_hours":24}'::jsonb, 'critical', '@default', '🔴 [{severity}] 乐檬-64188 token 将在 {remain_hours}h 后过期，请尽快更新', 3600, true)
ON CONFLICT DO NOTHING;
COMMIT;
