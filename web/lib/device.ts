// web/lib/device.ts
/**
 * 设备检测工具
 * 用于在 Server Component 和 middleware 中检测设备类型
 */

/**
 * 检测是否为企微客户端
 * 企微客户端 UA 包含 wxwork
 */
export function isWecomClient(ua: string): boolean {
  return /wxwork/i.test(ua);
}

/**
 * 检测是否为移动设备
 * 支持：Android, iOS, iPad, Windows Phone
 */
export function isMobileDevice(ua: string): boolean {
  return /mobile|android|iphone|ipad|windows phone/i.test(ua);
}

/**
 * 检测设备类型
 * 返回精简的设备类型标识
 */
export function getDeviceType(ua: string): "desktop" | "mobile" | "tablet" {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (isMobileDevice(ua)) return "mobile";
  return "desktop";
}
