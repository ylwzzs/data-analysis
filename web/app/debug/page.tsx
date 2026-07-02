import { headers, cookies } from "next/headers";
import { isMobileDevice, isWecomClient } from "@/lib/device";

/**
 * 调试页面：显示设备检测结果
 * 用于排查移动端布局闪烁问题
 */
export const dynamic = "force-dynamic";

export default async function DebugPage() {
  const headersList = await headers();
  const cookiesList = await cookies();

  const ua = headersList.get("user-agent") || "";
  const deviceFromHeader = headersList.get("x-device-type");
  const deviceFromCookie = cookiesList.get("device_type")?.value;
  const accessToken = cookiesList.get("insforge_access_token")?.value;
  const wecomUserid = cookiesList.get("wecom_userid")?.value;
  const wecomName = cookiesList.get("wecom_name")?.value;

  const isWecom = isWecomClient(ua);
  const isMobileByUA = isMobileDevice(ua);

  return (
    <div className="min-h-screen bg-gray-50 p-4 space-y-4">
      <h1 className="text-xl font-bold">设备调试面板</h1>

      <div className="bg-white rounded-lg p-4 space-y-2">
        <h2 className="font-semibold text-lg">User-Agent</h2>
        <p className="text-xs break-all bg-gray-100 p-2 rounded">{ua}</p>
        <div className="flex gap-2">
          <span className="px-2 py-1 rounded bg-blue-100 text-blue-800 text-sm">
            企微客户端: {isWecom ? "是" : "否"}
          </span>
          <span className="px-2 py-1 rounded bg-green-100 text-green-800 text-sm">
            UA 检测移动端: {isMobileByUA ? "是" : "否"}
          </span>
        </div>
      </div>

      <div className="bg-white rounded-lg p-4 space-y-2">
        <h2 className="font-semibold text-lg">设备检测结果</h2>
        <div className="space-y-1">
          <p>
            <span className="text-gray-500">middleware header (x-device-type):</span>
            <span className={`ml-2 px-2 py-1 rounded ${deviceFromHeader === "mobile" ? "bg-green-100 text-green-800" : "bg-gray-100"}`}>
              {deviceFromHeader || "未设置"}
            </span>
          </p>
          <p>
            <span className="text-gray-500">cookie (device_type):</span>
            <span className={`ml-2 px-2 py-1 rounded ${deviceFromCookie === "mobile" ? "bg-green-100 text-green-800" : "bg-gray-100"}`}>
              {deviceFromCookie || "未设置"}
            </span>
          </p>
          <p>
            <span className="text-gray-500">最终判定:</span>
            <span className={`ml-2 px-2 py-1 rounded ${deviceFromHeader === "mobile" || deviceFromCookie === "mobile" || isMobileByUA ? "bg-green-100 text-green-800 font-bold" : "bg-gray-100 font-bold"}`}>
              {(deviceFromHeader === "mobile" || deviceFromCookie === "mobile" || isMobileByUA) ? "移动端" : "PC 端"}
            </span>
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg p-4 space-y-2">
        <h2 className="font-semibold text-lg">登录状态</h2>
        <div className="space-y-1 text-sm">
          <p><span className="text-gray-500">access_token:</span> {accessToken ? `${accessToken.slice(0, 20)}...` : "未登录"}</p>
          <p><span className="text-gray-500">wecom_userid:</span> {wecomUserid || "无"}</p>
          <p><span className="text-gray-500">wecom_name:</span> {wecomName || "无"}</p>
        </div>
      </div>

      <div className="bg-white rounded-lg p-4 space-y-2">
        <h2 className="font-semibold text-lg">所有 Cookie</h2>
        <div className="text-xs space-y-1">
          {cookiesList.getAll().map((c) => (
            <p key={c.name} className="bg-gray-100 p-1 rounded">
              <span className="font-semibold">{c.name}:</span> {c.value.slice(0, 50)}{c.value.length > 50 ? "..." : ""}
            </p>
          ))}
        </div>
      </div>

      <div className="bg-yellow-100 rounded-lg p-4">
        <p className="text-sm text-yellow-800">
          <strong>清除 cookie 方法:</strong> 访问 <a href="/clear-cache" className="underline">/clear-cache</a> 页面
        </p>
      </div>
    </div>
  );
}