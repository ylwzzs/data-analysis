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
  // 设备检测：先读取所有可能的来源（调试需要）
  const headersList = await headers();
  const cookiesList = await cookies();
  const ua = headersList.get("user-agent") || "";

  const deviceFromHeader = headersList.get("x-device-type");
  const deviceFromCookie = cookiesList.get("device_type")?.value;
  const isMobileByUA = isMobileDevice(ua);

  // 最终判定逻辑
  let isMobile = deviceFromHeader === "mobile";

  if (!deviceFromHeader) {
    isMobile = deviceFromCookie === "mobile" || isMobileByUA;
  }

  // 渲染时间戳（用于追踪闪烁）
  const renderTime = new Date().toISOString().split("T")[1].slice(0, 12);

  // 调试信息（显示所有检测结果）
  const debugInfo = {
    deviceFromHeader,
    deviceFromCookie: deviceFromCookie ?? null,
    isMobile,
    ua: ua.slice(0, 60),
  };

  // 调试面板：显示所有检测来源，不依赖设备检测结果
  const debugPanel = (
    <div className="fixed top-0 left-0 right-0 z-[9999] bg-purple-100 border-b border-purple-500 p-2 text-xs shadow-lg">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-purple-900 bg-purple-300 px-2 py-1 rounded">
          [{renderTime}] {isMobile ? "移动端" : "PC"}
        </span>
        <span className="text-purple-800">header: <b className={deviceFromHeader === "mobile" ? "text-green-600" : "text-red-600"}>{deviceFromHeader || "❌无"}</b></span>
        <span className="text-purple-800">cookie: <b className={deviceFromCookie === "mobile" ? "text-green-600" : "text-red-600"}>{deviceFromCookie || "❌无"}</b></span>
        <span className="text-purple-800">UA检测: <b className={isMobileByUA ? "text-green-600" : "text-red-600"}>{isMobileByUA ? "mobile" : "desktop"}</b></span>
      </div>
    </div>
  );

  // 移动端：全屏布局，无 Sidebar，带调试面板
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        {debugPanel}
        <Header />
        <main className="flex-1 pt-8">{children}</main>
        <DebugButton info={debugInfo} />
      </div>
    );
  }

  // PC 端：带 Sidebar 布局，带调试面板
  return (
    <div className="min-h-screen bg-gray-50">
      {debugPanel}
      <Header />
      <div className="flex pt-8">
        <Sidebar />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <DebugButton info={debugInfo} />
    </div>
  );
}