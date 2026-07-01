-- 003_auth.sql
-- 收口业务表读权限：撤销 anon 的 SELECT，强制登录（authenticated）才能读报表。
-- 配合 wecom-oauth 签发的 role=authenticated JWT：前端带 token → PostgREST 切 authenticated → 可读；
-- 不带 token（anon）→ 读不到。
-- anon 仍可 invoke edge function（function invoke 走管理 API，不依赖表 SELECT 权限）。
-- 幂等：REVOKE 对不存在的权限不报错，可重复执行。

REVOKE SELECT ON reports FROM anon;
REVOKE SELECT ON data_files FROM anon;
REVOKE SELECT ON data_sources FROM anon;
REVOKE SELECT ON org_users FROM anon;
REVOKE SELECT ON org_departments FROM anon;
REVOKE SELECT ON data_permissions FROM anon;

-- query_logs：由 wecom-push 以 authenticated 写审计（INSERT），anon 无需读，保持现状。
