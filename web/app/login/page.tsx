import { buildWecomAuthUrl, buildWecomQrLoginUrl } from "@/lib/wecom";

// 登录页：未登录访客的入口（middleware 把受保护页面的未登录请求重定向到这）。
// PC 扫码 + H5 网页授权两个入口；redirect_uri 带 next，登录后回原页。
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
        {h5Url ? (
          <a href={h5Url} className="block mt-3 text-xs text-blue-600">
            手机企微内打开 →
          </a>
        ) : null}
      </div>
    </div>
  );
}
