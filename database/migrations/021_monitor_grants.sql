-- 修复监控表写权限（hotfix）：web SDK 用 INSFORGE_API_KEY，实为 anon-role JWT（payload role=anon）。
-- 迁移 019 仅 GRANT SELECT → 告警 upsertAlert/markNotified/resolveAlert 全失败（permission denied）。
-- 对照 collect_logs（迁移 008 授 anon INSERT/UPDATE）补齐。
BEGIN;
GRANT INSERT, UPDATE, SELECT ON monitor_alerts TO anon, authenticated;
GRANT INSERT, UPDATE, SELECT ON monitor_state TO anon, authenticated;
GRANT INSERT, SELECT ON external_request_logs TO anon, authenticated;
COMMIT;
