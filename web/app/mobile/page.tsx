import { redirect } from "next/navigation";

// 移动端路径重定向到统一的响应式首页
// 首页会自动根据 UA 检测设备类型并渲染对应布局
export default function MobileHomePage() {
  redirect("/");
}
