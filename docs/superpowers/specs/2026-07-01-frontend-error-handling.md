# 前端错误处理 + Suspense 设计文档

**日期**: 2026-07-01  
**背景**: 当前页面 API 错误未捕获导致崩溃，缺少 loading 状态影响体验  
**方案**: Error Boundary + Suspense + Skeleton 占位符

---

## 1. 问题陈述

### 1.1 现状问题

```
用户访问页面
    │
    ▼
Server Component fetch() 抛错
    │
    ▼
Next.js 默认错误页（500 Internal Server Error）
    │
    ▼
用户看到空白/错误页面，无法操作
```

**具体问题**:
1. `lib/api.ts` 的 `getReports()` 抛错未捕获 → 页面 500
2. 无 loading 状态 → 白屏等待数据
3. 无错误重试 → 必须刷新页面
4. 错误信息暴露技术细节（不安全）

### 1.2 目标

- 错误 graceful degradation（优雅降级）
- Loading 状态视觉反馈
- 用户可重试/回退
- 错误信息用户友好（不暴露实现）

---

## 2. 设计方案

### 2.1 Error Boundary（错误边界）

**全局错误处理**:
```
app/
├── error.tsx          # 全局错误边界（捕获所有路由错误）
├── reports/
│   ├── error.tsx      # 报表路由专用错误处理
│   └── page.tsx
```

**设计要点**:
- 显示友好错误信息（"加载失败，请重试"）
- 提供重试按钮（`reset()`）
- 提供返回首页链接
- 不暴露技术细节（错误日志只输出 console）

### 2.2 Suspense + Loading

**路由级别 loading**:
```
app/
├── loading.tsx        # 全局 loading（匹配所有路由）
├── reports/
│   ├── loading.tsx    # 报表列表 loading
│   ├── page.tsx
│   └── [id]/
│       ├── loading.tsx  # 报表详情 loading
│       └── page.tsx
```

**Skeleton 占位符设计**:
- 与最终布局结构一致
- 灰色占位块（`bg-gray-200 animate-pulse`）
- 渐进显示：骨架 → 数据

### 2.3 API 错误处理策略

**分层处理**:
```
┌─────────────────────────────────────┐
│  1. lib/api.ts（数据层）             │
│     - 捕获原始错误                   │
│     - 转换为友好错误对象             │
│     - 日志记录                       │
├─────────────────────────────────────┤
│  2. page.tsx（页面层）               │
│     - try/catch 包裹                 │
│     - 错误边界兜底                   │
│     - 错误状态管理                   │
├─────────────────────────────────────┤
│  3. error.tsx（错误边界）            │
│     - 捕获未处理错误                 │
│     - 显示友好界面                   │
│     - 提供恢复机制                   │
└─────────────────────────────────────┘
```

### 2.4 错误类型定义

```typescript
// 友好错误类型
interface AppError {
  type: 'network' | 'auth' | 'not_found' | 'server' | 'unknown';
  message: string;      // 用户友好的消息
  details?: string;     // 开发者详情（仅开发环境显示）
  retry?: boolean;      // 是否可重试
}
```

---

## 3. 文件改动清单

| 文件 | 改动 | 说明 |
|-----|------|-----|
| `web/app/error.tsx` | 新建 | 全局错误边界 |
| `web/app/loading.tsx` | 新建 | 全局 loading 骨架屏 |
| `web/app/reports/error.tsx` | 新建 | 报表路由错误处理 |
| `web/app/reports/loading.tsx` | 新建 | 报表列表骨架屏 |
| `web/app/reports/[id]/error.tsx` | 新建 | 报表详情错误处理 |
| `web/app/reports/[id]/loading.tsx` | 新建 | 报表详情骨架屏 |
| `web/lib/error.ts` | 新建 | 错误处理工具函数 |
| `web/components/ui/skeleton.tsx` | 新建/复用 | 骨架屏组件 |
| `web/components/error-fallback.tsx` | 新建 | 错误回退 UI 组件 |
| `web/lib/api.ts` | 修改 | 添加错误包装 |

---

## 4. 组件设计

### 4.1 ErrorFallback 组件

```tsx
// components/error-fallback.tsx
export function ErrorFallback({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="text-center">
        <h1 className="text-xl font-bold mb-2">页面加载失败</h1>
        <p className="text-muted-foreground mb-4">
          {getUserFriendlyMessage(error)}
        </p>
        <div className="flex gap-2 justify-center">
          <button onClick={reset}>重试</button>
          <Link href="/">返回首页</Link>
        </div>
      </div>
    </div>
  );
}
```

### 4.2 Skeleton 组件

```tsx
// components/ui/skeleton.tsx
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-gray-200 ${className}`} />
  );
}

// 预设骨架屏布局
export function ReportsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-1/3" />
      <div className="grid gap-4">
        {[1,2,3].map(i => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}
```

### 4.3 API 错误包装

```typescript
// lib/error.ts
export function wrapError(error: unknown): AppError {
  if (error && typeof error === 'object') {
    // 网络错误
    if ('code' in error && error.code === 'ECONNREFUSED') {
      return {
        type: 'network',
        message: '网络连接失败，请检查网络',
        retry: true,
      };
    }
    // 401 未授权
    if ('status' in error && error.status === 401) {
      return {
        type: 'auth',
        message: '登录已过期，请重新登录',
        retry: false,
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
```

---

## 5. 验收标准

| 序号 | 测试场景 | 预期结果 |
|-----|---------|---------|
| 1 | 网络断开访问 /reports | 显示错误页面 + 重试按钮 |
| 2 | API 返回 500 | 显示友好错误（不暴露堆栈）|
| 3 | 正常加载 /reports | 先显示骨架屏 → 渐显数据 |
| 4 | 点击重试 | 重新加载数据 |
| 5 | 报表详情加载 | 骨架屏与最终布局结构一致 |
| 6 | 移动端错误 | 响应式错误页面 |

---

## 6. 技术约束

- Server Component 使用 `error.tsx` 捕获错误
- Client Component 使用 `<ErrorBoundary>` 捕获
- Loading 使用 Next.js `loading.tsx` 约定
- Skeleton 使用 Tailwind CSS `animate-pulse`
- 错误日志只输出 console，不暴露给用户

---

**设计确认**: 用户已确认本设计方案 ✓  
**下一步**: 进入 writing-plans 阶段，制定详细实现计划
