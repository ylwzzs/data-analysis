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
 * 支持：Android, iOS, iPad, Windows Phone, 企微移动端
 */
export function isMobileDevice(ua: string): boolean {
  // 标准移动设备检测
  if (/mobile|android|iphone|ipad|windows phone/i.test(ua)) {
    return true;
  }

  // 企微移动端：UA 包含 wxwork 且 UA 长度较短或包含移动特征
  // 企微 PC 端 UA 通常更长，包含 Windows/Mac 等桌面标识
  if (/wxwork/i.test(ua) && !/windows|macintosh|desktop/i.test(ua)) {
    return true;
  }

  return false;
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