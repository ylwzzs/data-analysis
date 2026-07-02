import { NextResponse } from "next/server";
import { cookies } from "next/headers";

/**
 * 清除缓存并重定向到登录页
 * 用于企微客户端清除登录态
 */
export async function GET() {
  const c = await cookies();

  // 清除所有登录相关的 cookie
  c.delete("insforge_access_token");
  c.delete("wecom_userid");
  c.delete("wecom_name");

  // 重定向到登录页
  return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_INSFORGE_URL || "https://data.shanhaiyiguo.com"));
}
