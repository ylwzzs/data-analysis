import { NextResponse } from "next/server";
import { cookies } from "next/headers";

// 退出登录：将当前 token 加入黑名单 + 清除 cookie
export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("insforge_access_token")?.value;

    if (token) {
      // 将 token 加入黑名单
      await blacklistToken(token);
    }

    // 清除 cookies
    cookieStore.delete("insforge_access_token");
    cookieStore.delete("wecom_userid");
    cookieStore.delete("wecom_name");

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Logout error:", e);
    return NextResponse.json({ ok: true }); // 即使出错也返回成功，确保前端能继续
  }
}

// 将 token 加入黑名单
async function blacklistToken(token: string) {
  try {
    // 解码 JWT 获取过期时间
    const payload = decodeJwt(token);
    if (!payload?.exp) return;

    // 计算 token 哈希
    const tokenPrefix = token.slice(0, 100);
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenPrefix));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    // 写入黑名单
    const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL || "http://localhost:7130";
    const response = await fetch(`${baseUrl}/rest/v1/token_blacklist`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        token_hash: tokenHash,
        user_id: payload.sub,
        expires_at: new Date(payload.exp * 1000).toISOString(),
        reason: "logout",
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Blacklist write failed:", response.status, errorText);
      // Continue logout but log error
    }
  } catch (e) {
    console.error("Blacklist token failed:", e);
  }
}

// 简单 JWT 解码（不验证签名，只读 payload）
function decodeJwt(token: string): { sub?: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload;
  } catch {
    return null;
  }
}