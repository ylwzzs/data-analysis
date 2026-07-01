# 企微通讯录同步 + RLS 权限体系实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现企微通讯录同步 + RLS 部门级权限隔离，使不同部门用户只能看到授权的报表。

**Architecture:** 
- 新建 `wecom-sync-contacts` function 调用企微通讯录 API，全量同步部门和用户到数据库
- 登录时查询 `org_users.department_ids`，写入 JWT 的 `departments` 字段
- PostgreSQL RLS 策略根据 JWT 中的 `departments` 过滤报表

**Tech Stack:** InsForge Edge Function (Deno runtime) + PostgreSQL RLS + HS256 JWT

## Global Constraints

- Deno runtime: CommonJS 语法（`module.exports`），不用 ESM import
- 手写 HS256 JWT 签名（`crypto.subtle` HMAC-SHA256），不引入外部库
- 幂等迁移：所有 SQL 带 `IF NOT EXISTS` / `IF EXISTS`
- 企微 API：`qyapi.weixin.qq.com`，需 `access_token` 鉴权
- Secrets：通过 InsForge `/api/secrets` 注入，function 用 `Deno.env.get()` 读取

---

## Task 1: 通讯录同步 function

**Files:**
- Create: `functions/wecom-sync-contacts/index.js`
- Modify: `scripts/deploy-functions.sh`（注入 secrets）
- Test: 手动 invoke + 数据库查询

**Interfaces:**
- Consumes: `WECOM_CORP_ID`, `WECOM_SECRET` secrets（已有）
- Produces: upsert `org_departments` + `org_users` 表

- [ ] **Step 1: 创建 function 目录结构**

```bash
mkdir -p functions/wecom-sync-contacts
```

- [ ] **Step 2: 编写 function 代码**

```javascript
// functions/wecom-sync-contacts/index.js
// 企微通讯录同步：获取部门列表 + 用户列表，upsert 到数据库。
// 定时执行（每日）或手动触发。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET（已有）
module.exports = async function (req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_SECRET");
  if (!corpId || !corpSecret) {
    return json({ error: "WECOM_CORP_ID/WECOM_SECRET secrets not set" }, 500);
  }

  try {
    // 1. 获取 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. 获取部门列表
    const deptRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${accessToken}`
    );
    const deptData = await deptRes.json();
    if (deptData.errcode !== 0) {
      return json({ error: "failed_to_get_departments", detail: deptData }, 502);
    }
    const departments = deptData.department || [];

    // 3. 获取用户列表（遍历每个部门）
    const users = [];
    for (const dept of departments) {
      const userRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${accessToken}&department_id=${dept.id}`
      );
      const userData = await userRes.json();
      if (userData.errcode === 0 && userData.userlist) {
        users.push(...userData.userlist);
      }
    }

    // 4. upsert 到数据库
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });

    // 4.1 同步部门
    if (departments.length > 0) {
      const deptRows = departments.map((d) => ({
        id: String(d.id),
        name: d.name,
        parent_id: d.parentid ? String(d.parentid) : null,
        order_weight: d.order || 0,
        synced_at: new Date().toISOString(),
      }));
      const { error: deptError } = await client.database
        .from("org_departments")
        .upsert(deptRows, { onConflict: "id" });
      if (deptError) {
        return json({ error: "upsert_departments_failed", detail: deptError }, 502);
      }
    }

    // 4.2 同步用户（去重）
    const seen = new Set();
    const userRows = [];
    for (const u of users) {
      if (seen.has(u.userid)) continue;
      seen.add(u.userid);
      userRows.push({
        wecom_id: u.userid,
        name: u.name,
        department_ids: u.department ? u.department.map(String) : [],
        position: u.position || null,
        mobile: u.mobile || null,
        email: u.email || null,
        avatar: u.avatar || null,
        synced_at: new Date().toISOString(),
      });
    }
    if (userRows.length > 0) {
      const { error: userError } = await client.database
        .from("org_users")
        .upsert(userRows, { onConflict: "wecom_id" });
      if (userError) {
        return json({ error: "upsert_users_failed", detail: userError }, 502);
      }
    }

    return json({
      ok: true,
      departments: departments.length,
      users: userRows.length,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
```

- [ ] **Step 3: 修改 deploy-functions.sh 添加同步 function**

在 `scripts/deploy-functions.sh` 的 `for` 循环前，确认 `wecom-sync-contacts` 会被部署（目录存在即可，无需特殊处理）。

验证现有逻辑已支持（line 57-62）：
```bash
for dir in "$FUNCS_DIR"/*/; do
  [ -d "$dir" ] || continue
  slug="$(basename "$dir")"
  [ "$slug" = "mcp" ] && { echo "⊘ 跳过 mcp（占位，暂不部署）"; continue; }
  deploy_one "$dir"
done
```

无需修改，新 function 会自动被遍历部署。

- [ ] **Step 4: 部署并手动测试**

```bash
# 服务器上执行
cd /path/to/deploy
bash scripts/deploy-functions.sh
```

手动触发同步：
```bash
curl -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
```

验证数据库：
```sql
SELECT COUNT(*) FROM org_departments;
SELECT COUNT(*) FROM org_users;
SELECT wecom_id, name, department_ids FROM org_users LIMIT 5;
```

预期：部门数 > 0，用户数 > 0，用户有 department_ids。

- [ ] **Step 5: 提交代码**

```bash
git add functions/wecom-sync-contacts/
git commit -m "feat(wecom): add contacts sync function for RLS permission

- Sync departments and users from WeCom API
- Upsert to org_departments and org_users tables
- Support scheduled daily sync or manual trigger

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 登录时 JWT 加部门信息

**Files:**
- Modify: `functions/wecom-oauth/index.js`
- Test: 登录 → 解码 JWT 验证 departments 字段

**Interfaces:**
- Consumes: `org_users.department_ids`（由 Task 1 同步）
- Produces: JWT payload 包含 `departments: string[]`

- [ ] **Step 1: 读取现有 wecom-oauth 代码**

现有代码结构：
- line 87-95: upsert `org_users`（仅写 wecom_id）
- line 97-109: 签发 JWT（无 departments 字段）

- [ ] **Step 2: 修改登录逻辑，查询部门并加入 JWT**

替换 `functions/wecom-oauth/index.js` 中 line 87-110 为：

```javascript
// 3. upsert org_users + 查询部门信息
const client = createClient({
  baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
  anonKey: Deno.env.get("ANON_KEY"),
});

// 先尝试 upsert（确保用户存在）
await client.database.from("org_users").upsert(
  { wecom_id: wecomUserId },
  { onConflict: "wecom_id" },
);

// 查询用户的部门信息
const { data: user, error: userError } = await client.database
  .from("org_users")
  .select("department_ids")
  .eq("wecom_id", wecomUserId)
  .single();

const departmentIds = user?.department_ids || [];

// 4. 签发 access_token（role=authenticated，携带部门信息）
const now = Math.floor(Date.now() / 1000);
const accessToken = await signJwt(
  {
    sub: wecomUserId,
    role: "authenticated",
    departments: departmentIds,  // 新增：部门 ID 数组
    iss: "wecom-oauth",
    iat: now,
    exp: now + 7 * 86400,
  },
  Deno.env.get("JWT_SECRET"),
);
return json({ ok: true, wecom_userid: wecomUserId, access_token: accessToken });
```

- [ ] **Step 3: 本地测试 JWT 内容**

登录后，从浏览器开发者工具获取 cookie `insforge_access_token`，用 jwt.io 解码。

验证 payload 包含：
```json
{
  "sub": "ZhangSan",
  "role": "authenticated",
  "departments": ["1", "2"],
  "iss": "wecom-oauth",
  "iat": 1750000000,
  "exp": 1750604800
}
```

- [ ] **Step 4: 提交代码**

```bash
git add functions/wecom-oauth/index.js
git commit -m "feat(auth): add departments to JWT for RLS

- Query user's department_ids after login
- Include departments array in JWT payload
- Enable RLS policies to filter by department

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 报表权限字段

**Files:**
- Create: `database/migrations/004_report_permissions.sql`
- Test: 迁移执行后验证字段存在

**Interfaces:**
- Produces: `reports.allowed_departments` 列（JSONB，默认全员可见）

- [ ] **Step 1: 创建迁移文件**

```sql
-- database/migrations/004_report_permissions.sql
-- 报表权限配置：allowed_departments 为部门 ID 数组
-- ["*"] 表示全员可见，["1", "2"] 表示仅部门 1、2 可见
-- 幂等：可重复执行

ALTER TABLE reports 
  ADD COLUMN IF NOT EXISTS allowed_departments JSONB 
  DEFAULT '["*"]'::jsonb;

COMMENT ON COLUMN reports.allowed_departments IS
  '部门 ID 数组，["*"] 表示全员可见';
```

- [ ] **Step 2: 执行迁移**

```bash
# 服务器上
cd /path/to/project
bash scripts/migrate.sh
```

验证：
```sql
\d reports
-- 应看到 allowed_departments 列，类型 jsonb，默认 '["*"]'::jsonb
```

- [ ] **Step 3: 提交代码**

```bash
git add database/migrations/004_report_permissions.sql
git commit -m "feat(db): add allowed_departments to reports for RLS

- JSONB array of department IDs
- Default [\"*\"] means visible to all
- Enable per-department permission control

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: RLS 策略

**Files:**
- Create: `database/migrations/005_rls.sql`
- Test: 不同部门 JWT 查询验证过滤效果

**Interfaces:**
- Consumes: `reports.allowed_departments`（Task 3），JWT `departments`（Task 2）
- Produces: RLS 策略，按部门过滤报表

- [ ] **Step 1: 创建迁移文件**

```sql
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
```

- [ ] **Step 2: 执行迁移**

```bash
bash scripts/migrate.sh
```

- [ ] **Step 3: 测试 RLS 效果**

准备测试数据：
```sql
-- 创建测试报表，仅部门 2 可见
INSERT INTO reports (id, name, allowed_departments) 
VALUES (uuid_generate_v4(), '销售报表', '["2"]'::jsonb);

-- 确保有全员可见报表
SELECT name, allowed_departments FROM reports LIMIT 3;
```

测试 1：带部门 2 的 JWT 查询
```bash
# 使用 departments: ["2"] 的 JWT
curl -H "Authorization: Bearer <JWT_WITH_DEPT_2>" \
  https://data.shanhaiyiguo.com/api/rest/reports
# 应返回：包含「销售报表」
```

测试 2：带部门 1 的 JWT 查询
```bash
# 使用 departments: ["1"] 的 JWT
curl -H "Authorization: Bearer <JWT_WITH_DEPT_1>" \
  https://data.shanhaiyiguo.com/api/rest/reports
# 应返回：不包含「销售报表」
```

- [ ] **Step 4: 提交代码**

```bash
git add database/migrations/005_rls.sql
git commit -m "feat(db): enable RLS for department-level access control

- reports: filter by allowed_departments and JWT departments
- data_files: inherit permission from related reports
- query_logs: user-private access only
- data_sources: visible to all authenticated users

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 定时同步任务

**Files:**
- Modify: `deploy/.env.example`（添加说明）
- Test: cron 任务触发或手动触发

**Interfaces:**
- Consumes: `wecom-sync-contacts` function（Task 1）
- Produces: 每日自动同步

- [ ] **Step 1: 配置服务器 cron 任务**

编辑服务器 crontab：
```bash
crontab -e
```

添加：
```
# 每日 02:00 同步企微通讯录
0 2 * * * curl -sf -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts >> /var/log/wecom-sync.log 2>&1
```

- [ ] **Step 2: 更新 .env.example 添加说明**

在 `deploy/.env.example` 末尾添加：
```bash
# ============ 企微通讯录同步 ============
# 注意：企微应用需配置「通讯录」权限（通讯录同步助手）
# 同步方式：服务器 cron 每日 02:00 执行
# 手动触发：curl -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
```

- [ ] **Step 3: 测试定时任务**

等待次日 02:00 后检查：
```bash
cat /var/log/wecom-sync.log
# 应看到 {"ok":true,"departments":X,"users":Y}
```

或手动触发验证：
```bash
curl -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
```

- [ ] **Step 4: 提交代码**

```bash
git add deploy/.env.example
git commit -m "docs: add WeCom contacts sync cron job documentation

- Daily sync at 02:00 via server cron
- Requires WeCom app \"通讯录\" permission

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收标准

| 序号 | 验收项 | 验证方法 |
|-----|-------|---------|
| 1 | 通讯录同步成功 | 执行 sync function → 数据库有部门+用户数据 |
| 2 | JWT 包含部门 | 登录 → 解码 JWT → payload 有 departments 字段 |
| 3 | 权限字段存在 | `\d reports` → 有 allowed_departments 列 |
| 4 | RLS 生效 | 不同部门 JWT 查询 → 返回不同报表集合 |
| 5 | 定时同步运行 | 次日查看日志 → 有同步成功记录 |

---

## 回滚方案

如 RLS 导致问题，可紧急关闭：
```sql
ALTER TABLE reports DISABLE ROW LEVEL SECURITY;
ALTER TABLE data_files DISABLE ROW LEVEL SECURITY;
ALTER TABLE data_sources DISABLE ROW LEVEL SECURITY;
```

---

## Self-Review 检查

- [x] Spec 覆盖：所有需求点都有对应任务
- [x] 无 Placeholder：所有代码完整，无 TBD/TODO
- [x] 类型一致：JWT departments 为 `string[]`，SQL 中 JSONB 数组
- [x] 幂等迁移：所有 SQL 带 `IF NOT EXISTS` / `DROP IF EXISTS`
