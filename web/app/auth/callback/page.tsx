import Link from "next/link";

import { exchangeWecomCode } from "@/lib/wecom";
import { WecomLoginSuccess } from "./login-success";

// 企微 OAuth 回调页：?code=xxx
// server 侧用 code 调 wecom-oauth function 换 userid，client 子组件存登录态。
export default async function AuthCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string }>;
}) {
  const { code, state } = await searchParams;

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

  if (error || !data?.ok) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg p-6 max-w-sm">
          <h1 className="text-lg font-semibold mb-3">企微登录</h1>
          <div className="text-sm text-red-600 whitespace-pre-wrap">
            登录失败：{String((error as any)?.message ?? data?.error ?? error)}
          </div>
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

  return <WecomLoginSuccess userid={data.wecom_userid} state={state} />;
}
