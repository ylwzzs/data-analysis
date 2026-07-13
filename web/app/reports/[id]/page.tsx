import { redirect } from "next/navigation";

// 旧假报表详情（读 reports 种子表）已废弃。
// reports 表 id 与 targets 无映射，统一回到目标列表。
// 新看板见 /reports/targets/[id]。
export default async function LegacyReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;
  redirect("/");
}
