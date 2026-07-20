# 权限架构 P1（角色化视图 + 多维数据权限）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给数据分析平台加角色化权限——5 个业务角色、四维数据权限（门店/品牌/品类/成本）、临时授权时效、与企微通讯录同步联动、UI 默认值差异，让不同角色看到不同数据范围和默认视图。

**Architecture:** 角色表驱动（`roles`/`data_permissions`/`dept_role_mapping`）→ `get_user_perms` RPC 四维合并 → JWT claim 扩展 → RLS/视图四维过滤 + 前端读 claim 自适应。企微是身份+组织唯一真相源，角色随通讯录同步自动赋值。

**Tech Stack:** PostgreSQL 15（迁移+RLS+RPC）/ InsForge Edge Functions（Deno CommonJS）/ Next.js 16 + shadcn/ui / Vitest + Playwright

**上游 spec:** `docs/superpowers/specs/2026-07-20-permission-role-architecture-design.md`

---

## Global Constraints

- **迁移幂等**：`CREATE TABLE IF NOT EXISTS` / `DROP VIEW IF EXISTS + CREATE VIEW`（**禁** `CREATE OR REPLACE VIEW`）/ `ADD COLUMN IF NOT EXISTS` / `ON CONFLICT`。每次部署重跑全部迁移。
- **类型**：外部系统数据用 `TEXT`（不用 VARCHAR 防长度坑）；枚举用 `VARCHAR(50)`。
- **迁移后必做**：`docker compose restart postgrest`（刷 schema 缓存，GHA 不保证）。
- **部署方式**（CLAUDE.md）：
  - 只改 `functions/*/index.js` → SSH 服务器 PUT + 清 Deno 缓存（不走 GHA）
  - 改 `database/` / `web/` → `git push` 走 GHA 完整部署
  - function + web 都改 → 先 SSH PUT function，再 push GHA
- **测试**：按 `docs/testing-handbook.md`。本地用伪造 cookie（`scripts/dev-token.sh` 或 dev-login）参数化测各角色 claim。
- **代码风格**：中文注释/UI 文案；DESIGN.md 遵守（无 emoji、lucide icon stroke-width 1.5、`tabular-nums`、`bg-primary` token）。
- **common 陷阱**：RPC 用 `SECURITY DEFINER` + `SET search_path = public`；GRANT 给 anon+authenticated（web SDK 用 anon_key service 调）；`retail_query_user_perms`/`lemeng_items` 教训——退役表 REVOKE 写保留只读，不立即 DROP。

---

## 文件结构

**新建迁移**（1 个文件，幂等覆盖 P1 全部 DB 变更）：
- `database/migrations/072_permission_roles.sql` — roles/data_permissions/dept_role_mapping 表 + org_users 加列 + 种子 + get_user_perms 升级 + 辅助函数 + report_*_v 四维过滤

**改造 functions**（Deno CommonJS，单文件）：
- `functions/wecom-oauth/index.js` — 登录调 get_user_perms，claim 扩展
- `functions/agent-query/index.js` — 短时 JWT 加 brands/categories
- `functions/wecom-sync-contacts/index.js` — 全量同步赋 role_id
- `web/app/api/wecom-contacts-webhook/route.ts` — 实时同步赋 role_id

**改造 web**：
- `web/lib/auth.ts` — claim 解析 helper（role_code/landing/panels）
- `web/app/auth/callback/route.ts` — 读 claim landing 跳转
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` — 默认 metric 读 claim
- `web/components/layout/sidebar.tsx` — 按 visible_panels 显隐（P2 预留，P1 仅 helper）
- `web/app/admin/roles/page.tsx` + `web/app/api/admin/roles/route.ts`（新）
- `web/app/admin/users/page.tsx` + `web/app/api/admin/users/route.ts`（新）
- `web/app/api/auth/dev-login/route.ts`（新，dev-only 测试辅助，顺带落地测试手册 §3.2）
- `scripts/dev-token.sh`（新，伪造 claim 签 JWT，测试手册 §3.2）

---

## Task 1: DB 迁移——角色/权限表 + 种子

**Files:**
- Create: `database/migrations/072_permission_roles.sql`

**Interfaces:**
- Produces: 表 `roles`、`data_permissions`、`dept_role_mapping`；`org_users` 加列 `role_id`/`brands`；5 角色种子 + dept_role_mapping 规则种子

- [ ] **Step 1: 写迁移——建表**

```sql
-- 072_permission_roles.sql（幂等）
CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  default_landing TEXT,
  default_metric  TEXT,
  visible_panels  JSONB DEFAULT '[]',
  sort_order      INT DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS data_permissions (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,               -- 'role' | 'user' | 'dept'
  subject_id    TEXT NOT NULL,
  branch_nums   JSONB DEFAULT '["*"]',
  brands        JSONB DEFAULT '["*"]',
  categories    JSONB DEFAULT '["*"]',
  can_see_cost  BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_permissions_subject ON data_permissions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_data_permissions_expires ON data_permissions(expires_at) WHERE expires_at IS NOT NULL;
-- RLS 关闭，仅经 SECURITY DEFINER 的 get_user_perms 可读

CREATE TABLE IF NOT EXISTS dept_role_mapping (
  dept_id   TEXT NOT NULL,
  role_id   INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  priority  INT DEFAULT 0,
  PRIMARY KEY (dept_id, role_id)
);

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(id);
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '["*"]';
```

- [ ] **Step 2: 种子——5 角色 + 角色级 data_permissions + dept_role_mapping**

```sql
INSERT INTO roles (code, name, default_landing, default_metric, visible_panels, sort_order) VALUES
  ('boss',         '老板/运营总', '/',          'sale',            '["targets","cost"]', 1),
  ('zone_manager', '战区主管',     '/',          'sale',            '["targets","cost"]', 2),
  ('manager',      '店长',         '/my-store',  'sale',            '["targets"]',         3),
  ('buyer',        '采购/业务',    '/reports/category', 'outbound_amt', '["targets","category_analysis"]', 4),
  ('finance',      '财务',         '/',          'outbound_profit', '["targets","cost"]', 5)
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, default_landing=EXCLUDED.default_landing,
  default_metric=EXCLUDED.default_metric, visible_panels=EXCLUDED.visible_panels, sort_order=EXCLUDED.sort_order;

-- 角色级数据范围（subject_type='role', subject_id=角色 id）
INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost)
SELECT 'role', id::text, '["*"]', '["*"]',
  CASE code WHEN 'buyer' THEN '["水果"]' ELSE '["*"]' END,  -- 采购限品类（示例：水果采购）
  CASE WHEN code IN ('boss','zone_manager','finance') THEN true ELSE false END
FROM roles WHERE code IN ('boss','zone_manager','manager','buyer','finance')
ON CONFLICT (subject_type, subject_id) DO UPDATE SET
  branch_nums=EXCLUDED.branch_nums, brands=EXCLUDED.brands,
  categories=EXCLUDED.categories, can_see_cost=EXCLUDED.can_see_cost;

-- dept_role_mapping 种子：按现有 org_departments 部门名推断（LIKE 匹配）
INSERT INTO dept_role_mapping (dept_id, role_id, priority)
SELECT d.id, r.id,
  CASE WHEN d.name LIKE '%总经办%' OR d.name LIKE '%运营%' THEN 10 ELSE 1 END
FROM org_departments d
CROSS JOIN LATERAL (
  SELECT id FROM roles WHERE code =
    CASE
      WHEN d.name LIKE '%总经办%' OR d.name LIKE '%运营总%' THEN 'boss'
      WHEN d.name LIKE '%战区%' OR d.name LIKE '%区域%' THEN 'zone_manager'
      WHEN d.name LIKE '%店长%' THEN 'manager'
      WHEN d.name LIKE '%采购%' OR d.name LIKE '%业务%' THEN 'buyer'
      WHEN d.name LIKE '%财务%' THEN 'finance'
      ELSE 'manager'  -- 默认店长（最小权限兜底）
    END
) r
WHERE NOT EXISTS (SELECT 1 FROM dept_role_mapping m WHERE m.dept_id=d.id AND m.role_id=r.id);
-- 退役 retail_query_user_perms（保留只读，同 lemeng_items 教训）
REVOKE INSERT, UPDATE, DELETE ON retail_query_user_perms FROM anon, authenticated;
```

> dept_role_mapping 的部门名匹配规则需根据实际 `org_departments.name` 调整——执行时先 `SELECT name FROM org_departments` 看真实部门名再校准 LIKE。

- [ ] **Step 3: 跑迁移验证**

```bash
cd deploy && bash ../scripts/migrate.sh
docker compose restart postgrest
# 验证
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT code,name,default_landing,default_metric FROM roles ORDER BY sort_order;"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT subject_type,subject_id,branch_nums,brands,categories,can_see_cost FROM data_permissions;"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT count(*) FROM dept_role_mapping;"
```
Expected: 5 角色；5 条角色级 data_permissions；dept_role_mapping 有行（部门数相关）。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/072_permission_roles.sql
git commit -m "feat(perm): 072 角色权限表+种子(roles/data_permissions/dept_role_mapping)"
```

---

## Task 2: DB 迁移——get_user_perms 升级（四维合并 + 临时授权）

**Files:**
- Modify: `database/migrations/072_permission_roles.sql`（追加到同一文件）

**Interfaces:**
- Produces: `get_user_perms(p_wecom_id TEXT)` 返回 `{branch_nums, brands, categories, can_see_cost, role_code, default_landing, default_metric, visible_panels}`；辅助函数 `claim_match_or_star(p_claim JSONB, p_value TEXT)`

- [ ] **Step 1: 辅助函数 claim_match_or_star**

```sql
-- 判断 value 是否落在 claim JSONB 数组里；数组含 "*" 或为空则放行
CREATE OR REPLACE FUNCTION claim_match_or_star(p_claim JSONB, p_value TEXT) RETURNS BOOLEAN AS $$
BEGIN
  IF p_claim IS NULL OR p_value IS NULL THEN RETURN true; END IF;
  IF p_claim ? '0' = false AND jsonb_array_length(p_claim) = 0 THEN RETURN true; END IF;
  IF p_claim @> '"*"'::jsonb THEN RETURN true; END IF;
  RETURN p_claim @> jsonb_build_array(p_value);
END;
$$ LANGUAGE plpgsql IMMUTABLE;
```

- [ ] **Step 2: get_user_perms 升级（合并 角色底座 ∪ 部门 ⊕ 个人 override）**

```sql
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id TEXT) RETURNS JSONB AS $$
DECLARE
  v_role_id INT; v_role_code TEXT;
  v_branch JSONB; v_brands JSONB; v_cats JSONB; v_cost BOOLEAN;
  v_dept_branch JSONB; v_dept_cost BOOLEAN;
  v_user_branch JSONB; v_user_brands JSONB; v_user_cats JSONB; v_user_cost BOOLEAN;
  v_has_user BOOL;
BEGIN
  SELECT u.role_id INTO v_role_id FROM org_users u WHERE u.wecom_id=p_wecom_id AND u.is_active;
  -- 1) 角色底座
  SELECT r.code, r.default_landing, r.default_metric, r.visible_panels, r.can_see_cost
    INTO v_role_code, v_branch, v_brands, v_cats, v_cost  -- 复用变量暂存 UI 字段，下面分开查
  FROM roles r WHERE r.id=v_role_id AND r.is_active;
  SELECT coalesce(jsonb_agg(DISTINCT x.v), '["*"]'),
         coalesce(jsonb_agg(DISTINCT x.b), '["*"]'),
         coalesce(jsonb_agg(DISTINCT x.c), '["*"]'),
         bool_or(x.cost)
    INTO v_branch, v_brands, v_cats, v_cost
  FROM (
    SELECT dp.branch_nums v, dp.brands b, dp.categories c, dp.can_see_cost cost
    FROM data_permissions dp WHERE dp.subject_type='role' AND dp.subject_id=v_role_id::text
  ) x;
  -- 2) 部门补充（org_departments.branch_nums/can_see_cost 聚合）
  SELECT coalesce(jsonb_agg(DISTINCT n), '["*"]'),
         bool_or(coalesce((d.can_see_cost), false))
    INTO v_dept_branch, v_dept_cost
  FROM org_departments d
  CROSS JOIN LATERAL jsonb_array_elements_text(d.branch_nums) AS n
  WHERE d.id::text = ANY (SELECT jsonb_array_elements_text(department_ids) FROM org_users WHERE wecom_id=p_wecom_id)
    AND d.is_active;
  -- 3) 个人 override（聚合所有生效条目，含临时授权）
  SELECT coalesce(jsonb_agg(DISTINCT n), '["*"]'),
         coalesce(jsonb_agg(DISTINCT b), '["*"]'),
         coalesce(jsonb_agg(DISTINCT c), '["*"]'),
         bool_or(cost), bool_or(count(*)>0)
    INTO v_user_branch, v_user_brands, v_user_cats, v_user_cost, v_has_user
  FROM (
    SELECT dp.branch_nums, dp.brands b, dp.categories c, dp.can_see_cost cost
    FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW())
  ) dp CROSS JOIN LATERAL jsonb_array_elements_text(dp.branch_nums) AS n;
  -- 合并：个人命中用个人，否则 角色∪部门
  RETURN jsonb_build_object(
    'role_code', v_role_code,
    'branch_nums', CASE WHEN v_has_user THEN v_user_branch
                        ELSE (
                          CASE WHEN v_branch @> '"*"'::jsonb OR v_dept_branch @> '"*"'::jsonb
                               THEN '["*"]'::jsonb
                               ELSE v_branch || v_dept_branch END) END,
    'brands',      CASE WHEN v_has_user THEN v_user_brands ELSE coalesce(v_brands,'["*"]') END,
    'categories',  CASE WHEN v_has_user THEN v_user_cats ELSE coalesce(v_cats,'["*"]') END,
    'can_see_cost',CASE WHEN v_has_user THEN v_user_cost ELSE (coalesce(v_cost,false) OR coalesce(v_dept_cost,false)) END,
    'default_landing', (SELECT default_landing FROM roles WHERE id=v_role_id),
    'default_metric',  (SELECT default_metric  FROM roles WHERE id=v_role_id),
    'visible_panels',  (SELECT visible_panels  FROM roles WHERE id=v_role_id)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON get_user_perms TO anon, authenticated;
```

> 上面 SQL 为骨架，含聚合逻辑；执行时验证各分支返回。jsonb 聚合 `["*"]` 通配处理要测。

- [ ] **Step 3: 验证 RPC**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
 "SELECT get_user_perms('ZhangDuo');"  -- 替换为真实 wecom_id
# 期望返回 JSONB，含 role_code/branch_nums/brands/categories/can_see_cost/landing 等
```
分别测：有角色用户、无角色用户（claim 缺字段兜底）、有个人 override 用户、临时授权过期用户。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/072_permission_roles.sql
git commit -m "feat(perm): get_user_perms 升级(四维合并+临时授权+claim_match_or_star)"
```

---

## Task 3: DB 迁移——report_*_v 四维过滤

**Files:**
- Modify: `database/migrations/072_permission_roles.sql`（追加）

**Interfaces:**
- Produces: `report_*_v` 视图加 brand/category 过滤（claim 缺失=放行兜底）

- [ ] **Step 1: 重建 report_daily_sales_v / _category_v（加 brand + category 过滤）**

```sql
DROP VIEW IF EXISTS report_daily_sales_v;
CREATE VIEW report_daily_sales_v AS
SELECT s.biz_date, s.system_book_code, s.branch_num, s.branch_name,
       s.total_orders, s.total_items, s.total_sale,
       CASE WHEN coalesce(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN s.total_profit ELSE NULL END AS total_profit
FROM report_daily_sales s
WHERE claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num)
  AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code);
-- current_setting(..., true) 第二参 true=缺失返回 NULL 不报错；claim_match_or_star(NULL,...)=放行
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
GRANT SELECT ON report_daily_sales_v TO authenticated, anon;

-- report_daily_category_v 同理 + category 过滤（category 列是品类组）
DROP VIEW IF EXISTS report_daily_category_v;
CREATE VIEW report_daily_category_v AS
SELECT c.biz_date, c.system_book_code, c.branch_num, c.category,
       c.total_sale,
       CASE WHEN coalesce(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN c.total_profit ELSE NULL END AS total_profit
FROM report_daily_category c
WHERE claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, c.branch_num)
  AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, c.system_book_code)
  AND claim_match_or_star(current_setting('request.jwt.claims.categories', true)::jsonb, c.category);
ALTER VIEW report_daily_category_v SET (security_invoker = true);
GRANT SELECT ON report_daily_category_v TO authenticated, anon;
```

- [ ] **Step 2: agent-query 的 DuckDB 视图加 brand/category**

见 Task 5（agent-query 改造时一并加 `WHERE system_book_code IN brands AND category_group IN categories`）。

- [ ] **Step 3: 验证 RLS 四维（本地伪造 claim curl）**

用 `scripts/dev-token.sh`（Task 11 建）签不同 claim 的 JWT，走 InsForge 网关或直连 PostgREST 验证：
- 采购 claim `categories:["水果"]` → report_daily_category_v 只返回水果行
- 店长 claim `branch_nums:["54"]` → 只返回 54 店
- 无 claim 字段（旧 token）→ 全放行（兜底）

- [ ] **Step 4: Commit**

```bash
git add database/migrations/072_permission_roles.sql
git commit -m "feat(perm): report_*_v 四维过滤(brand/category/branch/cost)"
```

---

## Task 4: wecom-oauth claim 扩展

**Files:**
- Modify: `functions/wecom-oauth/index.js`

**Interfaces:**
- Consumes: `get_user_perms(wecom_id)` RPC（Task 2）
- Produces: 登录 JWT claim 加 `role_code/branch_nums/brands/categories/can_see_cost/default_landing/default_metric/visible_panels`

- [ ] **Step 1: 登录后调 get_user_perms 并写入 claim**

在 `functions/wecom-oauth/index.js` 的 upsert org_users 之后、signJwt 之前插入：

```js
// 调 get_user_perms 拿合并后权限（角色+四维+UI）
let perms = {};
try {
  const permRes = await fetch(`${INSFORGE_API_BASE || 'http://insforge:7130'}/rest/v1/rpc/get_user_perms`, {
    method: 'POST',
    headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_wecom_id: wecomUserId })
  });
  if (permRes.ok) perms = await permRes.json();
} catch (e) { console.error('get_user_perms failed', e); }
// claim 合并：缺字段兜底（旧用户不破坏）
const payload = {
  sub: wecomUserId, role: 'authenticated', departments: deptIds || [],
  role_code: perms.role_code || null,
  branch_nums: perms.branch_nums || ['*'],
  brands: perms.brands || ['*'],
  categories: perms.categories || ['*'],
  can_see_cost: perms.can_see_cost ?? false,
  default_landing: perms.default_landing || '/',
  default_metric: perms.default_metric || 'sale',
  visible_panels: perms.visible_panels || [],
  iss: 'wecom-oauth', iat: now, exp: now + 7*86400
};
const token = await signJwt(payload, JWT_SECRET);
```

> 实际改造时定位现有 signJwt 调用处替换 payload。fetch get_user_perms 走 InsForge `/rest/v1/rpc/`（生产有此路由；本地缺，本地测用 dev-login 伪造）。

- [ ] **Step 2: 部署 function（SSH PUT + 清缓存）**

```bash
# CLAUDE.md 流程：只改 function 走 SSH，不 push GHA
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   body=$(jq -n --arg slug wecom-oauth --arg name wecom-oauth --arg desc wecom-oauth --rawfile code "$PWD/../functions/wecom-oauth/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
   curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/wecom-oauth'
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 3: 验证（生产企微登录或本地 dev-login 对照）**

```bash
# 解码一个真实登录的 JWT payload 看是否含 role_code/branch_nums 等
echo "<insforge_access_token>" | cut -d. -f2 | base64 -d 2>/dev/null
```
Expected: payload 含 `role_code`、`branch_nums`、`brands`、`categories`、`can_see_cost`、`default_landing` 等字段。

- [ ] **Step 4: Commit**

```bash
git add functions/wecom-oauth/index.js
git commit -m "feat(perm): wecom-oauth 调 get_user_perms 扩展 claim(四维+UI)"
```

---

## Task 5: agent-query 短时 JWT 加 brands/categories

**Files:**
- Modify: `functions/agent-query/index.js`

**Interfaces:**
- Produces: 网关签的 300s JWT 带 `branch_nums/brands/categories/can_see_cost`；DuckDB retail_detail 视图加 brand/category WHERE

- [ ] **Step 1: serviceJwt 加 brands/categories**

在 `functions/agent-query/index.js` 的 signJwt（PG 路径）处，payload 补 brands/categories：

```js
// 现有：signJwt({ sub:'agent-query', role:'authenticated', branch_nums, can_see_cost }, ...)
// 改为：
const pgPayload = {
  sub: 'agent-query', role: 'authenticated',
  branch_nums: perms.branch_nums || ['*'],
  brands: perms.brands || ['*'],
  categories: perms.categories || ['*'],
  can_see_cost: perms.can_see_cost ?? false,
  iss: 'agent-query', iat: now, exp: now + 300
};
```

- [ ] **Step 2: DuckDB retail_detail 视图加 brand/category 过滤**

`runDuckdb` 里建 temp view 的 SQL（现有 `WHERE branch_num IN (...)`）扩展：

```js
// 现有：CREATE OR REPLACE TEMP VIEW retail_detail AS SELECT * REPLACE (...) FROM read_parquet('...') WHERE branch_num IN (...)
// 扩展 brand + category（retail_detail 明细按 system_book_code 路径 + 品类字段）
const branchList = perms.branch_nums.includes('*') ? null : perms.branch_nums.map(b=>`'${b}'`).join(',');
const brandList  = perms.brands.includes('*') ? null : perms.brands.map(b=>`'${b}'`).join(',');
const catList    = perms.categories.includes('*') ? null : perms.categories.map(c=>`'${c}'`).join(',');
const where = [
  branchList ? `branch_num IN (${branchList})` : null,
  brandList  ? `system_book_code IN (${brandList})` : null,
  catList    ? `category_group IN (${catList})` : null
].filter(Boolean).join(' AND ');
const viewSql = `CREATE OR REPLACE TEMP VIEW retail_detail AS SELECT * REPLACE (${costMask}) FROM read_parquet('${retailGlob}') ${where ? 'WHERE ' + where : ''}`;
```

> `category_group` 字段需 retail_detail parquet 有（如无，先在 collect 落地时补，或用现有 category 字段映射）。执行时确认明细品类字段名。

- [ ] **Step 3: SSH 部署 + 验证**

部署同 Task 4 Step 2（slug=agent-query）。验证：伪造不同 perms 的请求 POST 网关，查 `agent_query_logs.final_sql` 的视图定义是否含 brand/category WHERE。

- [ ] **Step 4: Commit**

```bash
git add functions/agent-query/index.js
git commit -m "feat(perm): agent-query 短时JWT+DuckDB视图加 brand/category 过滤"
```

---

## Task 6: 通讯录同步联动 role_id

**Files:**
- Modify: `functions/wecom-sync-contacts/index.js`
- Modify: `web/app/api/wecom-contacts-webhook/route.ts`

**Interfaces:**
- Consumes: `dept_role_mapping` 表（Task 1）
- Produces: 同步用户 upsert 时按 department_ids 查 dept_role_mapping 赋 org_users.role_id

- [ ] **Step 1: wecom-sync-contacts 赋 role_id**

在 `functions/wecom-sync-contacts/index.js` 的 user upsert 循环里，upsert 前算 role_id：

```js
// 给每个用户算 role_id：按 department_ids 查 dept_role_mapping，取 priority 最高
for (const u of users) {
  let roleId = null;
  if (u.department && u.department.length) {
    const deptIds = u.department.map(String);
    const mRes = await client.database.from('dept_role_mapping')
      .select('role_id, priority').in('dept_id', deptIds).order('priority', { ascending: false }).limit(1);
    if (mRes.data && mRes.data[0]) roleId = mRes.data[0].role_id;
  }
  // upsert org_users 时带 role_id（现有 upsert 对象加 role_id: roleId）
  await client.database.from('org_users').upsert({
    wecom_id: u.userid, name: u.name, department_ids: u.department || [],
    position: u.position, mobile: u.mobile, email: u.email, avatar: u.avatar,
    is_active: true, role_id: roleId, synced_at: new Date().toISOString()
  }, { onConflict: 'wecom_id' });
}
```

- [ ] **Step 2: wecom-contacts-webhook（create/update_user）同样赋 role_id**

`web/app/api/wecom-contacts-webhook/route.ts` 的 create/update_user 分支，拉 user/get 快照后 upsert 时算 role_id（同 Step 1 逻辑，提到 helper）：

```ts
// 抽 helper：resolveRoleId(deptIds: string[]) → number|null
async function resolveRoleId(deptIds: string[]): Promise<number | null> {
  if (!deptIds.length) return null;
  const { data } = await client.database.from('dept_role_mapping')
    .select('role_id, priority').in('dept_id', deptIds).order('priority', { ascending: false }).limit(1);
  return data?.[0]?.role_id ?? null;
}
// upsert org_users 处加 role_id: await resolveRoleId(snap.department?.map(String) ?? [])
```

- [ ] **Step 3: 验证（mock 同步事件）**

```bash
# 触发全量同步（生产/staging）
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
# 查 role_id 是否赋上
docker exec deploy-postgres-1 psql -U postgres -d insforge -c \
  "SELECT wecom_id, name, role_id FROM org_users WHERE role_id IS NOT NULL LIMIT 10;"
```
Expected: 部门匹配 dept_role_mapping 的用户 role_id 有值。

- [ ] **Step 4: Commit**

```bash
git add functions/wecom-sync-contacts/index.js web/app/api/wecom-contacts-webhook/route.ts
git commit -m "feat(perm): 通讯录同步联动 dept_role_mapping 自动赋 role_id"
```

---

## Task 7: web/lib/auth.ts claim 解析 helper

**Files:**
- Modify: `web/lib/auth.ts`

**Interfaces:**
- Produces: `parsePermClaims(req)` 返回 `{ roleCode, landing, defaultMetric, visiblePanels, branchNums, brands, categories, canSeeCost }`

- [ ] **Step 1: 加 claim 解析 helper**

```ts
// web/lib/auth.ts（现有 ADMIN_USERIDS / isAdmin 保留）
export const ADMIN_USERIDS = new Set(["ZhangDuo", "YangWei"]);
export function isAdmin(userid?: string) { return !!userid && ADMIN_USERIDS.has(userid); }

import type { ReadonlyRequestCookies } from 'next/dist/server/web/spec-extension/adapters/request-cookies';
import { decodeJwtPayload } from './monitor/jwt';

export interface PermClaims {
  roleCode: string | null;
  landing: string;
  defaultMetric: string;
  visiblePanels: string[];
  branchNums: string[];
  brands: string[];
  categories: string[];
  canSeeCost: boolean;
}

export function parsePermClaims(cookies: ReadonlyRequestCookies): PermClaims {
  const token = cookies.get('insforge_access_token')?.value;
  const p = token ? decodeJwtPayload(token) : null;
  return {
    roleCode: (p?.role_code as string) ?? null,
    landing: (p?.default_landing as string) || '/',
    defaultMetric: (p?.default_metric as string) || 'sale',
    visiblePanels: Array.isArray(p?.visible_panels) ? p.visible_panels : [],
    branchNums: Array.isArray(p?.branch_nums) ? p.branch_nums : ['*'],
    brands: Array.isArray(p?.brands) ? p.brands : ['*'],
    categories: Array.isArray(p?.categories) ? p.categories : ['*'],
    canSeeCost: !!p?.can_see_cost,
  };
}
```

- [ ] **Step 2: 验证（vitest 单测）**

`web/lib/__tests__/auth.test.ts`：
```ts
import { parsePermClaims } from '../auth';
function mkCookie(token: string) { return { get: (k:string) => k==='insforge_access_token' ? { value: token } : undefined } as any; }
test('无 token → 默认全量', () => {
  const c = parsePermClaims(mkCookie(''));
  expect(c.branchNums).toEqual(['*']); expect(c.canSeeCost).toBe(false); expect(c.landing).toBe('/');
});
test('有 role claim → 解析', () => {
  const jwt = Buffer.from(JSON.stringify({role_code:'buyer',default_metric:'outbound_amt',visible_panels:['category_analysis'],categories:['水果'],can_see_cost:false})).toString('base64url');
  const fakeToken = `h.${jwt}.s`;
  const c = parsePermClaims(mkCookie(fakeToken));
  expect(c.roleCode).toBe('buyer'); expect(c.defaultMetric).toBe('outbound_amt'); expect(c.categories).toEqual(['水果']);
});
```
Run: `cd web && npx vitest run lib/__tests__/auth.test.ts`

- [ ] **Step 3: Commit**

```bash
git add web/lib/auth.ts web/lib/__tests__/auth.test.ts
git commit -m "feat(perm): web claim 解析 helper parsePermClaims + 单测"
```

---

## Task 8: 登录回调按 landing 跳转

**Files:**
- Modify: `web/app/auth/callback/route.ts`

- [ ] **Step 1: 回调读 claim landing 跳转**

```ts
// web/app/auth/callback/route.ts
// exchangeWecomCode 成功设 cookie 后，解码 token 拿 landing
import { decodeJwtPayload } from '@/lib/monitor/jwt';
// ... 设 cookie 后：
const payload = decodeJwtPayload(access_token);
const landing = (payload?.default_landing as string) || '/';
const safeTarget = landing.startsWith('/') ? landing : '/';
return NextResponse.redirect(new URL(safeTarget, origin));
```

- [ ] **Step 2: 验证**

生产企微登录：老板跳 `/`、店长跳 `/my-store`（P2 页未建则先都跳 `/`，Task 9 不依赖）。本地用 dev-login 伪造不同 landing claim 测跳转。

- [ ] **Step 3: Commit**

```bash
git add web/app/auth/callback/route.ts
git commit -m "feat(perm): 登录回调按 role default_landing 跳转"
```

---

## Task 9: 报表页默认 metric 读 claim

**Files:**
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Modify: `web/app/reports/targets/[id]/page.tsx`（透传 perm claims）

- [ ] **Step 1: page.tsx 解析 claim 传 defaultMetric**

`page.tsx` 加：
```ts
import { parsePermClaims } from '@/lib/auth';
import { cookies } from 'next/headers';
// ...
const perm = parsePermClaims(await cookies());
// 传给 DesktopDashboard / MobileDashboard: defaultMetric={perm.defaultMetric}
```

- [ ] **Step 2: desktop.tsx / mobile.tsx 用 defaultMetric 作 focus 初值**

```tsx
// 现有: const [focus, setFocus] = useState<MetricCode>('sale');
// 改: 接受 defaultMetric prop，校验是否在 METRIC_ORDER 内
export default function DesktopDashboard({ target, kpi, trend, breakdown, freshness, defaultMetric = 'sale' }: Props) {
  const [focus, setFocus] = useState<MetricCode>(
    (METRIC_ORDER as readonly string[]).includes(defaultMetric) ? (defaultMetric as MetricCode) : 'sale'
  );
  // ...
}
```
mobile.tsx 同理。

- [ ] **Step 3: 验证（伪造 claim + curl）**

```bash
# 伪造财务 claim（default_metric=outbound_profit）访问报表页，看 focus 是否成本毛利
TOKEN=$(bash scripts/dev-token.sh finance)  # Task 11 建
/usr/bin/curl -s -H "Cookie: insforge_access_token=$TOKEN; wecom_userid=ZhangDuo" http://localhost:3000/reports/targets/<id> | grep -o 'outbound_profit\|成本毛利' | head -1
```

- [ ] **Step 4: Commit**

```bash
git add web/app/reports/targets/[id]/
git commit -m "feat(perm): 报表页默认 metric 按 role claim"
```

---

## Task 10: admin 角色管理页 + API

**Files:**
- Create: `web/app/admin/roles/page.tsx`
- Create: `web/app/api/admin/roles/route.ts`
- Modify: `database/migrations/072_permission_roles.sql`（加 admin RPC：upsert_role/get_roles_admin，追加）

- [ ] **Step 1: RPC（upsert_role / get_roles_admin）**

```sql
CREATE OR REPLACE FUNCTION get_roles_admin() RETURNS JSONB AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'code',code,'name',name,'default_landing',default_landing,
    'default_metric',default_metric,'visible_panels',visible_panels,
    'is_active',is_active,'data_permissions',
      (SELECT jsonb_agg(dp.* ) FROM data_permissions dp WHERE dp.subject_type='role' AND dp.subject_id=roles.id::text)
  )), '[]')
  FROM roles ORDER BY sort_order;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
GRANT EXECUTE ON get_roles_admin TO anon, authenticated;

CREATE OR REPLACE FUNCTION upsert_role(p_id INT, p_code TEXT, p_name TEXT, p_landing TEXT, p_metric TEXT, p_panels JSONB, p_branch JSONB, p_brands JSONB, p_cats JSONB, p_cost BOOLEAN, p_by TEXT) RETURNS INT AS $$
DECLARE v_id INT;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO roles (code,name,default_landing,default_metric,visible_panels) VALUES (p_code,p_name,p_landing,p_metric,p_panels) RETURNING id INTO v_id;
  ELSE
    UPDATE roles SET code=p_code,name=p_name,default_landing=p_landing,default_metric=p_metric,visible_panels=p_panels,updated_at=NOW() WHERE id=p_id RETURNING id INTO v_id;
  END IF;
  -- 角色级 data_permissions（upsert）
  DELETE FROM data_permissions WHERE subject_type='role' AND subject_id=v_id::text;
  INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost)
    VALUES ('role', v_id::text, p_branch, p_brands, p_cats, p_cost);
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
GRANT EXECUTE ON upsert_role TO anon, authenticated;
```

- [ ] **Step 2: API route**

`web/app/api/admin/roles/route.ts`：
```ts
// GET: 调 get_roles_admin；POST: 调 upsert_role。走 PostgREST /rpc（同 targets route 模式）
// headers: { apikey: INSFORGE_API_KEY, Authorization: Bearer INSFORGE_API_KEY }
export async function GET() { /* fetch postgrest:3000/rpc/get_roles_admin */ }
export async function POST(req: Request) { /* body → upsert_role */ }
```

- [ ] **Step 3: admin 页面**

`web/app/admin/roles/page.tsx`：'use client'，角色列表（code/name/landing/metric/cost）+ 编辑 Modal（default_landing/metric/visible_panels 复选 + branch/brands/categories/cost 输入）。参照 `web/app/admin/targets/page.tsx` 模式。DESIGN.md：lucide icon、tabular-nums、bg-primary、无 emoji。

- [ ] **Step 4: 验证 + Commit**

浏览器 `/admin/roles`（dev-login cookie）→ 新建/编辑角色 → 查 DB 确认 roles + data_permissions 更新。
```bash
git add web/app/admin/roles/ web/app/api/admin/roles/ database/migrations/072_permission_roles.sql
git commit -m "feat(perm): admin 角色管理页 + API + RPC"
```

---

## Task 11: admin 用户授权页（含临时授权）+ dev-login + dev-token

**Files:**
- Create: `web/app/admin/users/page.tsx`
- Create: `web/app/api/admin/users/route.ts`
- Create: `web/app/api/auth/dev-login/route.ts`
- Create: `scripts/dev-token.sh`
- Modify: `database/migrations/072_permission_roles.sql`（加 upsert_user_perm RPC）

- [ ] **Step 1: RPC（get_users_admin / upsert_user_perm）**

```sql
CREATE OR REPLACE FUNCTION get_users_admin() RETURNS JSONB AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'wecom_id',wecom_id,'name',name,'role_id',role_id,'role_code',(SELECT code FROM roles WHERE id=org_users.role_id),
    'department_ids',department_ids,'is_active',is_active,
    'overrides',(SELECT jsonb_agg(dp.*) FROM data_permissions dp WHERE dp.subject_type='user' AND dp.subject_id=org_users.wecom_id)
  )), '[]') FROM org_users ORDER BY name;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
GRANT EXECUTE ON get_users_admin TO anon, authenticated;

CREATE OR REPLACE FUNCTION upsert_user_perm(p_wecom_id TEXT, p_branch JSONB, p_brands JSONB, p_cats JSONB, p_cost BOOLEAN, p_expires TIMESTAMPTZ, p_by TEXT) RETURNS VOID AS $$
BEGIN
  DELETE FROM data_permissions WHERE subject_type='user' AND subject_id=p_wecom_id;
  INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost,expires_at,note)
    VALUES ('user', p_wecom_id, p_branch, p_brands, p_cats, p_cost, p_expires, 'by '||coalesce(p_by,'admin'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path=public;
GRANT EXECUTE ON upsert_user_perm TO anon, authenticated;
-- 用户绑角色直接 update org_users.role_id（admin 页 PATCH /api/admin/users）
```

- [ ] **Step 2: API route + 用户页（含临时授权 expires_at 日期选择）**

`web/app/api/admin/users/route.ts`：GET 调 get_users_admin；PATCH body `{wecom_id, role_id}` 更新 org_users.role_id；POST body `{wecom_id, branch_nums, brands, categories, can_see_cost, expires_at}` 调 upsert_user_perm。
`web/app/admin/users/page.tsx`：用户列表（姓名/角色/部门/override 数）+ 编辑 Modal（角色 select + 个人 override：branch/brands/categories/cost + **临时授权 expires_at 日期选择器**）。

- [ ] **Step 3: dev-login 端点（dev-only，落地测试手册 §3.2）**

`web/app/api/auth/dev-login/route.ts`：
```ts
import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({error:'disabled'}, {status:403});
  // 签测试用户 JWT（ZhangDuo 全权限），Set-Cookie 跳 /
  const token = signTestJwt({ sub:'ZhangDuo', role_code:'boss', branch_nums:['*'], brands:['*'], categories:['*'], can_see_cost:true, default_landing:'/', default_metric:'sale', visible_panels:['targets','cost','category_analysis'], role:'authenticated', iss:'dev-login', exp: now+604800 });
  const res = NextResponse.redirect(new URL('/', req.url));
  res.cookies.set('insforge_access_token', token, { httpOnly:true, sameSite:'lax', maxAge:604800 });
  res.cookies.set('wecom_userid', 'ZhangDuo', { maxAge:604800 });
  res.cookies.set('wecom_name', '张铎(dev)', { maxAge:604800 });
  return res;
}
```
（signTestJwt 用 process.env.JWT_SECRET，HS256，同 wecom-oauth 算法）

- [ ] **Step 4: scripts/dev-token.sh（伪造任意角色 claim）**

```bash
#!/usr/bin/env bash
# scripts/dev-token.sh <role_code>  → 输出伪造 JWT（按角色给默认 claim）
ROLE="${1:-boss}"
JWT_SECRET="$(grep '^JWT_SECRET=' deploy/.env | cut -d= -f2- | tr -d '"'"'"'')"
# 按角色映射 claim（boss/zone_manager/manager/buyer/finance）
node -e "const c=require('crypto');const s=process.env.S;const r=process.env.R;
const claim={boss:{branch_nums:['*'],can_see_cost:true,default_metric:'sale',landing:'/'},
 zone_manager:{branch_nums:['54','127'],can_see_cost:true,default_metric:'sale',landing:'/'},
 manager:{branch_nums:['54'],can_see_cost:false,default_metric:'sale',landing:'/'},
 buyer:{branch_nums:['*'],categories:['水果'],can_see_cost:false,default_metric:'outbound_amt',landing:'/reports/category'},
 finance:{branch_nums:['*'],can_see_cost:true,default_metric:'outbound_profit',landing:'/'}}[r]||{};
const now=Math.floor(Date.now()/1000);
const p=Buffer.from(JSON.stringify(Object.assign({sub:'Dev'+r,role_code:r,role:'authenticated',visible_panels:['targets'],iss:'dev',iat:now,exp:now+604800},claim))).toString('base64url');
const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
console.log(h+'.'+p+'.'+c.createHmac('sha256',s).update(h+'.'+p).digest('base64url'));" S="$JWT_SECRET" R="$ROLE"
```
chmod +x。

- [ ] **Step 5: 验证 + Commit**

```bash
# dev-token 各角色
bash scripts/dev-token.sh buyer  # 输出 JWT，设进浏览器 cookie 测采购视图
# dev-login
curl -s http://localhost:3000/api/auth/dev-login -L | grep -o '数据分析平台' | head -1
# admin 用户授权 + 临时授权过期
# 过期验证：配 expires_at=昨天，登录后该 override 不生效
git add web/app/admin/users/ web/app/api/admin/users/ web/app/api/auth/dev-login/ scripts/dev-token.sh database/migrations/072_permission_roles.sql
git commit -m "feat(perm): admin 用户授权(含临时授权)+dev-login+dev-token"
```

---

## 自审（fresh eyes 对照 spec）

**Spec 覆盖**：
- §4 数据模型（roles/data_permissions/dept_role_mapping/org_users）→ Task 1 ✓
- §4.5 企微结合（身份锚定/部门映射/同步联动/登录链路）→ Task 1(dept_role_mapping) + Task 4(登录) + Task 6(同步) ✓
- §5 get_user_perms 合并 + 临时授权 → Task 2 ✓
- §6 claim 两处（wecom-oauth + agent-query）→ Task 4 + Task 5 ✓
- §7 RLS/视图四维 → Task 2(辅助函数) + Task 3(report_*_v) + Task 5(DuckDB 视图) ✓
- §8 UI 角色化 (a) 默认值 → Task 8(landing) + Task 9(metric) ✓；(b) 专属页/导航 → P2（计划外，符合分期）
- §9 admin 管理 → Task 10(roles) + Task 11(users) ✓
- §10 迁移兼容 → Task 1(种子/退役) + Task 6(持续同步) ✓
- §11 测试 → 各 Task 验证步骤 + Task 11(dev-token 参数化) ✓
- §12 P1 范围 → 全覆盖；P2 标注外 ✓

**类型一致**：`get_user_perms` 返回字段（role_code/branch_nums/brands/categories/can_see_cost/default_landing/default_metric/visible_panels）在 Task 2/4/7/9 一致 ✓；`parsePermClaims`（Task 7）字段名与 claim 对齐（role_code/default_metric/visible_panels/branch_nums/brands/categories/can_see_cost）✓。

**部署一致性**：Task 4/5/6 改 function → 走 SSH（不走 GHA）；Task 1/2/3/10/11 改 DB+web → 走 GHA push。Global Constraints 已标注。

**注意**（执行时校准，非占位）：
- Task 1 dept_role_mapping 的部门名 LIKE 规则需对照真实 `org_departments.name` 校准
- Task 5 retail_detail 的 `category_group` 字段名需确认（如明细无此字段，先在 collect 落地补或映射）
- Task 4 wecom-oauth 走 `/rest/v1/rpc/get_user_perms`——本地 InsForge 无此路由，本地测用 dev-login；生产有

---

## 执行选择

Plan complete and saved to `docs/superpowers/plans/2026-07-20-permission-role-architecture.md`. Two execution options:

1. **Subagent-Driven (推荐)** — 每任务派新 subagent，任务间我 review，迭代快
2. **Inline Execution** — 本会话内批量执行，检查点 review

哪种？
