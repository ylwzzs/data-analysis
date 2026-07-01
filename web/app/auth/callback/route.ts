import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { exchangeWecomCode } from "@/lib/wecom";

// 企微 OAuth 回调（Route Handler，可写 cookie）：?code=&state=&next=
// code → wecom-oauth function 换 userid + access_token → 写两个 cookie → 回 next。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "home";
  const next = url.searchParams.get("next") || "/";
  // H5 授权（state=mobile）回 /mobile；PC 扫码（state=home）回 next
  const target = state === "mobile" ? "/mobile" : next;

  // 用 X-Forwarded-Host / Host 头构造外部 origin，避免 Next.js 把 req.url 解析成
  // 容器内监听地址（0.0.0.0:3000）导致 redirect 的 Location 跳到内网而打不开。
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  const origin = `${proto}://${host}`;

  const login = (err: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, origin));

  if (!code) return login("missing_code");

  const { data, error } = await exchangeWecomCode(code);
  if (error || !data?.ok || !data.access_token) {
    return login(String((data as any)?.error ?? error ?? "exchange_failed"));
  }

  const c = await cookies();
  // httpOnly：server（middleware + api.ts）鉴权用，client 读不到
  c.set("insforge_access_token", data.access_token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });
  // 非 httpOnly：Header（client）展示登录态用
  c.set("wecom_userid", data.wecom_userid, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  });

  return NextResponse.redirect(new URL(target, origin));
}
