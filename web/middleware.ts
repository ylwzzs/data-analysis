import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 路由保护：未登录（无 insforge_access_token cookie）→ 跳 /login?next=原路径。
// matcher 只拦报表相关页面；/login、/auth/callback、/api、/functions、静态资源不拦。
export function middleware(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;
  if (token) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/", "/reports/:path*", "/sources", "/mobile", "/mobile/reports/:path*"],
};
