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
 * 有 token → 直接放行（企微环境可信，不做黑名单检查）
 * 无 token → 自动跳转静默授权
 */
async function handleWecomClient(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;

  if (token) {
    // 企微环境可信，有 token 直接放行
    // 黑名单检查只在普通浏览器环境进行
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

  // 使用 307 临时重定向
  return NextResponse.redirect(authUrl, 307);
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
    response.cookies.delete("wecom_name");
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
        // 添加超时和重试策略
        signal: AbortSignal.timeout(3000),
      }
    );

    if (!response.ok) {
      // 查询失败但不抛异常，放行（fail-open，避免误杀）
      console.error("Blacklist query failed:", response.status);
      return false;
    }

    const data = await response.json();
    return data.length > 0;
  } catch (e) {
    // 查询失败时放行（fail-open），避免因网络问题导致用户被登出
    // 真正的黑名单 token 会在 PostgREST 层面拒绝请求
    console.error("Blacklist check failed:", e);
    return false;
  }
}

export const config = {
  matcher: ["/", "/reports/:path*", "/sources", "/mobile", "/mobile/reports/:path*"],
};
