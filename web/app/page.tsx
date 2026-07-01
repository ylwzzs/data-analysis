import { headers } from "next/headers";

import { isMobileDevice } from "@/lib/device";
import { DesktopHomePage } from "@/components/layout/desktop-home";
import { MobileHomePage } from "@/components/layout/mobile-home";
import { getReports } from "@/lib/api";

/**
 * 首页：响应式布局
 * 根据设备类型渲染 PC 或移动布局
 */
export default async function HomePage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  const reports = await getReports();

  return isMobile ? (
    <MobileHomePage reports={reports} />
  ) : (
    <DesktopHomePage reports={reports} />
  );
}
