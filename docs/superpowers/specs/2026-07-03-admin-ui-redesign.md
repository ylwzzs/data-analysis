# 管理后台前端重设计

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 重新规划数据源采集系统的管理后台页面结构，解决路径混乱、功能重复、缺少统一导航的问题。

**架构：** 统一管理后台（/admin）+ 侧边栏导航 + 数据源层级结构（配置→任务→监控）

---

## 一、现有问题

1. **路径混乱：** `/reports` 和 `/` 功能重复，`/sources` 和 `/admin/data-sources` 功能重复
2. **缺少统一导航：** `/admin` 下没有侧边栏，页面分散
3. **命名不清晰：** `admin/data-sources` vs `admin/collect-tasks` 不直观
4. **无管理入口：** 用户不知道如何进入管理功能

---

## 二、新路径结构

### 用户前台（普通用户）

| 路径 | 用途 |
|------|------|
| `/` | 首页（报表概览） |
| `/reports/[id]` | 报表详情 |
| `/settings` | 个人设置 |
| `/mobile` | 移动端 |

### 管理后台（管理员）

| 路径 | 用途 | 说明 |
|------|------|------|
| `/admin` | 重定向到 `/admin/dashboard` | 管理入口 |
| `/admin/dashboard` | 仪表盘 | 总览：数据源状态、今日采集、告警 |
| `/admin/sources` | 数据源配置 | 数据源 CRUD + 凭证配置 |
| `/admin/sources/tasks` | 采集任务 | 任务 CRUD + 手动触发 |
| `/admin/sources/monitor` | 监控面板 | 执行日志 + 统计图表 |

---

## 三、导航设计

### 用户前台 Header

```
首页 | 报表 | [用户名 ▼]
```

### 管理后台侧边栏

```
📊 仪表盘        → /admin/dashboard

📦 数据源        → /admin/sources
   └─ 配置       → /admin/sources（数据源列表）
   └─ 采集任务   → /admin/sources/tasks
   └─ 监控面板   → /admin/sources/monitor

👥 用户管理      → 灰显（未来扩展）
⚙️ 系统设置      → 灰显（未来扩展）
```

**层级逻辑：** 数据源 → 采集任务 → 监控结果

---

## 四、各页面内容

### 4.1 仪表盘 `/admin/dashboard`

**用途：** 管理后台总览

**内容：**
- **数据源状态卡片：** 正常/告警/过期数量
- **今日采集统计：** 成功次数、失败次数、采集行数
- **最近告警列表：** token 过期提醒、采集失败通知
- **快捷操作：** 跳转到数据源/任务/监控

---

### 4.2 数据源配置 `/admin/sources`

**用途：** 数据源 CRUD + 凭证配置

**功能：**
- 数据源列表表格：名称、类型、凭证状态、操作
- 新建数据源按钮：弹窗表单（名称、类型、描述）
- 配置凭证按钮：弹窗表单（根据类型动态显示字段）
  - token 类型：输入 token + 过期时间
  - api_key 类型：输入 app_id + app_secret
  - oauth 类型：client_id + client_secret + refresh_token
- 编辑/删除按钮

**凭证状态显示：**
- ✓ 正常（绿色）
- ⚠ 即将过期（黄色，显示剩余天数）
- ✗ 已过期（红色）
- ○ 未配置（灰色）

---

### 4.3 采集任务 `/admin/sources/tasks`

**用途：** 任务 CRUD + 手动触发

**功能：**
- 任务列表表格：名称、数据源、频率、状态、操作
- 新建任务按钮：弹窗表单（名称、数据源、function、频率、存储配置）
- 执行按钮：手动触发采集（POST `/api/admin/collect-tasks?id=xxx` PATCH）
- 启用/禁用开关：切换任务状态
- 编辑/删除按钮

**频率选项：**
- 每小时（`0 * * * *`）
- 每 6 小时（`0 */6 * * *`）
- 每天凌晨 2 点（`0 2 * * *`）
- 自定义 cron

---

### 4.4 监控面板 `/admin/sources/monitor`

**用途：** 执行日志 + 统计图表

**功能：**
- 执行日志表格：时间、任务、状态、耗时、采集数、错误信息
- 筛选器：按任务名、状态（成功/失败）、时间范围
- 统计图表：近 7 天采集趋势（成功/失败折线图）
- 告警列表：当前需要处理的告警

---

## 五、布局组件

### 5.1 管理后台布局 `web/app/admin/layout.tsx`

```
┌─────────────────────────────────────────────┐
│  Header: Logo + "管理后台" + 用户名 + 退出    │
├──────────┬──────────────────────────────────┤
│ Sidebar  │                                  │
│          │         内容区域                  │
│  导航菜单 │                                  │
│          │                                  │
├──────────┴──────────────────────────────────┤
└─────────────────────────────────────────────┘
```

### 5.2 侧边栏组件 `web/components/admin/sidebar.tsx`

- 固定宽度 200px
- 可折叠的"数据源"分组（展开显示子菜单）
- 当前页面高亮
- 底部显示版本/帮助链接

---

## 六、文件变更

### 新建文件

| 文件 | 说明 |
|------|------|
| `web/app/admin/layout.tsx` | 管理后台布局（Header + Sidebar） |
| `web/app/admin/dashboard/page.tsx` | 仪表盘页面 |
| `web/app/admin/sources/page.tsx` | 数据源配置页面（迁移并重命名） |
| `web/app/admin/sources/tasks/page.tsx` | 采集任务页面（迁移并重命名） |
| `web/app/admin/sources/monitor/page.tsx` | 监控面板页面（迁移并重命名） |
| `web/components/admin/sidebar.tsx` | 侧边栏组件 |

### 删除文件

| 文件 | 原因 |
|------|------|
| `web/app/sources/page.tsx` | 功能合并到 admin/sources |
| `web/app/admin/data-sources/page.tsx` | 迁移到 admin/sources |
| `web/app/admin/collect-tasks/page.tsx` | 迁移到 admin/sources/tasks |
| `web/app/admin/collect-monitor/page.tsx` | 迁移到 admin/sources/monitor |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `web/middleware.ts` | 更新 matcher 添加 `/admin/:path*` |
| `web/components/layout/header.tsx` | 添加"管理后台"入口链接 |

---

## 七、技术要点

### 7.1 路由保护

middleware.ts 已有管理员白名单检查，更新 matcher：

```typescript
export const config = {
  matcher: [
    "/",
    "/reports/:path*",
    "/sources",           // 删除此行
    "/mobile",
    "/mobile/reports/:path*",
    "/admin/:path*"       // 新增
  ],
};
```

### 7.2 数据调用

继续使用 `/api/admin/*` API：
- `GET /api/admin/data-sources` → 数据源列表
- `POST /api/admin/data-sources/:id/credentials` → 更新凭证
- `GET /api/admin/collect-tasks` → 任务列表
- `PATCH /api/admin/collect-tasks?id=xxx` → 手动执行
- `GET /api/admin/collect-logs` → 执行日志

### 7.3 响应式设计

- 桌面端：侧边栏固定显示
- 移动端：侧边栏可折叠（抽屉式）

---

## 八、自检清单

1. ✅ 无 TBD/TODO
2. ✅ 路径命名统一（/admin/sources/tasks 而非 /admin/collect-tasks）
3. ✅ 删除重复功能（/sources 合并到 /admin/sources）
4. ✅ 导航结构清晰（仪表盘 → 数据源层级）
5. ✅ 扩展性好（用户管理、系统设置预留位置）

---

**设计完成。请审核后确认是否开始实现。**