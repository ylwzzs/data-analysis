import { ReportDetailSkeleton } from "@/components/skeletons/report-detail-skeleton";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";

/**
 * 报表详情 Loading
 */
export default function ReportDetailLoading() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <ReportDetailSkeleton />
        </main>
      </div>
    </div>
  );
}