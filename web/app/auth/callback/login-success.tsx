"use client";
import { useEffect } from "react";
import Link from "next/link";

// 企微登录成功：把 userid 存 localStorage 作为前端登录态（MVP，无服务端会话）。
// 报表数据本就对 anon 公开，登录仅用于识别访客身份。
export function WecomLoginSuccess({
  userid,
  state,
}: {
  userid?: string;
  state?: string;
}) {
  // state=mobile 来自 H5 授权（回 /mobile），其余（PC 扫码 state=home）回首页 /
  const isMobile = state === "mobile";
  const target = isMobile ? "/mobile" : "/";

  useEffect(() => {
    if (userid) {
      localStorage.setItem("wecom_userid", userid);
    }
  }, [userid]);

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg p-6 max-w-sm">
        <h1 className="text-lg font-semibold mb-3">企微登录</h1>
        <div className="text-sm space-y-1">
          <p className="text-green-600">✓ 登录成功</p>
          <p className="text-muted-foreground">企业微信账号：{userid ?? "—"}</p>
        </div>
        <Link
          href={target}
          className="block mt-4 text-center text-sm text-blue-600"
        >
          → {isMobile ? "进入报表中心" : "进入首页"}
        </Link>
      </div>
    </div>
  );
}
