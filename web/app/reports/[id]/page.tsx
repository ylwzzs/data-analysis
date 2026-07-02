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

  // 设备类型检测（layout 处理布局，这里只决定渲染哪个组件）
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");
  const cookiesList = await cookies();
  const deviceFromCookie = cookiesList.get("device_type")?.value;
  const ua = headersList.get("user-agent") || "";

  const isMobile =
    deviceFromHeader === "mobile" ||
    deviceFromCookie === "mobile" ||
    isMobileDevice(ua);

  return isMobile ? (
    <MobileReportDetail report={report} />
  ) : (
    <DesktopReportDetail report={report} />
  );
}
