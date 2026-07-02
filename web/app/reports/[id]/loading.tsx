import { ReportDetailSkeleton } from "@/components/skeletons/report-detail-skeleton";

/**
 * 报表详情 Loading
 * 使用简洁布局，避免设备切换时闪烁
 */
export default function ReportDetailLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}
