import { ReportsSkeleton } from "@/components/skeletons/reports-skeleton";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * 报表列表 Loading
 */
export default function ReportsLoading() {
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
          <ReportsSkeleton />
        </main>
      </div>
    </div>
  );
}
