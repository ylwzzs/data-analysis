# 数据源采集系统设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 设计并实现数据源采集系统，支持多数据源统一鉴权配置、多采集任务管理、调度执行、监控告警。

**架构：** 数据源维度（统一鉴权）+ 多采集任务（Edge Function）+ 统一调度器 + 后台管理界面

---

## 一、架构概述

```
┌─────────────────────────────────────────────────────────────────┐
│                        管理员后台                                 │
│  数据源配置 | 采集任务管理 | 监控面板 | 告警配置                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      PostgreSQL                                  │
│  data_sources (鉴权配置)                                         │
│  auth_credentials (加密存储)                                     │
│  collect_tasks (采集任务)                                        │
│  collect_logs (执行日志)                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                  scheduler (Edge Function)                       │
│  - 每分钟检查待执行任务                                          │
│  - 触发采集任务 function                                        │
│  - 记录执行日志                                                  │
│  - 检测 token 过期并发送通知                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┴─────────────────┐
            ↓                                   ↓
┌─────────────────────┐              ┌─────────────────────┐
│ collect-lemeng     │              │ collect-kingdee     │
│ (Edge Function)    │              │ (Edge Function)     │
│ 乐檬爬虫采集        │              │ 金蝶API采集          │
└─────────────────────┘              └─────────────────────┘
            │                                   │
            ↓                                   ↓
┌─────────────────────┐              ┌─────────────────────┐
│ 天翼云 OOS          │              │ PostgreSQL           │
│ /lemeng/sales/     │              │ kingdee_orders 表    │
│ *.parquet          │              │                     │
└─────────────────────┘              └─────────────────────┘
```

---

## 二、数据模型

### 1. data_sources（数据源表）

```sql
CREATE TABLE data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,              -- 数据源名称，如"乐檬"、"金蝶"
  code VARCHAR(50) UNIQUE NOT NULL,         -- 数据源代码，如"lemeng"、"kingdee"
  description TEXT,
  auth_type VARCHAR(50) NOT NULL,           -- 鉴权类型：token/api_key/oauth/basic/custom
  auth_schema JSONB,                       -- 鉴权字段定义
  notify_before_expire INTEGER DEFAULT 1,  -- 过期前几天通知，0表示不通知
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES org_users(id)
);
```

**auth_schema 示例：**

```json
// 乐檬（token 类型，5天过期）
{
  "fields": [
    {"name": "token", "type": "string", "expire_days": 5}
  ]
}

// 金蝶（api_key 类型，无过期）
{
  "fields": [
    {"name": "app_id", "type": "string"},
    {"name": "app_secret", "type": "string"}
  ]
}
```

### 2. auth_credentials（鉴权凭证表）

```sql
CREATE TABLE auth_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES data_sources(id) ON DELETE CASCADE,
  credential_data TEXT NOT NULL,           -- AES加密后的鉴权数据
  expires_at TIMESTAMPTZ,                  -- 过期时间
  last_updated TIMESTAMPTZ DEFAULT now(),
  updated_by UUID REFERENCES org_users(id),
  CONSTRAINT unique_source_credential UNIQUE (source_id)
);
```

### 3. collect_tasks（采集任务表）

```sql
CREATE TABLE collect_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES data_sources(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,               -- 任务名称
  function_slug VARCHAR(100) NOT NULL,      -- 对应的 Edge Function slug
  schedule_cron VARCHAR(50) NOT NULL,       -- 调度频率，cron 表达式
  enabled BOOLEAN DEFAULT true,
  storage_type VARCHAR(20) DEFAULT 'oos',   -- 存储类型：oos/postgresql
  storage_path VARCHAR(200),                -- OOS 路径或 PostgreSQL 表名
  params JSONB,                             -- 任务参数，传递给 function
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE INDEX idx_collect_tasks_next_run ON collect_tasks(next_run_at) WHERE enabled = true;
```

### 4. collect_logs（采集日志表）

```sql
CREATE TABLE collect_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES collect_tasks(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL,              -- running/success/failed
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  rows_collected INTEGER,
  error_message TEXT,
  request_params JSONB,
  response_summary JSONB                   -- 如 {"total": 1000, "stored": 1000}
);

CREATE INDEX idx_collect_logs_task_time ON collect_logs(task_id, started_at DESC);
```

---

## 三、调度器设计

### scheduler Edge Function

```javascript
// functions/scheduler/index.js
module.exports = async function() {
  const now = new Date();
  
  // 1. 查找需要执行的任务
  const tasks = await getDueTasks(now);
  
  // 2. 并发执行（限制并发数）
  const results = await Promise.allSettled(
    tasks.map(task => runCollectTask(task))
  );
  
  // 3. 记录执行结果
  for (const result of results) {
    await logExecution(result);
  }
  
  // 4. 检查即将过期的凭证
  await checkExpiringCredentials(now);
  
  return { executed: tasks.length };
};
```

### 调度频率配置

| 频率选项 | cron 表达式 | 说明 |
|---------|-------------|------|
| 每小时 | `0 * * * *` | 整点执行 |
| 每 6 小时 | `0 */6 * * *` | 0, 6, 12, 18 点执行 |
| 每天 | `0 2 * * *` | 每天凌晨 2 点 |
| 每周一 | `0 2 * * 1` | 每周一凌晨 2 点 |
| 自定义 | 用户输入 cron | 灵活配置 |

---

## 四、鉴权管理

### 鉴权类型

| auth_type | 说明 | 字段示例 |
|-----------|------|---------|
| token | 单 token 鉴权，有过期时间 | `{"fields":[{"name":"token","expire_days":5}]}` |
| api_key | AppID + Secret，无过期 | `{"fields":[{"name":"app_id"},{"name":"app_secret"}]}` |
| oauth | OAuth2 流程 | `{"fields":[{"name":"client_id"},{"name":"client_secret"},{"name":"refresh_token"}]}` |
| basic | HTTP Basic Auth | `{"fields":[{"name":"username"},{"name":"password"}]}` |
| custom | 自定义字段 | 根据实际情况定义 |

### 凭证加密存储

```javascript
// 存储时加密
const encrypted = AES.encrypt(JSON.stringify(credentials), ENCRYPTION_KEY);

// 采集时解密
const credentials = JSON.parse(AES.decrypt(row.credential_data, ENCRYPTION_KEY));
```

### Token 有效期管理

1. **预防性通知**：在 `expires_at - notify_before_expire` 天时发送企微通知
2. **失败检测**：采集失败时检查是否 token 失效，触发告警
3. **更新流程**：
   - 管理员收到通知 → 点击链接进入后台 → 输入新 token → 保存（加密存储，更新过期时间）

---

## 五、监控与告警

### 监控面板

```
┌─────────────────────────────────────────────────────────────────┐
│  采集任务监控                                                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 任务名称     数据源    状态    下次执行    最近结果    操作   ││
│  ├─────────────────────────────────────────────────────────────┤│
│  │ 销售订单采集  乐檬     ✓正常   02:00      成功 1000条  [详情] ││
│  │ 库存数据采集  乐檬     ✓正常   06:00      成功 500条   [详情] ││
│  │ 财务单据采集  金蝶     ⚠告警   03:00      失败        [详情] ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  状态统计：正常运行: 15 个 | 告警: 2 个 | 禁用: 3 个            │
└─────────────────────────────────────────────────────────────────┘
```

### 告警规则

| 场景 | 触发条件 | 通知方式 |
|------|---------|---------|
| Token 即将过期 | expires_at - now <= notify_before_expire 天 | 企微消息 |
| 采集失败 | 单次执行失败 | 企微消息 |
| 连续失败 | 连续失败 >= 3 次 | 企微消息 + 标记任务告警状态 |
| 自动恢复 | 失败后首次成功 | 企微消息（恢复通知） |

### 告警消息模板

**Token 即将过期：**
```
【鉴权提醒】
数据源：乐檬
凭证：token
过期时间：2026-07-05
请及时更新，否则采集任务将中断。

[点击更新]
```

**采集任务失败：**
```
【采集告警】
任务：销售订单采集
数据源：乐檬
执行时间：2026-07-03 02:00
错误：token 已过期
影响：已连续失败 3 次

[查看详情] [立即处理]
```

---

## 六、后台 API 设计

### 管理员 API 端点

```
数据源管理：
GET    /api/admin/data_sources           # 列表
POST   /api/admin/data_sources           # 创建
PUT    /api/admin/data_sources/:id       # 更新
DELETE /api/admin/data_sources/:id       # 删除
POST   /api/admin/data_sources/:id/credentials  # 更新鉴权凭证

采集任务管理：
GET    /api/admin/collect_tasks          # 列表
POST   /api/admin/collect_tasks          # 创建
PUT    /api/admin/collect_tasks/:id      # 更新（频率、启用/禁用）
DELETE /api/admin/collect_tasks/:id      # 删除
POST   /api/admin/collect_tasks/:id/run  # 立即执行（手动触发）

监控查询：
GET    /api/admin/collect_logs           # 执行日志列表
GET    /api/admin/collect_logs/:id       # 日志详情
GET    /api/admin/collect_stats          # 统计数据
GET    /api/admin/alerts                  # 当前告警列表
```

### 权限控制

```sql
-- 管理员角色检查
CREATE POLICY admin_only_policy ON data_sources
  FOR ALL TO authenticated
  USING (current_setting('request.jwt.claims.role') = 'admin');

CREATE POLICY admin_only_policy ON collect_tasks
  FOR ALL TO authenticated
  USING (current_setting('request.jwt.claims.role') = 'admin');
```

---

## 七、前端页面

### 1. 数据源配置页 `/admin/data-sources`

- 数据源列表（名称、鉴权类型、凭证状态、过期时间）
- 新建/编辑数据源弹窗
- 鉴权凭证配置表单（根据 auth_schema 动态生成）
- 凭证状态显示（已配置/未配置/即将过期/已过期）

### 2. 采集任务管理页 `/admin/collect-tasks`

- 任务列表（名称、数据源、频率、状态、上次执行、下次执行）
- 新建任务（选择数据源、配置 function、设置频率、存储位置）
- 编辑任务（修改频率、启用/禁用）
- 手动触发执行按钮

### 3. 监控面板 `/admin/collect-monitor`

- 任务状态总览（正常/告警/禁用数量）
- 执行趋势图（最近 24 小时成功/失败）
- 告警列表（当前需要处理的告警）
- 任务详情（点击查看执行日志）

---

## 八、实现文件清单

| 类型 | 文件路径 | 说明 |
|------|---------|------|
| 数据库迁移 | `database/migrations/xxx_collect_system.sql` | 创建表结构、索引、权限策略 |
| Edge Function | `functions/scheduler/index.js` | 调度器，每分钟执行 |
| Edge Function | `functions/collect-lemeng/index.js` | 乐檬采集示例 |
| Edge Function | `functions/collect-kingdee/index.js` | 金蝶采集示例 |
| 后端 API | `web/app/api/admin/data-sources/route.ts` | 数据源 CRUD |
| 后端 API | `web/app/api/admin/collect-tasks/route.ts` | 任务 CRUD |
| 后端 API | `web/app/api/admin/collect-logs/route.ts` | 日志查询 |
| 后端 API | `web/app/api/admin/collect-stats/route.ts` | 统计数据 |
| 前端页面 | `web/app/admin/data-sources/page.tsx` | 数据源配置页 |
| 前端页面 | `web/app/admin/collect-tasks/page.tsx` | 任务管理页 |
| 前端页面 | `web/app/admin/collect-monitor/page.tsx` | 监控面板 |
| 前端组件 | `web/components/admin/auth-config-form.tsx` | 动态鉴权配置表单 |
| 前端组件 | `web/components/admin/task-schedule-picker.tsx` | 调度频率选择器 |

---

## 九、技术要点

### 1. 调度器触发方式

- **方案 A**：外部 cron 每分钟调用 `POST /api/functions/scheduler`
- **方案 B**：scheduler function 内部 `setInterval` 长驻运行
- **推荐方案 A**：更可控，避免 function 超时问题

### 2. 并发控制

- 调度器使用 `Promise.allSettled` 并发执行任务
- 限制最大并发数（如 5 个），避免资源耗尽

### 3. 数据存储格式

- OOS：Parquet 格式，按日期分区
- PostgreSQL：直接写入目标表

### 4. 错误处理

- 单任务失败不影响其他任务
- 失败任务自动记录日志并触发告警
- 支持手动重试

---

## 十、后续扩展

1. **采集模板**：预置常用数据源的采集模板（如乐檬、金蝶、用友）
2. **数据转换**：采集时支持字段映射、数据清洗
3. **增量采集**：支持基于时间戳的增量采集
4. **采集预览**：配置完成后可预览数据结构
