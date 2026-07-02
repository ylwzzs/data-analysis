import { headers, cookies } from "next/headers";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
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
  // 优先读取 middleware 注入的请求头
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");

  // 其次读取 cookie
  const cookiesList = await cookies();
  const deviceFromCookie = cookiesList.get("device_type")?.value;

  // 最后 fallback 到 UA 检测
  const ua = headersList.get("user-agent") || "";

  const isMobile =
    deviceFromHeader === "mobile" ||
    deviceFromCookie === "mobile" ||
    isMobileDevice(ua);

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