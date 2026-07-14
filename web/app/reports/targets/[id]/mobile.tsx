"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";
import { GaugeChart } from "@/components/charts/gauge-chart";
import { LineChart } from "@/components/charts/line-chart";
import { RankChart } from "@/components/charts/rank-chart";
import { ShareButton } from "@/components/report-center/share-image";

// 移动看板：单列卡片流。指标 tab 横滑切换驱动三张卡（环形达成/趋势/排行）。
// 顶部返回 + 分享图（html2canvas 截 cardRef 区域下载 png）。
//
// ⚠️ focusRank 按 focus 分派（关键数据模型，同 desktop.tsx）：
//   sale / delivery       → store breakdown（256 门店，门店级数据，Top/Bottom 8）
//   outbound_amt / profit → hq breakdown（2 品类，品类级数据，无门店级，2 条）
export function MobileDashboard({
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
  const cardRef = useRef<HTMLDivElement>(null);

  const kpiRow = kpi.find((k: any) => k.metric_code === focus);
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
    .slice(0, focusIsStore ? 8 : 2);

  const fmtWan = (v: number) =>
    v >= 10000 ? (v / 10000).toFixed(1) + "万" : v.toFixed(0);

  return (
    <div className="mx-auto max-w-md space-y-3 p-3">
      {/* 顶部：返回 + 分享图 */}
      <div className="flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          报表中心
        </Link>
        <ShareButton
          targetRef={cardRef}
          filename={`${target.name}-${METRICS[focus].label}`}
        />
      </div>

      {/* 指标切换器：pill 横滑 */}
      <div className="flex gap-2 overflow-x-auto whitespace-nowrap pb-1">
        {METRIC_ORDER.map((c) => (
          <button
            key={c}
            onClick={() => setFocus(c)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs ${
              focus === c
                ? "bg-blue-600 text-white"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {METRICS[c].label}
          </button>
        ))}
      </div>

      {/* 主卡片区（供分享图截图） */}
      <div ref={cardRef} className="space-y-3">
        {/* 卡1：环形达成率 + 实际/目标/进度三栏 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <GaugeChart
            rate={kpiRow?.achievement_rate ?? 0}
            label={METRICS[focus].label}
          />
          <div className="mt-2 flex justify-around text-center text-xs tabular-nums">
            <div>
              <div className="text-slate-400">实际</div>
              <div className="font-medium text-slate-700">
                {fmtWan(kpiRow?.actual_value ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">目标</div>
              <div className="font-medium text-slate-700">
                {fmtWan(kpiRow?.target_value ?? 0)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">进度</div>
              <div className="font-medium text-slate-700">
                {((kpiRow?.progress_rate ?? 0) * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        </div>

        {/* 卡2：累计趋势迷你 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h4 className="mb-1 text-xs text-slate-500">
            累计达成趋势 · {METRICS[focus].label}
          </h4>
          {focusTrend.length > 0 ? <LineChart data={focusTrend} height={160} /> : <div className="text-center text-slate-400 py-8 text-sm">暂无数据</div>}
        </div>

        {/* 卡3：门店/品类排行 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h4 className="mb-1 text-xs text-slate-500">
            {focusIsStore ? "门店" : "品类"}达成排行 · {METRICS[focus].label}
          </h4>
          {focusRank.length > 0 ? <RankChart data={focusRank} height={200} /> : <div className="text-center text-slate-400 py-8 text-sm">暂无数据</div>}
        </div>
      </div>
    </div>
  );
}
