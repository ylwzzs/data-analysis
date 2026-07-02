import { Skeleton } from "@/components/ui/skeleton";

/**
 * 全局 Loading 骨架屏
 * 匹配所有路由的默认 loading
 */
export default function GlobalLoading() {
  return (
    <div className="min-h-screen bg-gray-50 p-6 space-y-6">
      {/* Header 骨架 */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>

      {/* 内容区域 */}
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
}