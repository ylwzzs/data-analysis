import { headers, cookies } from "next/headers";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { isMobileDevice } from "@/lib/device";

/**
 * 报表详情页 layout
 * 根据设备类型决定是否显示 Sidebar
 * 设备类型由 middleware 检测并注入到请求头
 */
export const dynamic = "force-dynamic";

export default async function ReportDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // 设备检测：优先使用 middleware 注入的 header
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");

  // 如果 header 不存在，fallback 到 cookie + UA（首次访问场景）
  let isMobile = deviceFromHeader === "mobile";

  if (!deviceFromHeader) {
    const cookiesList = await cookies();
    const deviceFromCookie = cookiesList.get("device_type")?.value;
    const ua = headersList.get("user-agent") || "";
    isMobile = deviceFromCookie === "mobile" || isMobileDevice(ua);
  }

  // 移动端：全屏布局，无 Sidebar
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1">{children}</main>
      </div>
    );
  }

  // PC 端：带 Sidebar 布局
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}