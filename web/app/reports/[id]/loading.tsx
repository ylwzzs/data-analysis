/**
 * 报表详情 Loading
 * 简洁的加载状态，避免布局闪烁
 */
export default function ReportDetailLoading() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  );
}
