import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { ReportList } from "@/components/reports/report-list";
import type { Report } from "@/lib/api";

interface DesktopHomePageProps {
  reports: Report[];
}

export function DesktopHomePage({ reports }: DesktopHomePageProps) {
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
          <ReportList reports={reports} />
        </main>
      </div>
    </div>
  );
}
