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
