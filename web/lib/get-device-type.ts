// web/lib/get-device-type.ts
/**
 * 获取设备类型
 * 优先级：
 * 1. middleware 注入的请求头 x-device-type
 * 2. cookie 中的 device_type
 * 3. UA 检测 fallback
 */
import { cookies, headers } from "next/headers";
import { isMobileDevice } from "./device";

export async function getDeviceType(): Promise<"mobile" | "desktop"> {
  // 优先读取 middleware 注入的请求头
  const headersList = await headers();
  const deviceFromHeader = headersList.get("x-device-type");
  if (deviceFromHeader === "mobile" || deviceFromHeader === "desktop") {
    return deviceFromHeader;
  }

  // 其次读取 cookie
  const cookiesList = await cookies();
  const deviceFromCookie = cookiesList.get("device_type")?.value;
  if (deviceFromCookie === "mobile" || deviceFromCookie === "desktop") {
    return deviceFromCookie;
  }

  // Fallback: UA 检测
  const ua = headersList.get("user-agent") || "";
  return isMobileDevice(ua) ? "mobile" : "desktop";
}
