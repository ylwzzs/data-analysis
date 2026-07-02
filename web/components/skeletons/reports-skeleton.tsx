import { Skeleton } from "@/components/ui/skeleton";

/**
 * 报表列表骨架屏
 * 与实际报表列表布局一致
 */
export function ReportsSkeleton() {
  return (
    <div className="space-y-6">
      {/* 标题 */}
      <Skeleton className="h-8 w-48" />

      {/* 报表卡片列表 */}
      <div className="grid gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-4 space-y-3">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <div className="flex gap-4 pt-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
