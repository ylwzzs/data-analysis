// web/app/error.tsx
"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getUserFriendlyMessage, isRetryable } from "@/lib/error";

/**
 * 全局错误边界
 * 捕获所有路由级别的错误
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 错误日志上报（生产环境可接入 Sentry）
    console.error("Global error:", error);
  }, [error]);

  const message = getUserFriendlyMessage(error);
  const canRetry = isRetryable(error);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="max-w-md w-full text-center space-y-6">
        {/* 错误图标 */}
        <div className="w-16 h-16 mx-auto rounded-full bg-red-100 flex items-center justify-center">
          <svg
            className="w-8 h-8 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        {/* 错误信息 */}
        <div className="space-y-2">
          <h1 className="text-xl font-bold text-gray-900">页面加载失败</h1>
          <p className="text-gray-600">{message}</p>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3 justify-center">
          {canRetry && (
            <Button onClick={reset} variant="default">
              重试
            </Button>
          )}
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-lg border border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50 h-8 gap-1.5 px-2.5 text-sm font-medium"
          >
            返回首页
          </Link>
        </div>

        {/* 调试信息（仅开发环境） */}
        {process.env.NODE_ENV === "development" && (
          <div className="mt-6 p-4 bg-gray-100 rounded text-left">
            <p className="text-xs text-gray-500 font-mono break-all">
              {error.message}
            </p>
            {error.digest && (
              <p className="text-xs text-gray-400 mt-1">
                Digest: {error.digest}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
