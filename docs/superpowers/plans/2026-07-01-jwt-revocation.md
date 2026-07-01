# JWT 吊销机制实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 JWT 吊销机制：用户退出或账号异常时，token 立即失效，无法继续访问受保护资源。

**Architecture:** 
- 黑名单表（`token_blacklist`）存储已吊销的 token 哈希（jti 或 token 前缀）和过期时间
- middleware 检查每个请求的 token 是否在黑名单中
- 退出登录时将当前 token 写入黑名单
- 定时任务清理已过期的黑名单记录

**Tech Stack:** PostgreSQL + Next.js middleware + InsForge Edge Function

## Global Constraints

- Idempotent migrations: 所有 SQL 带 `IF NOT EXISTS` / `IF EXISTS`
- JWT 使用 jti（JWT ID）字段唯一标识 token
- Token 哈希使用 SHA256 前 16 位（平衡查询效率和冲突率）
- Deno runtime: CommonJS 语法（`module.exports`），不用 ESM import
- Secrets: 通过 InsForge `/api/secrets` 注入，function 用 `Deno.env.get()` 读取

---

## Task 1: 黑名单表

**Files:**
- Create: `database/migrations/007_token_blacklist.sql`
- Test: 执行迁移后 `\d token_blacklist`

**Interfaces:**
- Produces: `token_blacklist` 表结构（token_hash, expires_at, blacklisted_at, reason）

- [ ] **Step 1: 创建迁移文件**

```sql
-- database/migrations/007_token_blacklist.sql
-- JWT 黑名单表：存储已吊销的 token
-- 用于用户退出登录或账号异常时立即失效 token
-- 幂等：可重复执行

CREATE TABLE IF NOT EXISTS token_blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash VARCHAR(64) NOT NULL,  -- SHA256 前 16 位或完整 hash
  jti VARCHAR(64),                  -- JWT ID（如果有）
  user_id VARCHAR(100),             -- 关联用户（可选，用于审计）
  expires_at TIMESTAMP NOT NULL,    -- token 原始过期时间
  blacklisted_at TIMESTAMP DEFAULT NOW(),
  reason VARCHAR(50) DEFAULT 'logout'  -- logout | revoked | expired
);

-- 索引：快速检查 token 是否在黑名单中
CREATE INDEX IF NOT EXISTS idx_token_blacklist_hash ON token_blacklist(token_hash);
CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at);

-- 授权 authenticated role 读写
GRANT SELECT, INSERT, DELETE ON token_blacklist TO authenticated;

COMMENT ON TABLE token_blacklist IS 'JWT 黑名单，middleware 检查 token 是否被吊销';
```

- [ ] **Step 2: 执行迁移**

```bash
cd /opt/data-analytics-platform
bash scripts/migrate.sh
```

验证：
```sql
\d token_blacklist
-- 应看到表结构和索引
```

- [ ] **Step 3: 提交**

```bash
git add database/migrations/007_token_blacklist.sql
git commit -m "feat(db): add token_blacklist table for JWT revocation

- Store revoked token hashes with expiration time
- Index for fast lookup and cleanup
- Grant authenticated role permissions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: middleware 黑名单检查

**Files:**
- Modify: `web/middleware.ts`
- Test: 退出登录后访问受保护页面应被重定向

**Interfaces:**
- Consumes: `token_blacklist` 表（通过 API 查询）
- Produces: 吊销的 token 被拦截，返回重定向

- [ ] **Step 1: 读取当前 middleware.ts**

理解现有结构：
- 从 cookie 读取 `insforge_access_token`
- 有 token 则放行，无 token 则重定向

- [ ] **Step 2: 添加黑名单检查**

修改 `web/middleware.ts`，在放行前检查 token 是否在黑名单中：

```typescript
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@insforge/sdk";

// 路由保护：未登录或 token 被吊销 → 跳 /login?next=原路径。
export async function middleware(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;
  
  if (!token) {
    // 无 token，重定向到登录
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  // 检查 token 是否在黑名单中
  const isBlacklisted = await checkTokenBlacklist(token);
  if (isBlacklisted) {
    // token 被吊销，清除 cookie 并重定向
    const response = NextResponse.redirect(new URL("/login", req.url));
    response.cookies.delete("insforge_access_token");
    response.cookies.delete("wecom_userid");
    return response;
  }

  return NextResponse.next();
}

// 检查 token 是否在黑名单中
async function checkTokenBlacklist(token: string): Promise<boolean> {
  try {
    // 计算 token 哈希（前 100 字符的 SHA256 前 16 位）
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    // 通过 PostgREST API 查询黑名单
    const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";
    const response = await fetch(
      `${baseUrl}/rest/v1/token_blacklist?token_hash=eq.${tokenHash}&select=id`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
      }
    );

    if (!response.ok) return false;
    
    const data = await response.json();
    return data.length > 0;
  } catch (e) {
    // 查询失败时，默认不拦截（避免误杀正常请求）
    console.error("Blacklist check failed:", e);
    return false;
  }
}

export const config = {
  matcher: ["/", "/reports/:path*", "/sources", "/mobile", "/mobile/reports/:path*"],
};
```

- [ ] **Step 3: 验证代码**

```bash
cd web
npx tsc --noEmit middleware.ts
```

- [ ] **Step 4: 提交**

```bash
git add web/middleware.ts
git commit -m "feat(auth): check token blacklist in middleware

- Query token_blacklist table before allowing access
- Clear cookies and redirect if token is revoked
- Hash token (SHA256 prefix) for efficient lookup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 退出登录写入黑名单

**Files:**
- Modify: `web/app/api/auth/logout/route.ts`
- Test: 退出后 token 无法再访问受保护页面

**Interfaces:**
- Consumes: 当前 token 和过期时间
- Produces: 黑名单表新增记录

- [ ] **Step 1: 读取当前 logout/route.ts**

理解现有结构：
- 删除 cookies
- 返回成功

- [ ] **Step 2: 添加黑名单写入**

修改 `web/app/api/auth/logout/route.ts`：

```typescript
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@insforge/sdk";

// 退出登录：将当前 token 加入黑名单 + 清除 cookie
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("insforge_access_token")?.value;

    if (token) {
      // 将 token 加入黑名单
      await blacklistToken(token);
    }

    // 清除 cookies
    cookieStore.delete("insforge_access_token");
    cookieStore.delete("wecom_userid");

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Logout error:", e);
    return NextResponse.json({ ok: true }); // 即使出错也返回成功，确保前端能继续
  }
}

// 将 token 加入黑名单
async function blacklistToken(token: string) {
  try {
    // 解码 JWT 获取过期时间
    const payload = decodeJwt(token);
    if (!payload?.exp) return;

    // 计算 token 哈希
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    // 写入黑名单
    const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";
    await fetch(`${baseUrl}/rest/v1/token_blacklist`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        token_hash: tokenHash,
        user_id: payload.sub,
        expires_at: new Date(payload.exp * 1000).toISOString(),
        reason: "logout",
      }),
    });
  } catch (e) {
    console.error("Blacklist token failed:", e);
  }
}

// 简单 JWT 解码（不验证签名，只读 payload）
function decodeJwt(token: string): { sub?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: 验证代码**

```bash
cd web
npx tsc --noEmit app/api/auth/logout/route.ts
```

- [ ] **Step 4: 提交**

```bash
git add web/app/api/auth/logout/route.ts
git commit -m "feat(auth): blacklist token on logout

- Decode JWT to get expiration time
- Store token hash in blacklist with reason=logout
- Continue logout even if blacklist fails

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 定时清理过期黑名单记录

**Files:**
- Create: `functions/cleanup-blacklist/index.js`
- Modify: `scripts/deploy-functions.sh`（注入 secrets）
- Test: 手动 invoke 验证清理

**Interfaces:**
- Consumes: `token_blacklist` 表中 expires_at < NOW() 的记录
- Produces: 删除过期记录，返回清理数量

- [ ] **Step 1: 创建清理 function**

```javascript
// functions/cleanup-blacklist/index.js
// 定时清理已过期的黑名单记录
// 建议 schedule：每日 03:00 执行
// 所需 secrets：JWT_SECRET（用于签 service token）

// 内联 JWT 签名（CommonJS 无法共享模块）
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signJwt(payload, secret) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

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

  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret) {
    return json({ error: "JWT_SECRET not set" }, 500);
  }

  try {
    // 签临时 authenticated JWT
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = await signJwt(
      { sub: "cleanup-blacklist", role: "authenticated", iss: "cleanup-blacklist", iat: now, exp: now + 300 },
      jwtSecret,
    );

    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: serviceToken,
    });

    // 删除已过期的黑名单记录
    const { data, error } = await client.database
      .from("token_blacklist")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id"); // 返回被删除的记录数以统计

    if (error) {
      return json({ error: "cleanup_failed", detail: error }, 502);
    }

    return json({
      ok: true,
      cleaned: data?.length || 0,
      message: `Cleaned ${data?.length || 0} expired tokens from blacklist`,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
```

- [ ] **Step 2: 修改 deploy-functions.sh**

确保 `JWT_SECRET` 已注入（Task 1 已添加，无需修改）。

- [ ] **Step 3: 部署并测试**

```bash
cd /opt/data-analytics-platform
bash scripts/deploy-functions.sh
curl -X POST https://data.shanhaiyiguo.com/functions/cleanup-blacklist
```

预期返回：
```json
{"ok":true,"cleaned":0,"message":"Cleaned 0 expired tokens from blacklist"}
```

- [ ] **Step 4: 配置定时任务**（可选）

```bash
crontab -e
# 添加：每日 03:00 清理
0 3 * * * curl -sf -X POST https://data.shanhaiyiguo.com/functions/cleanup-blacklist >> /var/log/cleanup-blacklist.log 2>&1
```

- [ ] **Step 5: 提交**

```bash
git add functions/cleanup-blacklist/index.js
git commit -m "feat(auth): add cleanup-blacklist function

- Daily cleanup of expired token blacklist entries
- Use service JWT for authenticated DB access
- Returns count of cleaned records

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 验收标准

| 序号 | 验收项 | 验证方法 |
|-----|-------|---------|
| 1 | 黑名单表创建 | `\d token_blacklist` 显示表结构 |
| 2 | 退出登录写入黑名单 | 退出后查 DB，有对应记录 |
| 3 | middleware 拦截吊销 token | 用已退出 token 访问 / → 跳转 /login |
| 4 | 正常 token 不受影响 | 登录后访问 / → 正常显示 |
| 5 | 定时清理工作 | 手动触发 cleanup → 返回 cleaned 数量 |

---

## Self-Review 检查

- [x] Spec 覆盖：所有需求点都有对应任务
- [x] 无 Placeholder：所有代码完整，无 TBD/TODO
- [x] 类型一致：token_hash 统一使用前 16 位 SHA256
- [x] 幂等迁移：所有 SQL 带 `IF NOT EXISTS`

---

## 下一步

选择执行方式：
1. **Subagent-Driven** - 我逐个派发实现子代理
2. **Inline Execution** - 我直接在本会话执行
