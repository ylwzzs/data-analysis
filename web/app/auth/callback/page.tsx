import Link from "next/link";

import { exchangeWecomCode } from "@/lib/wecom";

// 企微 OAuth 回调页：?code=xxx
// 真实联调待可信回调域名就绪；当前作为框架，展示 code 换取结果。
export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  if (!code) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg p-6 max-w-sm text-center">
          <h1 className="text-lg font-semibold mb-2">缺少授权码</h1>
          <p className="text-sm text-muted-foreground mb-4">
            未收到企业微信回调的 code 参数。
          </p>
          <Link href="/mobile" className="text-sm text-blue-600">
            ← 返回
          </Link>
        </div>
      </div>
    );
  }

  const { data, error } = await exchangeWecomCode(code);

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-6 max-w-sm">
        <h1 className="text-lg font-semibold mb-3">企微登录</h1>
        {error ? (
          <div className="text-sm text-red-600">
            登录失败：{String(error.message ?? error)}
          </div>
        ) : (
          <div className="text-sm space-y-1">
            <p className="text-green-600">✓ 已识别企业微信账号</p>
            <p className="text-muted-foreground">
              userid: {data?.wecom_userid ?? "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              注：会话签发与重定向待回调域名就绪后启用。
            </p>
          </div>
        )}
        <Link
          href="/mobile"
          className="block mt-4 text-center text-sm text-blue-600"
        >
          ← 返回报表中心
        </Link>
      </div>
    </div>
  );
}
