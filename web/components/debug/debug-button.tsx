"use client";

import { useState } from "react";
import { Bug } from "lucide-react";

import { Button } from "@/components/ui/button";

interface DebugInfo {
  deviceFromHeader: string | null;
  deviceFromCookie: string | null;
  isMobile: boolean;
  ua: string;
}

/**
 * 浮动调试按钮
 * 点击显示设备检测结果（仅开发/调试时使用）
 */
export function DebugButton({ info }: { info: DebugInfo }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 浮动按钮 */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-4 right-4 z-[9999] bg-blue-600 text-white rounded-full p-3 shadow-lg hover:bg-blue-700"
        aria-label="调试信息"
      >
        <Bug className="w-5 h-5" />
      </button>

      {/* 调试面板 */}
      {open && (
        <div className="fixed inset-0 z-[9998] bg-black/50 flex items-end justify-center p-4">
          <div className="bg-white rounded-t-lg w-full max-w-md p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg">设备调试信息</h3>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                关闭
              </Button>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">最终判定:</span>
                <span className={`px-2 py-1 rounded font-bold ${info.isMobile ? "bg-green-100 text-green-800" : "bg-gray-200"}`}>
                  {info.isMobile ? "移动端 ✓" : "PC 端"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">middleware:</span>
                <span className={`px-2 py-1 rounded ${info.deviceFromHeader === "mobile" ? "bg-green-100 text-green-800" : "bg-gray-100"}`}>
                  {info.deviceFromHeader || "无"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-gray-500 w-24">cookie:</span>
                <span className={`px-2 py-1 rounded ${info.deviceFromCookie === "mobile" ? "bg-green-100 text-green-800" : "bg-gray-100"}`}>
                  {info.deviceFromCookie || "无"}
                </span>
              </div>
            </div>

            <div className="bg-gray-100 rounded p-2">
              <p className="text-xs text-gray-500 mb-1">UA 摘要:</p>
              <p className="text-xs break-all">{info.ua.slice(0, 100)}...</p>
            </div>

            <div className="flex gap-2">
              <a href="/clear-cache" className="flex-1">
                <Button variant="outline" className="w-full">
                  清除 Cookie
                </Button>
              </a>
              <a href="/debug" className="flex-1">
                <Button variant="outline" className="w-full">
                  详细调试页
                </Button>
              </a>
            </div>

            <p className="text-xs text-gray-400 text-center">
              如果 cookie 显示 desktop，访问 /clear-cache 清除后重试
            </p>
          </div>
        </div>
      )}
    </>
  );
}