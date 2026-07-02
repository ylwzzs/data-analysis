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

  // 渲染时间戳（用于追踪闪烁）
  const renderTime = new Date().toISOString().split("T")[1].slice(0, 12);

  // 移动端：全屏布局，无 Sidebar，带调试面板
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* 固定调试面板 - 显示每次渲染状态 */}
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-yellow-100 border-b border-yellow-300 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold text-yellow-800">[{renderTime}] 移动端布局</span>
            <span>header: {deviceFromHeader || "无"}</span>
            <span>cookie: {debugInfo.deviceFromCookie || "无"}</span>
            <span className="truncate max-w-[200px]">UA: {debugInfo.ua.slice(0, 50)}...</span>
          </div>
        </div>
        <Header />
        <main className="flex-1 pt-8">{children}</main>
        <DebugButton info={debugInfo} />
      </div>
    );
  }

  // PC 端：带 Sidebar 布局，带调试面板
  return (
    <div className="min-h-screen bg-gray-50">
      {/* 固定调试面板 - 显示每次渲染状态 */}
      <div className="fixed top-0 left-0 right-0 z-[9999] bg-red-100 border-b border-red-300 p-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-bold text-red-800">[{renderTime}] PC 端布局</span>
          <span>header: {deviceFromHeader || "无"}</span>
          <span>cookie: {debugInfo.deviceFromCookie || "无"}</span>
          <span className="truncate max-w-[200px]">UA: {debugInfo.ua.slice(0, 50)}...</span>
        </div>
      </div>
      <Header />
      <div className="flex pt-8">
        <Sidebar />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <DebugButton info={debugInfo} />
    </div>
  );
}