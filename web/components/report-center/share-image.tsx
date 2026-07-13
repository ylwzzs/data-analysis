"use client";

import { Share2 } from "lucide-react";

import { exportImage } from "./chart-actions";

// 移动分享图：点击时 html2canvas 截 targetRef 指向的卡片区域，下载 png。
// 企微内无法直接调 share API 分享图片到会话，先下载由用户手动转发（DESIGN L71）。
// html2canvas 动态 import 已封装在 exportImage 内（避免进主 bundle）。
export function ShareButton({
  targetRef,
  filename,
}: {
  targetRef: React.RefObject<HTMLElement | null>;
  filename: string;
}) {
  const onShare = async () => {
    if (!targetRef.current) return;
    await exportImage(targetRef.current, filename);
  };

  return (
    <button
      onClick={onShare}
      className="flex items-center gap-1 text-xs text-blue-600"
      title="生成分享图"
    >
      <Share2 size={14} strokeWidth={1.5} />
      <span>生成分享图</span>
    </button>
  );
}
