-- database/migrations/004_report_permissions.sql
-- 报表权限配置：allowed_departments 为部门 ID 数组
-- ["*"] 表示全员可见，["1", "2"] 表示仅部门 1、2 可见
-- 幂等：可重复执行

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS allowed_departments JSONB
  DEFAULT '["*"]'::jsonb;

COMMENT ON COLUMN reports.allowed_departments IS
  '部门 ID 数组，["*"] 表示全员可见';
