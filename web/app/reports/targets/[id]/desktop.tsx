"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { METRICS, MetricCode } from "@/lib/report-center/metric-source";
import { KpiCards } from "@/components/report-center/kpi-cards";
import { LineChart } from "@/components/charts/line-chart";
import { RankChart } from "@/components/charts/rank-chart";

// PC 看板：头部（返回 + 目标名 + 周期 + 状态徽章）+ 4 KPI 卡 + 趋势/排行 2:1 grid。
// focus 切换驱动趋势与排行。
//
// ⚠️ focusRank 按 focus 分派（关键数据模型）：
//   sale / delivery       → store breakdown（256 门店，门店级数据）
//   outbound_amt / profit → hq breakdown（2 品类，品类级数据，无门店级）
export function DesktopDashboard({
  target,
  kpi,
  trend,
  breakdown,
}: {
  target: any;
  kpi: any[];
  trend: Record<string, any>;
  breakdown: { store: any[]; hq: any[] };
}) {
  const [focus, setFocus] = useState<MetricCode>("sale");

  const focusTrend = (trend[focus] ?? []).map((d: any) => ({
    date: d.date,
    cum_actual: d.cum_actual,
    target_line: d.target_line,
  }));

  // focusRank 分派：sale/delivery→门店；outbound→品类
  const focusIsStore = focus === "sale" || focus === "delivery";
  const rankRows = (focusIsStore ? breakdown.store : breakdown.hq) ?? [];
  const focusRank = rankRows
    .filter((r: any) => r.metric_code === focus)
    .map((r: any) => ({
      name: focusIsStore ? r.branch_name || r.branch_num : r.category,
      rate: r.achievement_rate ?? 0,
    }))
    .slice(0, focusIsStore ? 15 : 2);

  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          报表中心
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-800">
            {target.name}
          </h1>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              target.status === "active"
                ? "bg-blue-50 text-blue-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {target.status === "active" ? "进行中" : "已结束"}
          </span>
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-slate-400">
          {target.start_date} ~ {target.end_date}
        </div>
      </div>

      {/* KPI 卡 */}
      <KpiCards rows={kpi} focus={focus} onFocus={setFocus} />

      {/* 趋势 + 排行 */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-700">
            累计达成趋势 · {METRICS[focus].label}
          </h3>
          <LineChart data={focusTrend} />
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-700">
            {focusIsStore ? "门店" : "品类"}达成排行 · {METRICS[focus].label}
          </h3>
          <RankChart data={focusRank} />
        </div>
      </div>
      {/* 交叉表 Task 7 填充 */}
    </div>
  );
}
