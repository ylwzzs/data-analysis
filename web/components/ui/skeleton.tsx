import { cn } from "@/lib/utils";

/**
 * 基础骨架屏组件
 * 使用 animate-pulse 实现闪烁效果
 */
interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-gray-200",
        className
      )}
    />
  );
}
