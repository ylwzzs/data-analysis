/**
 * 报表详情 Loading
 * 显示加载状态 + 设备检测结果（调试）
 * 注意：loading.tsx 是 Suspense fallback，在 layout 的 main 区域内显示
 * 它无法访问 headers/cookies（client component），所以只显示 spinner
 */
export default function ReportDetailLoading() {
  return (
    <div className="flex items-center justify-center h-[60vh]">
      {/* 调试：显示 loading 状态 */}
      <div className="text-center space-y-2">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
        <p className="text-xs text-gray-500">数据加载中...</p>
        <p className="text-xs text-red-500 font-bold">[loading.tsx 渲染]</p>
      </div>
    </div>
  );
}
