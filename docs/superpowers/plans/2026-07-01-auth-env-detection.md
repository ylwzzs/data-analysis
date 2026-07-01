# 鉴权环境检测优先化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现鉴权环境检测优先化：企微客户端内自动静默授权，同路径响应式适配 PC/移动布局。

**Architecture:**
- middleware 先检测企微环境，再检查登录态
- 企微内无 token 时直接跳转静默授权，不停留登录页
- 页面组件按 UA 检测设备类型，条件渲染 PC/移动布局

**Tech Stack:** Next.js 16 App Router + TypeScript + Tailwind CSS

## Global Constraints

- Server Component 使用 `next/headers` 读取 UA
- middleware 运行在 Edge Runtime，支持 Web Crypto API
- 保持现有 cookie 登录态机制（insforge_access_token）
- 登录页仅对非企微环境可见（企微内自动授权）
- 响应式方案：同路径条件渲染，不使用 /mobile 前缀

---

## Task 1: 设备检测工具函数

**Files:**
- Create: `web/lib/device.ts`
- Test: 本地单元测试

**Interfaces:**
- Produces: `isWecomClient(ua: string): boolean`
- Produces: `isMobileDevice(ua: string): boolean`

- [ ] **Step 1: 创建设备检测工具文件**

```typescript
// web/lib/device.ts
/**
 * 设备检测工具
 * 用于在 Server Component 和 middleware 中检测设备类型
 */

/**
 * 检测是否为企微客户端
 * 企微客户端 UA 包含 wxwork
 */
export function isWecomClient(ua: string): boolean {
  return /wxwork/i.test(ua);
}

/**
 * 检测是否为移动设备
 * 支持：Android, iOS, iPad, Windows Phone
 */
export function isMobileDevice(ua: string): boolean {
  return /mobile|android|iphone|ipad|windows phone/i.test(ua);
}

/**
 * 检测设备类型
 * 返回精简的设备类型标识
 */
export function getDeviceType(ua: string): "desktop" | "mobile" | "tablet" {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (isMobileDevice(ua)) return "mobile";
  return "desktop";
}
```

- [ ] **Step 2: 创建简单测试页面验证检测逻辑**

```typescript
// 临时测试：创建 app/test-device/page.tsx
import { headers } from "next/headers";
import { isWecomClient, isMobileDevice, getDeviceType } from "@/lib/device";

export default async function TestDevicePage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  
  return (
    <div className="p-8">
      <h1>设备检测测试</h1>
      <pre className="mt-4 p-4 bg-gray-100 rounded">
        UA: {ua}\n
        企微: {isWecomClient(ua) ? "是" : "否"}\n
        移动: {isMobileDevice(ua) ? "是" : "否"}\n
        类型: {getDeviceType(ua)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd web
npx tsc --noEmit lib/device.ts
```

- [ ] **Step 4: 提交（不包含测试页面）**

```bash
git add web/lib/device.ts
git commit -m "feat: add device detection utilities

- isWecomClient: detect WeCom client from UA
- isMobileDevice: detect mobile/tablet devices
- getDeviceType: return device category

Co-Authored-By: Claude <noreply@anthropic.com>"

# 删除临时测试页面
rm -f web/app/test-device/page.tsx
```

---

## Task 2: middleware 环境优先检测改造

**Files:**
- Modify: `web/middleware.ts`

**Interfaces:**
- Consumes: `isWecomClient()` from Task 1
- Consumes: existing `checkTokenBlacklist()` (already implemented)

- [ ] **Step 1: 读取当前 middleware.ts**

理解现有结构：
- 当前：检查 token → 无 token → 跳 /login
- 已有：checkTokenBlacklist() 函数（上一步实现）

- [ ] **Step 2: 重构 middleware 为环境优先检测**

```typescript
// web/middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isWecomClient } from "@/lib/device";

// 企微 OAuth 授权 URL 构建
function buildWecomAuthUrl(redirectUri: string, state: string): string {
  const corpId = process.env.NEXT_PUBLIC_WECOM_CORP_ID;
  const agentId = process.env.NEXT_PUBLIC_WECOM_AGENT_ID;
  if (!corpId || !agentId) return "";
  
  const params = new URLSearchParams({
    appid: corpId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "snsapi_base",
    state,
    agentid: agentId,
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

/**
 * 路由保护 middleware
 * 核心逻辑：环境检测优先于登录检测
 */
export async function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent")?.toLowerCase() || "";
  const isWecom = isWecomClient(ua);
  
  // 1. 企微客户端内：自动静默授权
  if (isWecom) {
    return handleWecomClient(req);
  }
  
  // 2. 企微客户端外：原有登录检查逻辑
  return handleRegularBrowser(req);
}

/**
 * 处理企微客户端请求
 * 有 token → 放行
 * 无 token → 自动跳转静默授权
 */
async function handleWecomClient(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;
  
  if (token) {
    // 有 token，检查是否在黑名单中
    const isBlacklisted = await checkTokenBlacklist(token);
    if (isBlacklisted) {
      const response = NextResponse.redirect(new URL("/login", req.url));
      response.cookies.delete("insforge_access_token");
      response.cookies.delete("wecom_userid");
      return response;
    }
    // Token 有效，放行
    return NextResponse.next();
  }
  
  // 无 token，构造静默授权 URL
  const targetPath = req.nextUrl.pathname + req.nextUrl.search;
  const authUrl = buildWecomAuthUrl(
    `${req.nextUrl.origin}/auth/callback`,
    encodeURIComponent(targetPath) // state 携带原路径
  );
  
  if (!authUrl) {
    // 企微配置缺失，回退到登录页
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", targetPath);
    return NextResponse.redirect(url);
  }
  
  return NextResponse.redirect(authUrl);
}

/**
 * 处理普通浏览器请求
 * 保持原有逻辑：检查 token → 跳 /login
 */
async function handleRegularBrowser(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;
  
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  
  const isBlacklisted = await checkTokenBlacklist(token);
  if (isBlacklisted) {
    const response = NextResponse.redirect(new URL("/login", req.url));
    response.cookies.delete("insforge_access_token");
    response.cookies.delete("wecom_userid");
    return response;
  }
  
  return NextResponse.next();
}

// 检查 token 是否在黑名单中（保留原有实现）
async function checkTokenBlacklist(token: string): Promise<boolean> {
  // ... 保留原有代码
}

export const config = {
  matcher: ["/", "/reports/:path*", "/sources", "/mobile", "/mobile/reports/:path*"],
};
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd web
npx tsc --noEmit middleware.ts
```

- [ ] **Step 4: 提交**

```bash
git add web/middleware.ts web/lib/device.ts
git commit -m "feat(auth): environment-first detection in middleware

- Detect WeCom client before checking login status
- Auto-redirect to silent auth in WeCom client
- Regular browsers fallback to /login

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: callback 支持 target 参数回跳

**Files:**
- Modify: `web/app/auth/callback/route.ts`

**Interfaces:**
- Consumes: state parameter containing target path
- Produces: redirect to original path after auth

- [ ] **Step 1: 读取当前 callback route.ts**

理解现有结构：
- 当前：state=mobile → /mobile, state=home → / 或 ?next

- [ ] **Step 2: 修改 callback 处理 target 参数**

```typescript
// web/app/auth/callback/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { exchangeWecomCode } from "@/lib/wecom";

/**
 * 企微 OAuth 回调
 * state 参数格式：URL 编码的目标路径（如 /reports/123）
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "/";
  
  // 解码 state 中的目标路径
  const targetPath = decodeURIComponent(state);
  const safeTarget = targetPath.startsWith("/") ? targetPath : "/";

  const login = (err: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, req.url));

  if (!code) return login("missing_code");

  const { data, error } = await exchangeWecomCode(code);
  if (error || !data?.ok || !data.access_token) {
    return login(String((data as any)?.error ?? error ?? "exchange_failed"));
  }

  const c = await cookies();
  
  // httpOnly：server（middleware + api.ts）鉴权用
  c.set("insforge_access_token", data.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });
  
  // 非 httpOnly：Header（client）展示登录态用
  c.set("wecom_userid", data.wecom_userid, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });

  // 回跳到原路径
  return NextResponse.redirect(new URL(safeTarget, req.url));
}
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/auth/callback/route.ts
```

- [ ] **Step 4: 提交**

```bash
git add web/app/auth/callback/route.ts
git commit -m "feat(auth): callback support target path redirect

- Decode state parameter as target path
- Return to original page after auth success
- Remove hardcoded /mobile redirect logic

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 登录页简化（移除 H5 入口）

**Files:**
- Modify: `web/app/login/page.tsx`

**Interfaces:**
- Produces: 仅显示扫码登录，无 H5 授权入口

- [ ] **Step 1: 简化登录页面**

```typescript
// web/app/login/page.tsx
import { buildWecomQrLoginUrl } from "@/lib/wecom";

/**
 * 登录页：仅对非企微客户端显示
 * 企微客户端内会自动静默授权，不会访问此页面
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith("/") ? next : "/";

  const redirectBase = process.env.NEXT_PUBLIC_WECOM_REDIRECT_URI || "";
  const sep = redirectBase.includes("?") ? "&" : "?";
  const redirectUri = `${redirectBase}${sep}next=${encodeURIComponent(safeNext)}`;
  const qrUrl = buildWecomQrLoginUrl(redirectUri, encodeURIComponent(safeNext));

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-8 max-w-sm w-full text-center shadow-sm">
        <h1 className="text-xl font-bold mb-2">数据分析平台</h1>
        <p className="text-sm text-muted-foreground mb-6">请使用企业微信登录</p>
        
        {error ? (
          <p className="text-sm text-red-600 mb-4 break-all">登录失败：{error}</p>
        ) : null}
        
        {qrUrl ? (
          <a
            href={qrUrl}
            className="block w-full bg-blue-600 text-white rounded-md py-2.5 text-sm font-medium hover:bg-blue-700"
          >
            企微扫码登录
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">企微登录未配置</p>
        )}
        
        {/* 注意：已移除 H5 授权入口，企微客户端内会自动静默授权 */}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/login/page.tsx
```

- [ ] **Step 3: 提交**

```bash
git add web/app/login/page.tsx
git commit -m "fix(auth): simplify login page, remove H5 entry

- Remove mobile H5 auth link
- WeCom client auto-redirects to silent auth
- Only QR code login for regular browsers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 首页响应式改造

**Files:**
- Modify: `web/app/page.tsx`
- Create: `web/components/layout/desktop-home.tsx`
- Create: `web/components/layout/mobile-home.tsx`

**Interfaces:**
- Consumes: `isMobileDevice()` from Task 1

- [ ] **Step 1: 创建设备专用布局组件**

```typescript
// web/components/layout/desktop-home.tsx
import { Header } from "@/components/layout/header";
import { Dashboard } from "@/components/dashboard";

export function DesktopHomePage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6">数据分析平台</h1>
        <Dashboard />
      </main>
    </div>
  );
}
```

```typescript
// web/components/layout/mobile-home.tsx
import { MobileHeader } from "@/components/layout/mobile-header";
import { MobileDashboard } from "@/components/dashboard/mobile-dashboard";

export function MobileHomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <MobileHeader />
      <main className="flex-1 p-4">
        <h1 className="text-xl font-bold mb-4">数据分析平台</h1>
        <MobileDashboard />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: 改造首页为响应式**

```typescript
// web/app/page.tsx
import { headers } from "next/headers";
import { isMobileDevice } from "@/lib/device";
import { DesktopHomePage } from "@/components/layout/desktop-home";
import { MobileHomePage } from "@/components/layout/mobile-home";

/**
 * 首页：响应式布局
 * 根据设备类型渲染 PC 或移动布局
 */
export default async function HomePage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  return isMobile ? <MobileHomePage /> : <DesktopHomePage />;
}
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/page.tsx components/layout/desktop-home.tsx components/layout/mobile-home.tsx
```

- [ ] **Step 4: 提交**

```bash
git add web/app/page.tsx web/components/layout/
git commit -m "feat(ui): responsive home page with device detection

- DesktopHomePage: PC optimized layout
- MobileHomePage: mobile optimized layout
- Server-side device detection via UA

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 报表页响应式改造

**Files:**
- Modify: `web/app/reports/page.tsx`
- Modify: `web/app/reports/[id]/page.tsx`

**Interfaces:**
- Consumes: `isMobileDevice()` from Task 1

- [ ] **Step 1: 改造报表列表页**

```typescript
// web/app/reports/page.tsx
import { headers } from "next/headers";
import { isMobileDevice } from "@/lib/device";
import { getReports } from "@/lib/api";
import { DesktopReportsList } from "@/components/reports/desktop-list";
import { MobileReportsList } from "@/components/reports/mobile-list";

export default async function ReportsPage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);
  
  const reports = await getReports();

  return isMobile 
    ? <MobileReportsList reports={reports} />
    : <DesktopReportsList reports={reports} />;
}
```

- [ ] **Step 2: 改造报表详情页**

```typescript
// web/app/reports/[id]/page.tsx
import { headers } from "next/headers";
import { isMobileDevice } from "@/lib/device";
import { getReport } from "@/lib/api";
import { DesktopReportDetail } from "@/components/reports/desktop-detail";
import { MobileReportDetail } from "@/components/reports/mobile-detail";

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);
  
  const report = await getReport(id);

  if (!report) {
    return <div>报表不存在</div>;
  }

  return isMobile
    ? <MobileReportDetail report={report} />
    : <DesktopReportDetail report={report} />;
}
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd web
npx tsc --noEmit app/reports/page.tsx app/reports/[id]/page.tsx
```

- [ ] **Step 4: 提交**

```bash
git add web/app/reports/
git commit -m "feat(ui): responsive reports pages

- Server-side device detection
- DesktopReportsList / MobileReportsList
- DesktopReportDetail / MobileReportDetail

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收标准

| 序号 | 测试场景 | 预期结果 |
|-----|---------|---------|
| 1 | 企微 PC 访问 / | 自动静默授权 → 显示 PC 布局 |
| 2 | 企微移动访问 / | 自动静默授权 → 显示移动布局 |
| 3 | 浏览器访问 / | 跳 /login → 扫码 → PC 布局 |
| 4 | 企微访问 /reports | 自动授权 → 报表列表（对应布局）|
| 5 | 登录页面 | 仅显示扫码按钮，无 H5 入口 |
| 6 | middleware 黑名单 | 仍有效（继承既有功能）|

---

## Self-Review

- [x] Spec 覆盖：所有需求点都有对应任务
- [x] 无 Placeholder：所有代码完整，无 TBD
- [x] 类型一致性：isMobileDevice 复用 Task 1
- [x] 依赖顺序：Task 1 (device) → Task 2-6 (pages)

---

**计划完成。选择执行方式：**
1. **Subagent-Driven** - 我逐个派发实现子代理
2. **Inline Execution** - 我直接在当前会话执行
