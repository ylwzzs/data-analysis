import { notFound } from "next/navigation";

import { getDeviceType } from "@/lib/get-device-type";
import { getClient } from "@/lib/api";
import { getTargetKpi } from "@/lib/report-center/targets";
import { getBreakdown, getTrend } from "@/lib/report-center/achievement";
import { METRIC_ORDER } from "@/lib/report-center/metric-source";
import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { DesktopDashboard } from "./desktop";
import { MobileDashboard } from "./mobile";

export const dynamic = "force-dynamic";

// 看板页：取数 + 按设备分发。PC Header+Sidebar，移动 Header only（参照 reports/[id]/layout.tsx）。
export default async function TargetDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const targetId = Number(id);
  const isMobile = (await getDeviceType()) === "mobile";
  console.log("[reports/targets/page]", { targetId, isMobile, render: isMobile ? "MOBILE" : "PC" });

  const client = await getClient();
  const { data: totalRows } = await client.database
    .from("report_achievement_v")
    .select("*")
    .eq("target_id", targetId)
    .eq("target_level", "total")
    .limit(1);
  if (!totalRows?.length) notFound();
  const t = totalRows[0];

  const [kpi, breakdownStore, breakdownHq] = await Promise.all([
    getTargetKpi(targetId),
    getBreakdown(targetId, "store"),
    getBreakdown(targetId, "hq"),
  ]);

  // 数据新鲜度：3 表最早 /compute 时间（updated_at min）
  let freshness: string | null = null;
  try { const fr = await client.database.rpc('get_data_freshness'); freshness = fr.data as unknown as string | null; } catch {}

  // 每个指标的趋势并行（outbound 走 delivery+wholesale 双查合并，失败降级空数组）
  const trendEntries = await Promise.all(METRIC_ORDER.map(async (code) => {
    const kr = kpi.find((k: any) => k.metric_code === code);
    if (!kr) return [code, []] as const;
    try {
      const t2 = await getTrend({
        system_book_code: t.system_book_code, branch_num: t.branch_num, category: t.category,
        start_date: t.start_date, end_date: t.end_date, target_value: kr.target_value, metric_code: code,
      });
      return [code, t2] as const;
    } catch {
      return [code, []] as const;
    }
  }));
  const trend: Record<string, any> = Object.fromEntries(trendEntries);

  const dashboard = isMobile ? (
    <MobileDashboard
      target={t}
      kpi={kpi}
      trend={trend}
      breakdown={{ store: breakdownStore, hq: breakdownHq }}
      freshness={freshness}
    />
  ) : (
    <div className="mx-auto max-w-7xl p-6">
      <DesktopDashboard
        target={t}
        kpi={kpi}
        trend={trend}
        breakdown={{ store: breakdownStore, hq: breakdownHq }}
        freshness={freshness}
      />
    </div>
  );

  // 外壳：PC Header + Sidebar，移动 Header only（不要丢 Header）
  if (isMobile) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main className="flex-1">{dashboard}</main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1">{dashboard}</main>
      </div>
    </div>
  );
}
