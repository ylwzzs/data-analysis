import { redirect } from "next/navigation";

// 旧移动端假报表详情已废弃，直接重定向到首页目标列表。
export default async function MobileReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await params;
  redirect("/");
}
