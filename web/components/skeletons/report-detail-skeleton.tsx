import { Skeleton } from "@/components/ui/skeleton";

/**
 * 报表详情骨架屏
 */
export function ReportDetailSkeleton() {
  return (
    <div className="space-y-6">
      {/* 标题和返回按钮 */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-8 w-1/2" />
      </div>

      {/* 描述 */}
      <Skeleton className="h-4 w-3/4" />

      {/* 指标卡片 */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>

      {/* 图表区域 */}
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
