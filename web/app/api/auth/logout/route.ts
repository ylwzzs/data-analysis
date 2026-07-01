import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// 退出登录：清两个 cookie，前端随后跳 /login（middleware 会拦截受保护页面）。
export async function POST() {
  const c = await cookies();
  c.delete("insforge_access_token");
  c.delete("wecom_userid");
  return NextResponse.json({ ok: true });
}
