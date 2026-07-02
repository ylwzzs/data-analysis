import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { DesktopReportDetail } from "@/components/reports/desktop-detail";
import { MobileReportDetail } from "@/components/reports/mobile-detail";
import { getReport } from "@/lib/api";
import { isMobileDevice } from "@/lib/device";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ReportPage({ params }: PageProps) {
  const { id } = await params;
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  const report = await getReport(id);

  if (!report) {
    notFound();
  }

  // 移动端：全屏布局，无 Sidebar
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1">
          <MobileReportDetail report={report} />
        </main>
      </div>
    );
  }

  // PC 端：带 Sidebar 布局
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <DesktopReportDetail report={report} />
        </main>
      </div>
    </div>
  );
}