# 管理后台前端重设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构管理后台页面结构，统一导航，消除重复页面

**Architecture:** 创建统一的 /admin 布局（Header + Sidebar），数据源功能层级化（配置→任务→监控），删除冗余页面

**Tech Stack:** Next.js 16, Tailwind CSS 3.4, TypeScript

## Global Constraints

- 所有页面使用服务端组件（Server Components）
- 使用 Tailwind CSS 3.4，不升级 v4
- npm 安装使用 `--registry=https://registry.npmmirror.com`
- InsForge SDK 用法：`client.database.from()`

---

## Task 1: 创建管理后台布局

**Files:**
- Create: `web/app/admin/layout.tsx`

**Interfaces:**
- Produces: 管理后台布局组件，包含 Header 和 Sidebar

- [ ] **Step 1: 创建 layout.tsx 文件**

```tsx
// web/app/admin/layout.tsx
import { ReactNode } from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const wecomName = cookieStore.get('wecom_name')?.value || '管理员';

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/admin/dashboard" className="font-bold text-lg">
            数据分析平台
          </Link>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded">
            管理后台
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">{wecomName}</span>
          <Link href="/" className="text-sm text-blue-600 hover:underline">
            返回前台
          </Link>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-48 bg-white border-r min-h-[calc(100vh-57px)]">
          <nav className="p-4 space-y-2">
            <NavItem href="/admin/dashboard" icon="📊">
              仪表盘
            </NavItem>
            <div className="pt-2">
              <NavItem href="/admin/sources" icon="📦">
                数据源
              </NavItem>
              <div className="ml-6 mt-1 space-y-1">
                <SubNavItem href="/admin/sources">配置</SubNavItem>
                <SubNavItem href="/admin/sources/tasks">采集任务</SubNavItem>
                <SubNavItem href="/admin/sources/monitor">监控面板</SubNavItem>
              </div>
            </div>
            <div className="pt-4 border-t">
              <NavItem href="#" icon="👥" disabled>
                用户管理
              </NavItem>
              <NavItem href="#" icon="⚙️" disabled>
                系统设置
              </NavItem>
            </div>
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function NavItem({
  href,
  icon,
  children,
  disabled,
}: {
  href: string;
  icon: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 cursor-not-allowed">
        <span>{icon}</span>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded"
    >
      <span>{icon}</span>
      {children}
    </Link>
  );
}

function SubNavItem({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="block px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded"
    >
      {children}
    </Link>
  );
}
```

- [ ] **Step 2: 提交代码**

```bash
git add web/app/admin/layout.tsx
git commit -m "feat(admin): add admin layout with sidebar navigation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 创建仪表盘页面

**Files:**
- Create: `web/app/admin/dashboard/page.tsx`

**Interfaces:**
- Consumes: `/api/admin/collect-stats`
- Produces: 仪表盘页面

- [ ] **Step 1: 创建仪表盘页面**

```tsx
// web/app/admin/dashboard/page.tsx
import Link from 'next/link';

export default async function AdminDashboard() {
  // 获取统计数据
  let stats = { total: 0, enabled: 0, disabled: 0, successToday: 0, failedToday: 0 };

  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_INSFORGE_URL}/api/admin/collect-stats`, {
      headers: {
        'Authorization': `Bearer ${process.env.INFORGE_API_KEY}`,
      },
      cache: 'no-store',
    });
    if (res.ok) {
      stats = await res.json();
    }
  } catch (e) {
    console.error('Failed to fetch stats:', e);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">管理仪表盘</h1>

      {/* 数据源状态 */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-green-600">{stats.enabled}</div>
          <div className="text-sm text-gray-500 mt-1">数据源正常</div>
        </div>
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-yellow-600">{stats.disabled}</div>
          <div className="text-sm text-gray-500 mt-1">数据源告警</div>
        </div>
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <div className="text-3xl font-bold text-gray-400">{stats.total - stats.enabled - stats.disabled}</div>
          <div className="text-sm text-gray-500 mt-1">未配置凭证</div>
        </div>
      </div>

      {/* 今日采集 */}
      <div className="bg-white rounded-lg p-6 shadow-sm mb-8">
        <h2 className="font-bold mb-4">今日采集</h2>
        <div className="flex gap-8">
          <div>
            <span className="text-2xl font-bold text-green-600">{stats.successToday}</span>
            <span className="text-sm text-gray-500 ml-2">成功</span>
          </div>
          <div>
            <span className="text-2xl font-bold text-red-600">{stats.failedToday}</span>
            <span className="text-sm text-gray-500 ml-2">失败</span>
          </div>
        </div>
      </div>

      {/* 快捷入口 */}
      <div className="grid grid-cols-3 gap-4">
        <Link
          href="/admin/sources"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition"
        >
          <div className="text-xl mb-2">📦</div>
          <div className="font-bold">数据源配置</div>
          <div className="text-sm text-gray-500">管理数据源和凭证</div>
        </Link>
        <Link
          href="/admin/sources/tasks"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition"
        >
          <div className="text-xl mb-2">⚡</div>
          <div className="font-bold">采集任务</div>
          <div className="text-sm text-gray-500">配置采集频率</div>
        </Link>
        <Link
          href="/admin/sources/monitor"
          className="bg-white rounded-lg p-6 shadow-sm hover:shadow-md transition"
        >
          <div className="text-xl mb-2">📈</div>
          <div className="font-bold">监控面板</div>
          <div className="text-sm text-gray-500">查看执行日志</div>
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交代码**

```bash
git add web/app/admin/dashboard/page.tsx
git commit -m "feat(admin): add dashboard page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 迁移数据源配置页面

**Files:**
- Create: `web/app/admin/sources/page.tsx`
- Delete: `web/app/sources/page.tsx`
- Delete: `web/app/admin/data-sources/page.tsx`

**Interfaces:**
- Consumes: 现有的 `/api/admin/data-sources` API
- Produces: 数据源配置页面（新路径）

- [ ] **Step 1: 复制现有页面到新位置**

```bash
cp web/app/admin/data-sources/page.tsx web/app/admin/sources/page.tsx
```

- [ ] **Step 2: 调整页面标题和路径**

修改 `web/app/admin/sources/page.tsx`：
- 将页面标题改为 "数据源配置"
- 保持其他功能不变

- [ ] **Step 3: 删除旧页面**

```bash
rm web/app/sources/page.tsx
rm -rf web/app/admin/data-sources
```

- [ ] **Step 4: 提交代码**

```bash
git add web/app/admin/sources/page.tsx
git rm web/app/sources/page.tsx
git rm -r web/app/admin/data-sources
git commit -m "refactor(admin): move data sources page to /admin/sources

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 迁移采集任务页面

**Files:**
- Create: `web/app/admin/sources/tasks/page.tsx`
- Delete: `web/app/admin/collect-tasks/page.tsx`

**Interfaces:**
- Consumes: 现有的 `/api/admin/collect-tasks` API
- Produces: 采集任务页面（新路径）

- [ ] **Step 1: 创建目录并迁移**

```bash
mkdir -p web/app/admin/sources/tasks
cp web/app/admin/collect-tasks/page.tsx web/app/admin/sources/tasks/page.tsx
```

- [ ] **Step 2: 调整页面**

修改 `web/app/admin/sources/tasks/page.tsx`：
- 将页面标题改为 "采集任务"
- 保持其他功能不变

- [ ] **Step 3: 删除旧页面**

```bash
rm -rf web/app/admin/collect-tasks
```

- [ ] **Step 4: 提交代码**

```bash
git add web/app/admin/sources/tasks/page.tsx
git rm -r web/app/admin/collect-tasks
git commit -m "refactor(admin): move collect tasks page to /admin/sources/tasks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 迁移监控面板页面

**Files:**
- Create: `web/app/admin/sources/monitor/page.tsx`
- Delete: `web/app/admin/collect-monitor/page.tsx`

**Interfaces:**
- Consumes: 现有的 `/api/admin/collect-logs` 和 `/api/admin/collect-stats` API
- Produces: 监控面板页面（新路径）

- [ ] **Step 1: 创建目录并迁移**

```bash
mkdir -p web/app/admin/sources/monitor
cp web/app/admin/collect-monitor/page.tsx web/app/admin/sources/monitor/page.tsx
```

- [ ] **Step 2: 调整页面**

修改 `web/app/admin/sources/monitor/page.tsx`：
- 将页面标题改为 "监控面板"
- 保持其他功能不变

- [ ] **Step 3: 删除旧页面**

```bash
rm -rf web/app/admin/collect-monitor
```

- [ ] **Step 4: 提交代码**

```bash
git add web/app/admin/sources/monitor/page.tsx
git rm -r web/app/admin/collect-monitor
git commit -m "refactor(admin): move monitor page to /admin/sources/monitor

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 更新路由保护

**Files:**
- Modify: `web/middleware.ts`

**Interfaces:**
- Produces: 更新后的 matcher 配置

- [ ] **Step 1: 更新 middleware matcher**

修改 `web/middleware.ts` 的 config：

```typescript
export const config = {
  matcher: [
    "/",
    "/reports/:path*",
    "/mobile",
    "/mobile/reports/:path*",
    "/admin/:path*"  // 新增：保护所有 admin 路径
  ],
};
```

- [ ] **Step 2: 提交代码**

```bash
git add web/middleware.ts
git commit -m "feat(middleware): protect admin routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 添加管理入口

**Files:**
- Modify: `web/components/layout/header.tsx`

**Interfaces:**
- Produces: 添加管理后台入口链接

- [ ] **Step 1: 在 Header 添加管理入口**

在 `web/components/layout/header.tsx` 的导航中添加：

```tsx
{/* 仅管理员可见 */}
{userid && ADMIN_USERIDS.has(userid) && (
  <Link
    href="/admin/dashboard"
    className="text-sm text-gray-600 hover:text-gray-900"
  >
    管理后台
  </Link>
)}
```

需要在文件顶部导入 `ADMIN_USERIDS`：

```tsx
const ADMIN_USERIDS = new Set(['ZhangDuo']);
```

- [ ] **Step 2: 提交代码**

```bash
git add web/components/layout/header.tsx
git commit -m "feat(header): add admin panel link for admins

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 创建 admin 入口重定向

**Files:**
- Create: `web/app/admin/page.tsx`

**Interfaces:**
- Produces: 重定向到 dashboard

- [ ] **Step 1: 创建重定向页面**

```tsx
// web/app/admin/page.tsx
import { redirect } from 'next/navigation';

export default function AdminPage() {
  redirect('/admin/dashboard');
}
```

- [ ] **Step 2: 提交代码**

```bash
git add web/app/admin/page.tsx
git commit -m "feat(admin): add redirect from /admin to /admin/dashboard

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 自检清单

**1. Spec 覆盖检查：**
- ✅ 统一管理后台布局 → Task 1
- ✅ 侧边栏导航 → Task 1
- ✅ 仪表盘页面 → Task 2
- ✅ 数据源配置页面 → Task 3
- ✅ 采集任务页面 → Task 4
- ✅ 监控面板页面 → Task 5
- ✅ 路由保护 → Task 6
- ✅ 管理入口 → Task 7
- ✅ 删除旧页面 → Task 3-5
- ✅ admin 重定向 → Task 8

**2. Placeholder 扫描：**
- ✅ 无 TBD/TODO
- ✅ 所有代码完整

**3. 类型一致性：**
- ✅ 使用现有的 `ADMIN_USERIDS`
- ✅ API 路径保持不变

---

**Plan complete. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**