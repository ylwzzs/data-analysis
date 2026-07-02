import { notFound } from "next/navigation";
import { headers, cookies } from "next/headers";

import { DesktopReportDetail } from "@/components/reports/desktop-detail";
import { MobileReportDetail } from "@/components/reports/mobile-detail";
import { getReport } from "@/lib/api";
import { isMobileDevice } from "@/lib/device";

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: PageProps) {
  const { id } = await params;
  const report = await getReport(id);

  if (!report) {
    notFound();
  }

  // 设备类型检测：只读取 middleware 注入的 header（最可靠）
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");

  let isMobile = deviceFromHeader === "mobile";

  // 如果 header 不存在（首次访问或非 middleware 覆盖的路由），fallback 到 cookie + UA
  if (!deviceFromHeader) {
    const cookiesList = await cookies();
    const deviceFromCookie = cookiesList.get("device_type")?.value;
    const ua = headersList.get("user-agent") || "";
    isMobile = deviceFromCookie === "mobile" || isMobileDevice(ua);
  }

  return isMobile ? (
    <MobileReportDetail report={report} />
  ) : (
    <DesktopReportDetail report={report} />
  );
}
