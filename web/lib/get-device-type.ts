// web/lib/get-device-type.ts
/**
 * 获取设备类型（从 cookie）
 * 优先读取 middleware 写入的 device_type cookie
 * 如果没有则 fallback 到 UA 检测
 */
import { cookies, headers } from "next/headers";
import { isMobileDevice } from "./device";

export async function getDeviceType(): Promise<"mobile" | "desktop"> {
  const cookiesList = await cookies();
  const deviceType = cookiesList.get("device_type")?.value;

  if (deviceType === "mobile") return "mobile";
  if (deviceType === "desktop") return "desktop";

  // Fallback: 没有 cookie 时检测 UA
  const headersList = await headers();
  const ua = headersList.get("user-agent") || "";
  return isMobileDevice(ua) ? "mobile" : "desktop";
}