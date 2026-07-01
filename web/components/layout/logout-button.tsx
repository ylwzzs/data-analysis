"use client";

import { useRouter } from "next/navigation";

// 退出登录：POST /api/auth/logout 清 cookie → 跳 /login（受保护页会被 middleware 拦到 /login）。
export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={logout}
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      退出
    </button>
  );
}
