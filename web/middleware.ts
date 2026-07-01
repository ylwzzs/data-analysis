import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 路由保护：未登录或 token 被吊销 → 跳 /login?next=原路径。
// matcher 只拦报表相关页面；/login、/auth/callback、/api、/functions、静态资源不拦。
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