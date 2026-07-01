# 前端错误处理 + Suspense 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Error Boundary + Suspense + Skeleton，让页面在加载和出错时有良好的用户体验。

**Architecture:**
- Error Boundary 捕获路由和组件错误，显示友好错误页面
- Suspense + loading.tsx 显示骨架屏占位
- API 层包装错误，转换为友好消息

**Tech Stack:** Next.js 15+ error.tsx/loading.tsx + Tailwind CSS + shadcn/ui

## Global Constraints

- Next.js `error.tsx` 必须是 Client Component（"use client"）
- `loading.tsx` 自动包裹 Suspense
- Skeleton 使用 `animate-pulse` 和灰色背景
- 错误消息必须用户友好（不暴露技术细节）
- API 错误在 `lib/api.ts` 层处理，页面层捕获

---

## Task 1: 错误处理工具函数

**Files:**
- Create: `web/lib/error.ts`
- Test: 验证错误转换逻辑

**Interfaces:**
- Produces: `AppError` interface
- Produces: `wrapError()` function
- Produces: `getUserFriendlyMessage()` function

- [ ] **Step 1: 创建错误处理工具**

```typescript
// web/lib/error.ts
/**
 * 应用错误类型
 * 用于统一错误处理和友好的用户提示
 */

export interface AppError {
  type: 'network' | 'auth' | 'not_found' | 'server' | 'unknown';
  message: string;      // 用户友好的消息
  details?: string;     // 开发详情（仅 console）
  retry?: boolean;      // 是否可重试
}

/**
 * 将任意错误转换为友好的 AppError
 */
export function wrapError(error: unknown): AppError {
  // 网络错误
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      type: 'network',
      message: '网络连接失败，请检查网络后重试',
      retry: true,
    };
  }

  // PostgREST/HTTP 错误
  if (error && typeof error === 'object') {
    const err = error as { code?: string; status?: number; message?: string };
    
    // 401 未授权
    if (err.status === 401 || err.code === 'PGRST301') {
      return {
        type: 'auth',
        message: '登录已过期，请重新登录',
        retry: false,
      };
    }
    
    // 404 不存在
    if (err.status === 404) {
      return {
        type: 'not_found',
        message: '请求的资源不存在',
        retry: false,
      };
    }
    
    // 500 服务器错误
    if (err.status && err.status >= 500) {
      return {
        type: 'server',
        message: '服务器繁忙，请稍后再试',
        details: err.message,
        retry: true,
      };
    }
  }

  // 默认未知错误
  return {
    type: 'unknown',
    message: '发生未知错误，请重试',
    retry: true,
  };
}

/**
 * 获取用户友好的错误消息
 */
export function getUserFriendlyMessage(error: unknown): string {
  return wrapError(error).message;
}

/**
 * 检查错误是否可重试
 */
export function isRetryable(error: unknown): boolean {
  return wrapError(error).retry ?? false;
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd web
npx tsc --noEmit lib/error.ts
```

- [ ] **Step 3: 提交**

```bash
git add web/lib/error.ts
git commit -m "feat: add error handling utilities

- AppError interface for typed errors
- wrapError: convert any error to friendly AppError
- getUserFriendlyMessage: extract user-friendly text
- isRetryable: check if error supports retry

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Skeleton 组件

**Files:**
- Create: `web/components/ui/skeleton.tsx`
- Create: `web/components/skeletons/reports-skeleton.tsx`
- Test: 视觉检查

**Interfaces:**
- Produces: `Skeleton` base component
- Produces: `ReportsSkeleton` preset
- Produces: `ReportDetailSkeleton` preset

- [ ] **Step 1: 创建基础 Skeleton 组件**

```typescript
// web/components/ui/skeleton.tsx
import { cn } from "@/lib/utils";

/**
 * 基础骨架屏组件
 * 使用 animate-pulse 实现闪烁效果
 */
interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-gray-200",
        className
      )}
    />
  );
}
```

- [ ] **Step 2: 创建 Reports 列表骨架屏**

```typescript
// web/components/skeletons/reports-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 报表列表骨架屏
 * 与实际报表列表布局一致
 */
export function ReportsSkeleton() {
  return (
    <div className="space-y-6">
      {/* 标题 */}
      <Skeleton className="h-8 w-48" />
      
      {/* 报表卡片列表 */}
      <div className="grid gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-3">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <div className="flex gap-4 pt-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 创建报表详情骨架屏**

```typescript
// web/components/skeletons/report-detail-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 报表详情骨架屏
 */
export function ReportDetailSkeleton() {
  return (
    <div className="space-y-6">
      {/* 标题和返回按钮 */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-1/2" />
      </div>
      
      {/* 描述 */}
      <Skeleton className="h-4 w-3/4" />
      
      {/* 指标卡片 */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      
      {/* 图表区域 */}
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
```

- [ ] **Step 4: TypeScript 检查**

```bash
cd web
npx tsc --noEmit components/ui/skeleton.tsx components/skeletons/*.tsx
```

- [ ] **Step 5: 提交**

```bash
git add web/components/ui/skeleton.tsx web/components/skeletons/
git commit -m "feat(ui): add skeleton loading components

- Skeleton base component with animate-pulse
- ReportsSkeleton: list layout placeholder
- ReportDetailSkeleton: detail layout placeholder

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 全局 Error Boundary

**Files:**
- Create: `web/app/error.tsx`

**Interfaces:**
- Consumes: `getUserFriendlyMessage()` from Task 1
- Consumes: `isRetryable()` from Task 1

- [ ] **Step 1: 创建全局错误边界**

```typescript
// web/app/error.tsx
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getUserFriendlyMessage, isRetryable } from "@/lib/error";

/**
 * 全局错误边界
 * 捕获所有路由级别的错误
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 错误日志上报（生产环境可接入 Sentry）
    console.error("Global error:", error);
  }, [error]);

  const message = getUserFriendlyMessage(error);
  const canRetry = isRetryable(error);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md w-full text-center space-y-6">
        {/* 错误图标 */}
        <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        {/* 错误信息 */}
        <div className="space-y-2">
          <h1 className="text-xl font-bold text-gray-900">页面加载失败</h1>
          <p className="text-gray-600">{message}</p>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3 justify-center">
          {canRetry && (
            <Button onClick={reset} variant="default">
              重试
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/">返回首页</Link>
          </Button>
        </div>

        {/* 调试信息（仅开发环境） */}
        {process.env.NODE_ENV === "development" && (
          <div className="mt-6 p-4 bg-gray-100 rounded text-left">
            <p className="text-xs text-gray-500 font-mono break-all">
              {error.message}
            </p>
            {error.digest && (
              <p className="text-xs text-gray-400 mt-1">
                Digest: {error.digest}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/error.tsx
```

- [ ] **Step 3: 提交**

```bash
git add web/app/error.tsx
git commit -m "feat: add global error boundary

- Catch all route-level errors
- Display user-friendly error messages
- Provide retry and home navigation
- Show debug info in development

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Loading 骨架屏

**Files:**
- Create: `web/app/loading.tsx`
- Create: `web/app/reports/loading.tsx`
- Create: `web/app/reports/[id]/loading.tsx`

**Interfaces:**
- Consumes: `ReportsSkeleton` from Task 2
- Consumes: `ReportDetailSkeleton` from Task 2

- [ ] **Step 1: 创建全局 loading**

```typescript
// web/app/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

/**
 * 全局 Loading 骨架屏
 * 匹配所有路由的默认 loading
 */
export default function GlobalLoading() {
  return (
    <div className="min-h-screen p-6 space-y-6">
      {/* Header 骨架 */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
      
      {/* 内容区域 */}
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 创建报表列表 loading**

```typescript
// web/app/reports/loading.tsx
import { ReportsSkeleton } from "@/components/skeletons/reports-skeleton";
import { Header } from "@/components/layout/header";

/**
 * 报表列表 Loading
 */
export default function ReportsLoading() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto p-6">
        <ReportsSkeleton />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: 创建报表详情 loading**

```typescript
// web/app/reports/[id]/loading.tsx
import { ReportDetailSkeleton } from "@/components/skeletons/report-detail-skeleton";
import { Header } from "@/components/layout/header";

/**
 * 报表详情 Loading
 */
export default function ReportDetailLoading() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto p-6">
        <ReportDetailSkeleton />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/loading.tsx app/reports/loading.tsx "app/reports/[id]/loading.tsx"
```

- [ ] **Step 5: 提交**

```bash
git add web/app/loading.tsx web/app/reports/loading.tsx "web/app/reports/[id]/loading.tsx"
git commit -m "feat: add loading skeletons for Suspense

- Global loading fallback
- Reports list loading with skeleton
- Report detail loading with skeleton

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: API 层错误处理

**Files:**
- Modify: `web/lib/api.ts`

**Interfaces:**
- Consumes: `wrapError()` from Task 1
- Produces: wrapped API functions with error handling

- [ ] **Step 1: 添加错误处理到 API 函数**

```typescript
// web/lib/api.ts
// 在现有代码基础上添加错误处理

import { wrapError, AppError } from "./error";

// 修改 getReports，添加错误包装
export async function getReports(): Promise<Report[]> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("reports")
      .select("id,name,description,updated_at,metrics");
    
    if (error) throw error;
    
    return (data as ReportRow[]).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      updatedAt: formatTime(r.updated_at),
      metrics: r.metrics ?? [],
    }));
  } catch (err) {
    // 记录原始错误
    console.error("getReports failed:", err);
    // 转换为友好错误抛出
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}

// 类似修改 getReport 和 getSources
export async function getReport(id: string): Promise<Report | null> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("reports")
      .select("id,name,description,updated_at,metrics")
      .eq("id", id)
      .single();
    
    if (error || !data) return null;
    
    const r = data as ReportRow;
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      updatedAt: formatTime(r.updated_at),
      metrics: r.metrics ?? [],
    };
  } catch (err) {
    console.error("getReport failed:", err);
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}

export async function getSources(): Promise<DataSource[]> {
  try {
    const insforge = await getClient();
    const { data, error } = await insforge.database
      .from("data_sources")
      .select("id,name,description,api_endpoint,auth_type,schedule,enabled,last_sync,row_count");
    
    if (error) throw error;
    
    return (data as SourceRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description ?? undefined,
      apiEndpoint: s.api_endpoint,
      authType: s.auth_type,
      schedule: s.schedule,
      enabled: s.enabled,
      lastSync: s.last_sync ? formatTime(s.last_sync) : undefined,
      rowCount: s.row_count ?? undefined,
    }));
  } catch (err) {
    console.error("getSources failed:", err);
    const appError = wrapError(err);
    throw new Error(appError.message);
  }
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd web
npx tsc --noEmit lib/api.ts
```

- [ ] **Step 3: 提交**

```bash
git add web/lib/api.ts
git commit -m "feat(api): add error handling to data fetching

- Wrap all API calls with try/catch
- Convert errors to user-friendly messages
- Log original errors for debugging

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收标准

| 序号 | 测试场景 | 预期结果 |
|-----|---------|---------|
| 1 | 网络断开访问 /reports | 显示错误边界 + 重试按钮 |
| 2 | 快速访问 /reports | 先显示骨架屏 → 渐显数据 |
| 3 | API 返回 500 | 显示友好错误（不暴露堆栈）|
| 4 | 访问 /reports/invalid-id | 显示 404 错误信息 |
| 5 | 点击重试 | 重新加载数据 |

---

## Self-Review

- [x] Spec 覆盖：所有需求点都有对应任务
- [x] 无 Placeholder：所有代码完整，无 TBD
- [x] 类型一致性：AppError 贯穿所有任务
- [x] 依赖顺序：Task 1 (error utils) → Task 2 (skeletons) → Task 3-5 (pages)

---

**计划完成，直接执行。**