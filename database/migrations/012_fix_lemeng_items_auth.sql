-- 012_fix_lemeng_items_auth.sql
-- 修复 lemeng_items 表权限（允许无 auth 写入）
-- 幂等设计：GRANT 是幂等的

-- 确保 anon 有完整写入权限（PostgREST upsert 需要 INSERT + UPDATE）
GRANT INSERT, UPDATE, SELECT ON lemeng_items TO anon;
GRANT INSERT, UPDATE, SELECT ON lemeng_items TO authenticated;

-- 确认 RLS 未启用（开发阶段允许无 auth 访问）
ALTER TABLE lemeng_items DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE lemeng_items IS '乐檬商品档案（当前无 RLS，生产环境需评估开启）';
