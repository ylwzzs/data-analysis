"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function Header() {
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
          <div className="w-8 h-8 rounded-full bg-gray-200" />
        </div>
      </div>
    </header>
  );
}
