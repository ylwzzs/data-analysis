import { redirect } from "next/navigation";

// 旧假报表列表（读 reports 种子表）已废弃。
// 报表中心首页 / 已改为目标列表（读 report_achievement_v）。
// 保留此文件仅作旧书签兼容，统一重定向到首页。
export default function ReportsPage() {
  redirect("/");
}
