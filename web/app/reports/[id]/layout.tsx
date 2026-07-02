import { headers, cookies } from "next/headers";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { DebugButton } from "@/components/debug/debug-button";
import { isMobileDevice } from "@/lib/device";

/**
 * 报表详情页 layout
 * 根据设备类型决定是否显示 Sidebar
 */
export const dynamic = "force-dynamic";

export default async function ReportDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 只读取 middleware 注入的请求头（最可靠，避免闪烁）
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");

  // 如果 header 不存在，才 fallback 到 cookie + UA（首次访问场景）
  let isMobile = deviceFromHeader === "mobile";

  if (!deviceFromHeader) {
    const cookiesList = await cookies();
    const deviceFromCookie = cookiesList.get("device_type")?.value;
    const ua = headersList.get("user-agent") || "";
    isMobile = deviceFromCookie === "mobile" || isMobileDevice(ua);
  }

  // 调试信息（开发时使用）
  const debugInfo = {
    deviceFromHeader,
    deviceFromCookie: deviceFromHeader ? null : (await cookies()).get("device_type")?.value ?? null,
    isMobile,
    ua: headersList.get("user-agent") || "",
  };

  // 移动端：全屏布局，无 Sidebar，带调试按钮
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1">{children}</main>
        <DebugButton info={debugInfo} />
      </div>
    );
  }

  // PC 端：带 Sidebar 布局，带调试按钮
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <DebugButton info={debugInfo} />
    </div>
  );
}