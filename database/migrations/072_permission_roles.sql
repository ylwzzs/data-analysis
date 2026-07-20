-- 072_permission_roles.sql
-- 权限架构 P1：角色表 + 多维数据权限表 + 部门→角色映射规则 + 5 角色种子
-- 设计文档：docs/superpowers/specs/2026-07-20-permission-role-architecture-design.md §4.1-4.5
-- 幂等：可由 scripts/migrate.sh 重复执行；ON_ERROR_STOP=1 下任一步出错即整体回滚。

BEGIN;

-- ============================================================
-- ① roles 表（角色定义 + UI 默认值）
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,           -- boss/zone_manager/manager/buyer/finance
  name            TEXT NOT NULL,                  -- 中文显示名
  default_landing TEXT,                           -- 默认落地路由，如 '/' 或 '/my-store'
  default_metric  TEXT,                           -- 默认聚焦指标 metric_code
  visible_panels  JSONB DEFAULT '[]'::jsonb,      -- 可见面板/导航项 ["targets","category_analysis","cost"]
  sort_order      INT DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active) WHERE is_active;
COMMENT ON TABLE roles IS '角色定义（5 个：boss/zone_manager/manager/buyer/finance）；UI 默认值在此，数据范围在 data_permissions(subject_type=role)';

-- ============================================================
-- ② data_permissions 表（重构：旧 schema 已废弃，按设计文档 §4.2 重建为多维数据范围 + 临时授权）
--   背景：001_init.sql 建过 data_permissions(resource_type/resource_id/permission_level) 通用 ABAC，
--   一直未启用（0 行）。设计文档 §4.2 重新定义为 subject_type/subject_id/branch_nums/brands/categories/can_see_cost/expires_at。
--   幂等策略：
--     - 旧 schema（有 resource_type 列、无 subject_type 列）→ DROP + CREATE 新 schema（无数据损失）
--     - 新 schema 已存在 → no-op
--     - 表不存在 → CREATE
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='data_permissions')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='data_permissions' AND column_name='subject_type') THEN
    -- 旧 schema（001_init.sql 的 resource_type/resource_id/permission_level）；
    -- 设计文档 §4.2 明确重构，旧表为空（未启用），直接 DROP 重建。
    EXECUTE 'DROP TABLE data_permissions';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS data_permissions (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,                    -- 'role' | 'user' | 'dept'
  subject_id    TEXT NOT NULL,                    -- role_id::text | wecom_id | dept_id
  branch_nums   JSONB DEFAULT '["*"]'::jsonb,     -- 门店范围（"*" 通配）
  brands        JSONB DEFAULT '["*"]'::jsonb,     -- 品牌 system_book_code 范围
  categories    JSONB DEFAULT '["*"]'::jsonb,     -- 品类 category_group 范围
  can_see_cost  BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ,                      -- 临时授权时效（NULL=永久）
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_permissions_subject ON data_permissions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_data_permissions_expires ON data_permissions(expires_at) WHERE expires_at IS NOT NULL;
-- 故意不加 UNIQUE(subject_type, subject_id)：允许「永久基础 + 多个临时扩展」并存，由 get_user_perms 聚合未过期条目
COMMENT ON TABLE data_permissions IS '多维数据范围（branch_nums/brands/categories）+ 临时授权(expires_at)；subject_type=role/user/dept；RLS 关闭，仅经 SECURITY DEFINER 的 get_user_perms RPC 可读';

-- ============================================================
-- ③ dept_role_mapping 表（部门→角色自动映射规则）
-- ============================================================
CREATE TABLE IF NOT EXISTS dept_role_mapping (
  dept_id   TEXT NOT NULL,                        -- org_departments.id（企微部门 id）
  role_id   INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  priority  INT DEFAULT 0,                        -- 多部门命中时取 priority 最高
  PRIMARY KEY (dept_id, role_id)
);
COMMENT ON TABLE dept_role_mapping IS '部门→角色自动映射；通讯录同步时按 user.department_ids 查此表自动赋 role_id（多部门取 priority 最高；无匹配→留空待 admin 配）';

-- ============================================================
-- ④ org_users 加 role_id / brands 列
-- ============================================================
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(id);
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '["*"]'::jsonb;
COMMENT ON COLUMN org_users.role_id IS '用户主角色（dept_role_mapping 自动赋值或 admin 手配）；NULL=未配置';
COMMENT ON COLUMN org_users.brands IS '用户级品牌 override（一般不用，默认 ["*"] 全品牌）';

-- ============================================================
-- ⑤ 5 角色种子（设计文档 §4.1）
-- ============================================================
INSERT INTO roles (code, name, default_landing, default_metric, visible_panels, sort_order) VALUES
  ('boss',         '老板/运营总',  '/',                 'sale',            '["targets","cost"]'::jsonb,              1),
  ('zone_manager', '战区主管',      '/',                 'sale',            '["targets","cost"]'::jsonb,              2),
  ('manager',      '店长',          '/my-store',         'sale',            '["targets"]'::jsonb,                     3),
  ('buyer',        '采购/业务',     '/reports/category', 'outbound_amt',    '["targets","category_analysis"]'::jsonb, 4),
  ('finance',      '财务',          '/',                 'outbound_profit', '["targets","cost"]'::jsonb,              5)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  default_landing=EXCLUDED.default_landing,
  default_metric=EXCLUDED.default_metric,
  visible_panels=EXCLUDED.visible_panels,
  sort_order=EXCLUDED.sort_order;

-- ============================================================
-- ⑥ 角色级 data_permissions 种子（subject_type='role', subject_id=role_id::text）
--   幂等策略：先 DELETE 角色级条目，再 INSERT——允许参数随设计迭代更新
--   默认范围：
--     boss/zone_manager/finance: 全店/全品牌/全品类 + 可见成本
--     manager(店长):              全店/全品牌/全品类 + 不可见成本（店级范围由 get_user_perms 部门补充层覆盖）
--     buyer(采购):                全店/全品牌 + 限品类（默认水果；多品类采购由 admin 加行覆盖）
-- ============================================================
DELETE FROM data_permissions WHERE subject_type='role';

INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
SELECT
  'role',
  r.id::text,
  '["*"]'::jsonb,
  '["*"]'::jsonb,
  CASE r.code WHEN 'buyer' THEN '["水果"]'::jsonb ELSE '["*"]'::jsonb END,
  CASE WHEN r.code IN ('boss','zone_manager','finance') THEN true ELSE false END,
  '角色级默认范围（' || r.code || '）'
FROM roles r
WHERE r.code IN ('boss','zone_manager','manager','buyer','finance');

-- ============================================================
-- ⑦ dept_role_mapping 规则种子：按 org_departments.name 推断
--   说明：本地 dev 通常 org_departments 为空（未跑通讯录同步），本节产出 0 行属正常；
--   生产环境有部门时按规则映射。无匹配 → 默认 manager（最小权限兜底，店长视角）。
--   匹配关键词（按设计文档 §4.5 + 业务语义；admin 后续可在 UI 精调）：
--     boss(优先级10): 总经办、运营总、老板
--     zone_manager:    战区、区域、大区
--     manager(默认1):  店长、门店、本店（及所有未匹配部门）
--     buyer:           采购、业务、品类
--     finance:         财务
-- ============================================================
INSERT INTO dept_role_mapping (dept_id, role_id, priority)
SELECT d.id, r.id,
  CASE WHEN d.name ~ '(总经办|运营总|老板)' THEN 10 ELSE 1 END
FROM org_departments d
CROSS JOIN LATERAL (
  SELECT id FROM roles WHERE code =
    CASE
      WHEN d.name ~ '(总经办|运营总|老板)'   THEN 'boss'
      WHEN d.name ~ '(战区|区域|大区)'       THEN 'zone_manager'
      WHEN d.name ~ '(店长|门店)'            THEN 'manager'
      WHEN d.name ~ '(采购|业务|品类)'       THEN 'buyer'
      WHEN d.name ~ '(财务)'                 THEN 'finance'
      ELSE 'manager'  -- 默认店长（最小权限兜底）
    END
) r
WHERE NOT EXISTS (SELECT 1 FROM dept_role_mapping m WHERE m.dept_id=d.id AND m.role_id=r.id);

-- ============================================================
-- ⑧ retail_query_user_perms 退役：REVOKE 写权限（保留只读）
--   数据将在后续任务迁入 data_permissions(subject_type='user')；
--   不立即 DROP（同 lemeng_items 教训：保留历史只读，避免误丢）。
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON retail_query_user_perms FROM anon, authenticated;

COMMIT;
