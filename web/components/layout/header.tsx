"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildWecomQrLoginUrl } from "@/lib/wecom";

// 扫码 URL：NEXT_PUBLIC_* 在 build 时内联，SSR 即可算出（不依赖 client 的 location）。
const LOGIN_URL = buildWecomQrLoginUrl(
  process.env.NEXT_PUBLIC_WECOM_REDIRECT_URI || "",
);

export function Header() {
  // userid 走 localStorage（仅 client），SSR 为 null → 首屏先显示登录按钮，挂载后切换。
  const [userid, setUserid] = useState<string | null>(null);
  useEffect(() => {
    setUserid(localStorage.getItem("wecom_userid"));
  }, []);

  return (
    <header className="border-b bg-white">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold">数据分析平台</h1>
          <Badge variant="secondary">Beta</Badge>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm">
            设置
          </Button>
          {userid ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{userid}</span>
              <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
                {userid[0]?.toUpperCase()}
              </div>
            </div>
          ) : LOGIN_URL ? (
            <a href={LOGIN_URL}>
              <Button size="sm">企微扫码登录</Button>
            </a>
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200" />
          )}
        </div>
      </div>
    </header>
  );
}
