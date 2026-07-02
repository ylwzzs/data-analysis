import { getReports } from "@/lib/api";
import { getDeviceType } from "@/lib/get-device-type";
import { DesktopHomePage } from "@/components/layout/desktop-home";
import { MobileHomePage } from "@/components/layout/mobile-home";

/**
 * 首页：响应式布局
 * 根据设备类型渲染 PC 或移动布局
 * 设备类型由 middleware 检测并写入 cookie
 */
export default async function HomePage() {
  const deviceType = await getDeviceType();
  const reports = await getReports();

  return deviceType === "mobile" ? (
    <MobileHomePage reports={reports} />
  ) : (
    <DesktopHomePage reports={reports} />
  );
}
