-- 008_collect_permissions.sql
-- 采集系统表权限配置（幂等）

-- data_sources 表：anon 需要 SELECT 权限用于 collect-tasks 的关联查询
GRANT SELECT ON data_sources TO anon, authenticated;

-- auth_credentials 表：已有 INSERT/SELECT，确保 anon 也能 UPDATE（用于更新凭证）
GRANT SELECT, INSERT, UPDATE ON auth_credentials TO anon, authenticated;

-- collect_tasks 表：确保权限完整
GRANT SELECT, INSERT, UPDATE, DELETE ON collect_tasks TO anon, authenticated;

-- collect_logs 表：确保权限完整
GRANT SELECT, INSERT ON collect_logs TO anon, authenticated;
