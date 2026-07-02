-- database/migrations/006_contacts_permissions.sql
-- 授权 authenticated 和 anon role 写入 org_departments 和 org_users 表
-- 用于 wecom-sync-contacts function 的通讯录同步
-- 幂等：GRANT 本身可重复执行

-- org_departments: authenticated 和 anon 可 INSERT/UPDATE/SELECT
GRANT SELECT, INSERT, UPDATE ON org_departments TO authenticated;
GRANT SELECT, INSERT, UPDATE ON org_departments TO anon;

-- org_users: authenticated 和 anon 可 INSERT/UPDATE/SELECT
GRANT SELECT, INSERT, UPDATE ON org_users TO authenticated;
GRANT SELECT, INSERT, UPDATE ON org_users TO anon;