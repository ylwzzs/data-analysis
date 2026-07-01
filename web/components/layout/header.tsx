import { cookies } from "next/headers";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/layout/logout-button";

// Header（server component）：在受保护页渲染，此时一定已登录（middleware 已拦截未登录）。
// 读 wecom_userid cookie（非 httpOnly）展示身份 + 退出按钮。
export async function Header() {
  const userid = (await cookies()).get("wecom_userid")?.value;

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
              <LogoutButton />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
