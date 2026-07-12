import { NextResponse, NextRequest } from "next/server";
import { isWecomClient, isMobileDevice } from "@/lib/device";

// 管理员白名单（企微用户 ID）
const ADMIN_USERIDS = new Set([
  "ZhangDuo",      // 张铎
  "YangWei",       // 杨玮
  // 添加更多管理员...
]);

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

export async function middleware(req: NextRequest) {
  const ua = req.headers.get("user-agent")?.toLowerCase() || "";
  const isWecom = isWecomClient(ua);

  const deviceTypeCookie = req.cookies.get("device_type")?.value;
  const isMobile = deviceTypeCookie === "mobile" ||
    (!deviceTypeCookie && isMobileDevice(ua));

  const newHeaders = new Headers(req.headers);
  newHeaders.set("x-device-type", isMobile ? "mobile" : "desktop");

  const newReq = new NextRequest(req.url, {
    headers: newHeaders,
    method: req.method,
    body: req.body,
  });

  let response: NextResponse;

  if (isWecom) {
    response = await handleWecomClient(newReq);
  } else {
    response = await handleRegularBrowser(newReq);
  }

  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");

  if (!deviceTypeCookie) {
    response.cookies.set("device_type", isMobile ? "mobile" : "desktop", {
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 86400,
    });
  }

  return response;
}

async function handleWecomClient(req: NextRequest) {
  const token = req.cookies.get("insforge_access_token")?.value;

  if (token) {
    // 检查 admin 路径权限
    if (req.nextUrl.pathname.startsWith("/admin")) {
      const wecomId = req.cookies.get("wecom_userid")?.value;
      if (!wecomId || !ADMIN_USERIDS.has(wecomId)) {
        return NextResponse.redirect(new URL("/?error=admin_required", req.url));
      }
    }
    return NextResponse.next({ request: req });
  }

  const targetPath = req.nextUrl.pathname + req.nextUrl.search;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;

  const authUrl = buildWecomAuthUrl(
    `${origin}/auth/callback`,
    encodeURIComponent(targetPath)
  );

  if (!authUrl) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", targetPath);
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(authUrl, 307);
}

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

  // 检查 admin 路径权限
  if (req.nextUrl.pathname.startsWith("/admin")) {
    const wecomId = req.cookies.get("wecom_userid")?.value;
    if (!wecomId || !ADMIN_USERIDS.has(wecomId)) {
      return NextResponse.redirect(new URL("/?error=admin_required", req.url));
    }
  }

  return NextResponse.next({ request: req });
}

async function checkTokenBlacklist(token: string): Promise<boolean> {
  try {
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";
    const response = await fetch(
      `${baseUrl}/rest/v1/token_blacklist?token_hash=eq.${tokenHash}&select=id`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      }
    );

    if (!response.ok) {
      console.error("Blacklist query failed:", response.status);
      return false;
    }

    const data = await response.json();
    return data.length > 0;
  } catch (e) {
    console.error("Blacklist check failed:", e);
    return false;
  }
}

export const config = {
  matcher: [
    "/",
    "/reports/:path*",
    "/mobile",
    "/mobile/reports/:path*",
    "/admin/:path*"  // 新增这一行
  ],
};
