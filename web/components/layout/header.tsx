import { cookies, headers } from "next/headers";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LogoutButton } from "@/components/layout/logout-button";
import { isWecomClient } from "@/lib/device";

// Header（server component）：在受保护页渲染，此时一定已登录（middleware 已拦截未登录）。
// 读 wecom_name / wecom_userid cookie（非 httpOnly）展示身份 + 退出按钮。
// 企微客户端内隐藏退出按钮（不允许退出）。
export async function Header() {
  const cookiesList = await cookies();
  const name = cookiesList.get("wecom_name")?.value;
  const userid = cookiesList.get("wecom_userid")?.value;
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  const isWecom = isWecomClient(ua);

  // 优先显示姓名，fallback 到 userid
  const displayName = name || userid;

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
          {displayName ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{displayName}</span>
              <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
                {displayName[0]?.toUpperCase()}
              </div>
              {/* 企微客户端内隐藏退出按钮 */}
              {!isWecom && <LogoutButton />}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
