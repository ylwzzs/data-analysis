import { headers } from "next/headers";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { DesktopReportsList } from "@/components/reports/desktop-list";
import { MobileReportsList } from "@/components/reports/mobile-list";
import { getReports } from "@/lib/api";
import { isMobileDevice } from "@/lib/device";

export default async function ReportsPage() {
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isMobile = isMobileDevice(ua);

  const reports = await getReports();

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">报表中心</h2>
            <p className="text-muted-foreground">查看所有可访问的报表</p>
          </div>
          {isMobile ? (
            <MobileReportsList reports={reports} />
          ) : (
            <DesktopReportsList reports={reports} />
          )}
        </main>
      </div>
    </div>
  );
}