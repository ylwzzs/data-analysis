-- 017_contact_realtime_sync.sql
-- 通讯录实时同步支持：org_users / org_departments 加 is_active 软删除列。
-- 语义：企微离职/删除 → is_active=false（保留行，保历史 + 不破坏 retail_query_user_perms 关联）。
-- 现有数据默认 true，不受影响。
-- 幂等：ADD COLUMN IF NOT EXISTS。

BEGIN;

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE org_departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN org_users.is_active IS '通讯录同步软删除标记：false=企微已离职/删除，保留行（架构 §7.1.2）';
COMMENT ON COLUMN org_departments.is_active IS '通讯录同步软删除标记：false=企微已删除，保留行（架构 §7.1.2）';

COMMIT;
