-- database/migrations/005_rls.sql
-- 启用行级安全（RLS）：按部门隔离报表、数据文件、数据源
-- 幂等：IF EXISTS 处理已存在的情况

-- ========== reports ==========
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- 策略 1：用户能看到自己部门有权限的报表
-- allowed_departments ?| array['1','2'] 表示数组中有任一部门 ID 即可
-- 或者 allowed_departments = '["*"]' 表示全员可见
DROP POLICY IF EXISTS reports_department_policy ON reports;
CREATE POLICY reports_department_policy ON reports
  FOR SELECT TO authenticated
  USING (
    allowed_departments = '["*"]'::jsonb
    OR allowed_departments ?| string_to_array(
      current_setting('request.jwt.claims.departments', true),
      ','
    )
  );

-- 策略 2：报表创建者始终可见
DROP POLICY IF EXISTS reports_creator_policy ON reports;
CREATE POLICY reports_creator_policy ON reports
  FOR ALL TO authenticated
  USING (created_by::text = current_setting('request.jwt.claims.sub', true));

-- ========== data_files ==========
ALTER TABLE data_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_files_department_policy ON data_files;
CREATE POLICY data_files_department_policy ON data_files
  FOR SELECT TO authenticated
  USING (
    -- 通过关联 reports 判断权限（假设 data_files 关联报表）
    EXISTS (
      SELECT 1 FROM reports
      WHERE reports.id = data_files.source_id
      AND (
        reports.allowed_departments = '["*"]'::jsonb
        OR reports.allowed_departments ?| string_to_array(
          current_setting('request.jwt.claims.departments', true),
          ','
        )
      )
    )
    -- 或者：如果没有关联报表，默认可见
    OR NOT EXISTS (
      SELECT 1 FROM reports WHERE reports.id = data_files.source_id
    )
  );

-- ========== data_sources ==========
ALTER TABLE data_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_sources_department_policy ON data_sources;
CREATE POLICY data_sources_department_policy ON data_sources
  FOR SELECT TO authenticated
  USING (
    -- 数据源默认全员可见（暂无部门隔离需求）
    true
  );

-- ========== org_users ==========
-- org_users 不启用 RLS（需要让所有登录用户能查到其他用户的姓名用于展示）
-- 但敏感字段（mobile/email）应该在应用层脱敏，或使用列级权限

-- ========== query_logs ==========
-- query_logs 仅用户自己可见
ALTER TABLE query_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS query_logs_user_policy ON query_logs;
CREATE POLICY query_logs_user_policy ON query_logs
  FOR SELECT TO authenticated
  USING (user_id::text = current_setting('request.jwt.claims.sub', true));