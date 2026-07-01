import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { buildWecomAuthUrl, buildWecomQrLoginUrl } from "@/lib/wecom";

// 登录页：未登录访客的入口（middleware 把受保护页面的未登录请求重定向到这）。
// 按客户端类型分流：
//   · 企微客户端内（UA 含 wxwork/MicroMessenger）→ 直接静默 H5 snsapi_base 授权
//     （企微内不弹确认，无感登录），不停在登录页让用户点。
//   · 普通浏览器（PC）→ 渲染扫码登录页。
// redirect_uri 带 next，登录后回原页。
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
  const qrUrl = buildWecomQrLoginUrl(redirectUri, "home");
  const h5Url = buildWecomAuthUrl(redirectUri, "mobile");

  const ua = ((await headers()).get("user-agent") || "").toLowerCase();
  const isWecomClient = /wxwork|micromessenger/.test(ua);

  // 企微客户端内 + 无 error：直接跳 H5 静默授权。
  // error 时不自动跳，避免「回调失败 → /login → 再跳授权」死循环（落到下面渲染重试入口）。
  if (!error && isWecomClient && h5Url) {
    redirect(h5Url);
  }

  // 主入口：企微客户端（仅 error 到这）用 H5 重试；普通浏览器用扫码。
  const primaryUrl = isWecomClient ? h5Url : qrUrl;
  const primaryLabel = isWecomClient ? "重新登录" : "企微扫码登录";

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-8 max-w-sm w-full text-center shadow-sm">
        <h1 className="text-xl font-bold mb-2">数据分析平台</h1>
        <p className="text-sm text-muted-foreground mb-6">请使用企业微信登录</p>
        {error ? (
          <p className="text-sm text-red-600 mb-4 break-all">登录失败：{error}</p>
        ) : null}
        {primaryUrl ? (
          <a
            href={primaryUrl}
            className="block w-full bg-blue-600 text-white rounded-md py-2.5 text-sm font-medium hover:bg-blue-700"
          >
            {primaryLabel}
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">企微登录未配置</p>
        )}
        {/* 普通浏览器（PC）额外给一个手机企微内打开的入口 */}
        {!isWecomClient && h5Url ? (
          <a href={h5Url} className="block mt-3 text-xs text-blue-600">
            手机企微内打开 →
          </a>
        ) : null}
      </div>
    </div>
  );
}
