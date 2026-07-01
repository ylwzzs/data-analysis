# 鉴权环境检测优先化设计文档

**日期**: 2026-07-01  
**背景**: 用户要求改进鉴权流程，实现环境检测优先于登录检测，避免 PC/移动混跳  
**方案**: 同路径响应式 + 环境优先检测

---

## 1. 问题陈述

### 1.1 当前流程问题

```
当前：middleware 检查 token → 无 token → 跳 /login
       /login 页面再检测 UA → 企微内自动授权 / 浏览器显示扫码

问题：
1. 登录页面承担了环境分流职责，容易产生混跳
2. 移动端用户可能看到 PC 扫码页
3. 路径分离（/mobile/*）导致 URL 不统一
```

### 1.2 目标

- 企微客户端内：自动静默授权，无感登录，不停留在登录页
- 按设备类型渲染对应布局（PC/移动），不混跳
- 统一 URL 路径，同路径响应式适配

---

## 2. 设计方案

### 2.1 核心原则

**环境检测优先于登录检测**：middleware 先判断企微环境，再决定是否跳转登录

### 2.2 流程设计

```
用户访问 /reports
    │
    ▼
┌────────────────────────────────────────┐
│ middleware 检测                        │
│ 1. 读取 UA                             │
│ 2. 判断是否企微客户端（wxwork）         │
│ 3. 判断设备类型（PC/Mobile）            │
└────────────────────────────────────────┘
    │
    ├─→ 企微客户端内
    │       │
    │       ├─→ 有 token → 放行 → 页面渲染对应布局
    │       │
    │       └─→ 无 token → 直接跳转 H5 静默授权
    │               → 授权成功回 /reports
    │               → 页面检测设备渲染布局
    │
    └─→ 企微客户端外（浏览器）
            │
            ├─→ 有 token → 放行 → 渲染 PC 布局
            │
            └─→ 无 token → 跳 /login
                    → 仅显示扫码登录
                    → 成功后回 PC 首页
```

### 2.3 响应式布局策略

**同路径响应式**（选定方案）：
- 同一路径（如 `/reports`）服务所有设备
- Server Component 通过 UA 检测设备类型
- 条件渲染：DesktopLayout / MobileLayout

**优点**:
- URL 统一，分享链接无设备差异
- SEO 友好
- 维护成本低
- 用户无感知切换

### 2.4 关键组件设计

#### 2.4.1 设备检测工具

```typescript
// lib/device.ts
export function isWecomClient(ua: string): boolean {
  return /wxwork/i.test(ua);
}

export function isMobileDevice(ua: string): boolean {
  return /mobile|android|iphone|ipad/i.test(ua);
}
```

#### 2.4.2 响应式页面结构

```typescript
// app/page.tsx
export default async function HomePage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);
  
  return isMobile ? <MobileHomePage /> : <DesktopHomePage />;
}
```

#### 2.4.3 middleware 改造

```typescript
// middleware.ts
export async function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent")?.toLowerCase() || "";
  const isWecomClient = /wxwork/.test(ua);
  
  // 1. 企微客户端内：自动静默授权
  if (isWecomClient) {
    const token = req.cookies.get("insforge_access_token")?.value;
    
    if (!token) {
      // 构造授权 URL，保留原路径
      const targetPath = req.nextUrl.pathname + req.nextUrl.search;
      const authUrl = buildWecomAuthUrl(targetPath);
      return NextResponse.redirect(authUrl);
    }
    
    // 有 token，放行（页面自己检测设备渲染布局）
    return NextResponse.next();
  }
  
  // 2. 企微外：原有逻辑（检查 token → 跳 /login）
  return checkAuthAndRedirect(req);
}
```

#### 2.4.4 回调处理

```typescript
// app/auth/callback/route.ts
export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("target") || "/";
  
  // 授权成功，写 cookie
  // ...
  
  // 回跳原路径，页面自己会检测设备渲染对应布局
  return NextResponse.redirect(new URL(target, req.url));
}
```

#### 2.4.5 登录页简化

```typescript
// app/login/page.tsx
export default async function LoginPage() {
  // 仅企微客户端外可见
  // 移除 H5 授权入口
  // 仅显示企微扫码登录
  return (
    <div>
      <h1>请使用企业微信登录</h1>
      <WecomQrLoginButton />
      {/* 无 H5 入口 */}
    </div>
  );
}
```

---

## 3. 文件改动清单

| 文件 | 改动类型 | 说明 |
|-----|---------|------|
| `web/lib/device.ts` | 新建 | 设备检测工具函数 |
| `web/middleware.ts` | 修改 | 环境优先检测逻辑 |
| `web/app/auth/callback/route.ts` | 修改 | 支持 target 参数回跳 |
| `web/app/login/page.tsx` | 修改 | 移除 H5 入口，仅扫码 |
| `web/app/page.tsx` | 修改 | 响应式渲染 PC/移动 |
| `web/app/reports/page.tsx` | 修改 | 响应式渲染 PC/移动 |
| `web/app/reports/[id]/page.tsx` | 修改 | 响应式渲染 PC/移动 |
| `web/app/sources/page.tsx` | 修改 | 响应式渲染 PC/移动 |
| `web/components/layout/desktop-layout.tsx` | 移动/重构 | 现有布局重命名 |
| `web/components/layout/mobile-layout.tsx` | 新建 | 移动端布局组件 |

---

## 4. 验收标准

| 序号 | 场景 | 预期行为 |
|-----|------|---------|
| 1 | 企微 PC 客户端访问 / | 自动静默授权 → 显示 PC 布局首页 |
| 2 | 企微移动客户端访问 / | 自动静默授权 → 显示移动布局首页 |
| 3 | 普通浏览器访问 / | 跳转 /login → 仅显示扫码 → 成功后 PC 布局 |
| 4 | 企微 PC 访问 /reports/123 | 自动授权 → 显示 PC 报表详情 |
| 5 | 企微移动访问 /reports/123 | 自动授权 → 显示移动报表详情 |
| 6 | URL 统一性 | 同一路径在不同设备显示不同布局，无 /mobile 前缀 |
| 7 | 登录页纯净 | 非企微环境看不到 H5 授权入口 |

---

## 5. 技术约束

- **Server Component 检测 UA**: 使用 `next/headers` 读取请求头
- **Edge Runtime**: middleware 运行在 edge，支持 Web Crypto API
- **登录态保持**: 仍使用 httpOnly cookie，7 天过期
- **回退策略**: 设备检测失败时，默认渲染 PC 布局

---

## 6. 风险评估

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| UA 检测不准确 | 移动设备显示 PC 布局 | 使用成熟的检测库 + viewport 回退 |
| 企微环境误判 | 浏览器用户看不到登录入口 | 双重检测（wxwork + MicroMessenger） |
| 授权失败循环 | 自动授权失败 → 重试 → 失败 | 限制重定向次数，错误时显示登录页 |

---

## 7. 后续优化

- 添加 viewport 检测作为 UA 的补充
- 支持用户手动切换 PC/移动视图
- 缓存设备检测结果（cookie 标记）

---

**设计确认**: 用户已确认本设计方案 ✓  
**下一步**: 进入 writing-plans 阶段，制定详细实现计划
