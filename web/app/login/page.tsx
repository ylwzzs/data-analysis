import { headers } from "next/headers";

import { buildWecomQrLoginUrl, buildWecomAuthUrl } from "@/lib/wecom";
import { isMobileDevice } from "@/lib/device";

/**
 * 登录页：根据设备类型显示不同的授权方式
 * - PC端：显示企微扫码登录
 * - 移动端：显示H5授权入口（或自动跳转）
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith("/") ? next : "/";
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  const redirectBase = process.env.NEXT_PUBLIC_WECOM_REDIRECT_URI || "";
  const sep = redirectBase.includes("?") ? "&" : "?";
  const redirectUri = `${redirectBase}${sep}next=${encodeURIComponent(safeNext)}`;
  const qrUrl = buildWecomQrLoginUrl(redirectUri, encodeURIComponent(safeNext));
  const h5Url = buildWecomAuthUrl(redirectUri, encodeURIComponent(safeNext));

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-8 max-w-sm w-full text-center shadow-sm">
        <h1 className="text-xl font-bold mb-2">数据分析平台</h1>
        <p className="text-sm text-muted-foreground mb-6">请使用企业微信登录</p>

        {error ? (
          <p className="text-sm text-red-600 mb-4 break-all">登录失败：{error}</p>
        ) : null}

        {isMobile ? (
          // 移动端：显示H5授权入口
          h5Url ? (
            <div className="space-y-4">
              <a
                href={h5Url}
                className="block w-full bg-blue-600 text-white rounded-md py-3 text-sm font-medium hover:bg-blue-700"
              >
                企微授权登录
              </a>
              <p className="text-xs text-muted-foreground">
                点击后将跳转到企业微信进行授权
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">企微登录未配置</p>
          )
        ) : (
          // PC端：显示扫码登录
          qrUrl ? (
            <div className="space-y-4">
              <a
                href={qrUrl}
                className="block w-full bg-blue-600 text-white rounded-md py-2.5 text-sm font-medium hover:bg-blue-700"
              >
                企微扫码登录
              </a>
              <p className="text-xs text-muted-foreground">
                点击后将跳转到企业微信扫码页面
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">企微登录未配置</p>
          )
        )}
      </div>
    </div>
  );
}
