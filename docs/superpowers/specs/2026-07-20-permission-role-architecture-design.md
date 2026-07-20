# 权限架构 · 角色化视图与多维数据权限 设计 spec

> 日期：2026-07-20 ｜ 子系统：权限架构（RLS + 角色 + 数据范围 + UI 角色化）
> 上游：架构文档 §六（鉴权）、§4.2（智能问数鉴权）。本设计为 §六的角色化扩展，实现时并入 architecture.md。
> brainstorming 产物（方案 A 已选定），下一步转 writing-plans。
> 状态：设计已与用户确认（含分期），待写实现计划。

---

## 一、背景与目标

### 1.1 痛点（用户确认）
当前所有登录用户看到的报表范围一致（仅受 `branch_nums` RLS 裁剪），没有「角色」概念决定看什么板块/指标。业务诉求：**不同角色进系统看到不同的数据范围 + UI 呈现**。

### 1.2 目标角色（用户确认清单，可扩展）
| 角色 | 数据范围 | 默认视图 |
|---|---|---|
| 老板/运营总 | 全公司全品牌，含成本 | 全公司 KPI 大盘 |
| 战区主管 | 本战区所有店，**含成本** | 战区汇总 + 门店排行 |
| 店长 | 仅本店，不含成本 | 本店销售/配送看板 |
| 采购/业务 | **按品类**分权（水果/标品），全品牌 | 品类分析 |
| 财务 | 全公司，含成本 | 成本/毛利分析 |

**用户确认的关键事实**：
- 角色清单正确，**中间会增加其他角色**（→ 角色必须数据驱动、可扩展，不能硬编码）
- 采购**按品类分权**（→ 权限模型需加品类维度）
- 战区主管**要看成本**（`can_see_cost=true`）
- 有**临时授权**场景（区域主管临时看另一区域 → 需时效机制）

### 1.3 非目标（YAGNI）
- 完整 RBAC 权限点（report.view / cost.view 之类功能点级控制）——报表为主，过度工程
- 审批流（临时授权需主管审批）——MVP 直接由 admin 配置
- 字段级权限（除成本列外，其他列不细粒度控）
- 行级权限到「单条记录」粒度——维度级（门店/品牌/品类）够

---

## 二、现状与缺口

| 项 | 现状 | 缺口 |
|---|---|---|
| 角色 | `anon`/`authenticated`/`admin`；admin 硬编码白名单 `lib/auth.ts` | 无业务角色概念；admin 硬编码不可扩展 |
| 权限维度 | `branch_nums`（门店）+ `can_see_cost`（成本列） | **缺品牌维度、品类维度** |
| 权限底座 | 部门制（`org_departments.branch_nums/can_see_cost`）+ 按人 override（`retail_query_user_perms`） | 无角色层；个人 override 无时效 |
| JWT claim | `sub/role/departments/branch_nums/can_see_cost` | 无 `brands/categories/role_code/landing` |
| UI | 所有登录用户同报表范围、同默认页/指标 | 无角色化默认值、无角色专属页/导航 |

---

## 三、方案选择（已定 A）

| 方案 | 角色 | 维度 | UI | 可扩展 | 评价 |
|---|---|---|---|---|---|
| **A（选定）** | 角色表驱动 | 四维统一表 | 配置驱动 | 加角色=插行配置 | 平衡灵活度与复杂度 |
| B | 复用部门+role 枚举 | 部门扩列 | 代码映射 | 角色硬编码（加角色改代码） | 不满足「会加角色」 |
| C | 完整 RBAC（角色+权限点+范围三分离） | 任意 | 任意 | 最强 | 过度工程，小团队不需 |

**决策记录**：
- **品类维度用 `category_group`**（水果/标品/耗材三大类）而非 `category_l1` 明细——贴合采购分工（水果采购/标品采购）、维护轻。
- **权限合并优先级**：角色给底座权限 → **个人 override 优先**（临时授权/特例覆盖角色）→ 部门作补充。
- **品牌维度**：大多数角色 `brands=["*"]`（跨品牌看），保留 `brands` 维度以备单品牌限制（如未来某角色只看 3120）。

---

## 四、数据模型

### 4.1 `roles`（角色定义，决定 UI；可扩展）
```sql
CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,      -- boss/zone_manager/manager/buyer/finance
  name            TEXT NOT NULL,             -- 中文名
  default_landing TEXT,                      -- 默认落地路由，如 '/' 或 '/my-store'
  default_metric  TEXT,                      -- 默认聚焦指标 metric_code
  visible_panels  JSONB DEFAULT '[]',        -- 可见面板/导航项 ["targets","category_analysis","cost"]
  -- can_see_cost 统一在 data_permissions(subject_type='role')，此处不放
  sort_order      INT DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
-- 种子：boss / zone_manager / manager / buyer / finance 五个角色
```

### 4.2 `data_permissions`（重构：多维数据范围 + 临时授权）
> 现有 `retail_query_user_perms`（仅按人 branch_nums+cost）+ 部门制权限，统一并入此表。
```sql
CREATE TABLE IF NOT EXISTS data_permissions (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,               -- 'role' | 'user' | 'dept'
  subject_id    TEXT NOT NULL,               -- role_id | wecom_id | dept_id
  branch_nums   JSONB DEFAULT '["*"]',       -- 门店范围
  brands        JSONB DEFAULT '["*"]',       -- 品牌 system_book_code 范围
  categories    JSONB DEFAULT '["*"]',       -- 品类 category_group 范围
  can_see_cost  BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ,                 -- 临时授权时效，NULL=永久
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
-- 故意不加 UNIQUE：同一 subject 允许多条（如「永久基础授权」+ 多个「临时扩展授权」并存），
-- get_user_perms 聚合所有 expires_at IS NULL OR expires_at>now 的条目合并。
CREATE INDEX idx_data_permissions_subject ON data_permissions(subject_type, subject_id);
CREATE INDEX idx_data_permissions_expires ON data_permissions(expires_at) WHERE expires_at IS NOT NULL;
-- RLS 关闭，仅经 SECURITY DEFINER 的 get_user_perms 可读（同 retail_query_user_perms 教训）
```

### 4.3 `org_users` 加角色绑定
```sql
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(id);
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '["*"]';  -- 用户级品牌 override（一般不用）
```

### 4.4 废弃/兼容
- `retail_query_user_perms` → 数据迁入 `data_permissions(subject_type='user')` 后保留只读（同 `lemeng_items` 教训，REVOKE 写权限，不立即 DROP）
- `org_departments.branch_nums/can_see_cost` → 保留作「部门补充」来源（get_user_perms 仍读），不强制迁入

---

### 4.5 与企微鉴权的结合（关键：身份锚定 + 通讯录联动）

所有用户经企微 OAuth 登录，**wecom_id 是唯一可信身份**，权限架构锚定 `org_users.wecom_id`，**不另建用户系统**。结合点：

1. **身份**：`org_users`（企微通讯录同步来的）= 唯一用户表，`role_id` 挂其上。
2. **部门→角色自动映射**（减少逐人手配）：新增表
   ```sql
   CREATE TABLE IF NOT EXISTS dept_role_mapping (
     dept_id   TEXT NOT NULL,                 -- 企微部门 id（org_departments.id）
     role_id   INT NOT NULL REFERENCES roles(id),
     priority  INT DEFAULT 0,                 -- 多部门命中时取 priority 最高
     PRIMARY KEY (dept_id, role_id)
   );
   ```
   admin 配映射规则（如"东部战区"部门→zone_manager，"水果采购部"→buyer，"总经办"→boss）。
3. **通讯录同步联动**（`wecom-sync-contacts` 全量 + `wecom-contacts-webhook` 实时）：
   - 同步用户时，按其 `department_ids` 查 `dept_role_mapping`，自动赋/更新 `org_users.role_id`（多部门取 priority 最高；无匹配→留空待 admin 配）
   - **新员工入职企微 → 通讯录同步 → 自动归角色 + 继承权限**（无需 admin 手动）
   - 用户**调岗**（企微部门变）→ 同步更新 → 角色自动变
   - is_active=false（离职）→ 登录已拦，权限自然失效
4. **登录链路**：`wecom-oauth` 在 `code → wecom_id` 后，调 `get_user_perms(wecom_id)` 拿合并权限（角色 + 四维）→ 签 claim。**角色解析在企微 OAuth 流程内完成**，对用户透明。
5. **临时授权**仍走 `data_permissions(subject_type='user')` 个人 override（与部门→角色映射正交，特例覆盖）。

> **核心原则**：企微是身份 + 组织架构的唯一真相源；角色/权限是挂在其上的「看数据视角」，随通讯录自动同步，admin 只配「部门→角色」规则 + 少量个人 override，不逐人维护。

---

## 五、权限解析（get_user_perms 升级）

`get_user_perms(p_wecom_id)` 改为 SECURITY DEFINER，按优先级合并：

```
1. 角色底座：user.role_id → roles + data_permissions(subject_type='role', subject_id=role_id)
2. 部门补充：user.departments → 聚合 org_departments.branch_nums/can_see_cost（并集 / 任一 true）
3. 个人 override（最高优先）：聚合 data_permissions(subject_type='user', subject_id=wecom_id) 中
   所有生效条目（expires_at IS NULL OR expires_at > now）——允许永久基础 + 多个临时扩展并存
合并规则：
   - branch_nums/brands/categories：个人 override 命中→用个人的；否则 角色∪部门（并集，"*" 通配）
   - can_see_cost：个人命中→个人的；否则 角色 OR 部门（任一 true）
   - landing/default_metric/visible_panels：来自角色（个人不覆盖 UI 配置）
返回：{ branch_nums, brands, categories, can_see_cost, role_code, default_landing, default_metric, visible_panels }
```

GRANT EXECUTE 给 anon+authenticated（网关/登录用 service key 调）。

---

## 六、JWT claim 扩展（两处签名点）

### 6.1 `wecom-oauth`（登录签用户 7d JWT）
```json
{
  "sub": "ZhangDuo", "role": "authenticated",
  "role_code": "zone_manager",
  "branch_nums": ["54","127"], "brands": ["*"], "categories": ["*"],
  "can_see_cost": true,
  "landing": "/", "default_metric": "sale",
  "visible_panels": ["targets","category_analysis"],
  "iss": "wecom-oauth", "iat": ..., "exp": ...+7d
}
```
登录时调 `get_user_perms(wecom_id)` 拿合并后权限写入 claim。

### 6.2 `agent-query`（网关签短时 300s JWT，给 PostgREST RLS）
同样带 `branch_nums/brands/categories/can_see_cost`（RLS 用），不需 UI 字段。

> claim 新字段**可选**——旧 token（无新字段）RLS 默认放行（`["*"]`/true），渐进式不破坏现有登录。

---

## 七、RLS / 视图四维过滤

### 7.1 PG 侧（report_*_v 安全视图）
现有 `report_*_v` 按 `branch_nums`（行）+ `can_see_cost`（列 CASE）过滤。扩展：
- **品牌**：`WHERE system_book_code = ANY(string_to_array(replace(replace(current_setting('request.jwt.claims.brands','["*"]'),'"',''),'[',''),','))` 或 claim 为 `["*"]` 时放行（用辅助函数 `claim_contains_or_star(claim_value, value)`）
- **品类**：report_daily_category/delivery/wholesale 已有 category 列 → `WHERE category_group ∈ claim.categories`（claim `["*"]` 放行）
- 新增辅助函数 `claim_match_or_star(json_array_text, value)` 统一处理「`["*"]` 放行 / 否则 IN」逻辑

### 7.2 DuckDB 侧（retail_detail 权限视图，agent-query）
agent-query 建 temp view 时 `WHERE branch_num IN (...) AND system_book_code IN (...brands)` + 成本列 CASE（已有）。加 categories 过滤（retail_detail 明细有品类字段 → category_group）。

### 7.3 brand 进 RLS 的注意
现有 RLS 无 brand 维度（架构文档已知限制：brand 靠查询层 WHERE）。本设计把 brand 纳入 claim + 视图 WHERE，是架构扩展（需更新 architecture.md §4.2/§六）。

---

## 八、UI 角色化（两结合，配置驱动）

### 8.1 (a) 默认值差异（P1，低成本）
- **落地页**：登录回调读 claim `landing` 跳转（老板→`/`、店长→`/my-store`、采购→`/reports/category`）。无 claim 字段默认 `/`。
- **默认聚焦指标**：报表页读 claim `default_metric` 设 KPI focus 初值（财务→`outbound_profit`、店长→`sale`）。
- **默认数据范围**：claim 已带 branch_nums/brands/categories，前端读即可（店长本店、老板全公司、采购限品类）。

### 8.2 (b) 角色专属页/导航（P2）
- **侧边栏显隐**：`sidebar.tsx` 按 claim `visible_panels` 过滤菜单项（采购只见「品类分析」，财务多见「成本毛利」）。
- **新增专属页**：
  - `/my-store`（店长看板，P2）：本店销售/配送单店视图，复用 KPI/LineChart/RankChart
  - `/reports/category`（品类分析，P2）：按 category_group 的采购视图，复用 CrossTable
- 复用现有组件，按角色数据范围渲染，不新写图表。

> 加新角色 = 配 `roles` 表一行 + data_permissions，前端读 claim 自适应，**不改代码**。

---

## 九、admin 管理 UI

- **`/admin/roles`**（新）：角色列表 + CRUD；编辑 default_landing/metric/visible_panels/can_see_cost；配角色级 data_permissions（branch/brand/category 范围）。
- **`/admin/users`**（新/扩展现有）：用户列表（org_users）→ 绑 role_id + 个人 override data_permissions（含 **expires_at 临时授权**时效选择）。
- 走 PostgREST RPC（SECURITY DEFINER，同 targets admin 模式）。
- admin 白名单（`lib/auth.ts`）保留——它是「谁能进 admin 后台」的门禁，与业务角色正交。

---

## 十、迁移兼容（渐进式）

1. 建 `roles` + `data_permissions` 表（幂等迁移）。
2. 种子 5 角色（boss/zone_manager/manager/buyer/finance）+ 角色级 data_permissions（默认范围）。
3. **dept_role_mapping 种子 + 用户初始角色**：迁移种「部门→角色」规则（按现有 `org_departments` 部门名推断，如部门名含"战区"→zone_manager、"采购"→buyer、"总经办"→boss）；再按规则给现有 `org_users` 赋初始 role_id（无匹配→留空待 admin 配）。
4. `retail_query_user_perms` 数据迁入 `data_permissions(subject_type='user')`，原表 REVOKE 写保留只读。
5. claim 新字段可选：wecom-oauth 读 get_user_perms，无角色用户 claim 缺新字段→RLS 默认放行（`["*"]`）→不破坏现有体验。
6. RLS/视图扩展用「claim 缺失=放行」兜底，确保旧 token 不被误拦。
7. **持续同步（关键）**：角色赋值不是一次性迁移——`wecom-sync-contacts` 全量 + `wecom-contacts-webhook` 实时同步时，**长期**按 `dept_role_mapping` 自动赋/更新 `org_users.role_id`（§4.5）。新员工入职 / 调岗 → 自动归角色，admin 不逐人维护。

---

## 十一、测试策略（按 docs/testing-handbook.md）

- **RLS 四维单测**（本地伪造 claim 参数化）：
  - 店长 `branch_nums=[本店], can_see_cost=false` → 只看本店、成本列 NULL
  - 采购 `categories=["水果"], branch_nums=["*"]` → 全门店但只看水果品类
  - 战区主管 `branch_nums=[本战区店], can_see_cost=true` → 本战区+成本
  - 临时授权 `expires_at` 过期 → 不生效
- **权限合并单测**：角色∪部门∪个人 override 优先级（get_user_parms RPC 单测）
- **UI 角色化 e2e**（dev-login 伪造各角色 claim）：落地页/默认指标/导航显隐
- **admin 授权流 e2e**：配角色 + 用户授权 + 临时授权时效
- **企微端到端**（staging，P2 后）：真实企微用户绑角色登录验证

---

## 十二、分期

### P1（MVP，覆盖 80% 价值）
1. `roles` + `data_permissions` 表 + 种子（迁移，幂等）
2. `get_user_perms` 升级（四维合并 + 临时授权时效）
3. claim 扩展（wecom-oauth + agent-query 两处）
4. RLS/视图四维过滤（report_*_v + retail_detail 视图 + 辅助函数）
5. admin `/admin/roles` + `/admin/users`（角色管理 + 用户授权 + 临时授权）
6. UI 默认值差异（(a)：落地页 + 默认指标 + 默认数据范围）
7. 迁移兼容（用户初始角色推断 + retail_query_user_perms 迁入）

### P2
1. 角色专属页/导航（(b)：`/my-store` + `/reports/category` + sidebar 显隐）
2. 临时授权审批流（如需）
3. 单品牌限制角色（如未来需要）

---

## 十三、文件改动清单（P1预估）

**新建**：
- `database/migrations/0XX_permission_roles.sql` — roles + data_permissions + 种子 + get_user_perms 升级 + RLS 扩展 + 辅助函数

**改造**：
- `functions/wecom-oauth/index.js` — 登录调 get_user_perms，claim 加四维 + UI 字段
- `functions/agent-query/index.js` — 短时 JWT 加 brands/categories
- `functions/wecom-sync-contacts/index.js` — 全量同步用户时按 dept_role_mapping 赋/更新 role_id
- `web/app/api/wecom-contacts-webhook/route.ts` — 实时同步（create/update_user）同样赋 role_id
- `web/app/auth/callback/route.ts` — 读 claim landing 跳转
- `web/app/reports/targets/[id]/desktop.tsx` + `mobile.tsx` — 默认 metric 读 claim
- `web/lib/auth.ts` — 加 claim 解析 helper（role_code/landing/panels）
- `web/app/admin/roles/page.tsx`（新）+ `web/app/admin/users/page.tsx`（新/扩展）
- 对应 `web/app/api/admin/roles/route.ts` + `users/route.ts`（新）+ dept_role_mapping 配置入口

**架构文档**：
- `docs/architecture.md` §六 + §4.2 — 补角色模型 + brand/category 维度

---

## 十四、成功标准（P1）

- 5 角色种子建好，admin 能 CRUD 角色 + 配数据范围
- 给用户绑角色后，登录 claim 带四维 + UI 字段
- 店长登录只看本店（branch_nums 生效）+ 成本列 NULL
- 采购登录只看授权品类（categories 生效）
- 战区主管看本战区 + 成本可见
- 临时授权（expires_at）过期后不生效
- 旧用户（未绑角色）登录不破坏（claim 缺字段→默认放行）
- 迁移幂等可重跑
