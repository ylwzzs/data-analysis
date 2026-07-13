"use client";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";

interface KpiRow {
  metric_code: MetricCode;
  target_value: number;
  actual_value: number | null;
  achievement_rate: number | null;
  progress_rate: number | null;
  data_status: string;
}

function fmtWan(v: number) {
  return v >= 10000 ? (v / 10000).toFixed(1) + "万" : v.toFixed(0);
}

// 达成率三色编码（DESIGN 语义色），按 progress_rate 着色：
//   >=1   → success #16A34A（跑赢进度）
//   >=0.8 → warning #D97706（接近）
//   <0.8  → error #DC2626（落后）
function rateColor(r: number) {
  return r >= 1
    ? "text-green-600"
    : r >= 0.8
      ? "text-amber-600"
      : "text-red-600";
}

function statusBadgeClass(s: string) {
  const m: Record<string, string> = {
    complete: "bg-green-50 text-green-700",
    partial: "bg-amber-50 text-amber-700",
    missing: "bg-red-50 text-red-700",
    not_ready: "bg-slate-100 text-slate-400",
  };
  return m[s] ?? m.not_ready;
}

// 4 指标 KPI 卡行：每卡显示 label / 达成率大数字 / 实际·目标·进度 / 数据状态徽章。
// 点击 onFocus 切聚焦；聚焦卡 border-blue-500 ring-1（DESIGN primary）。
export function KpiCards({
  rows,
  focus,
  onFocus,
}: {
  rows: KpiRow[];
  focus: MetricCode;
  onFocus: (m: MetricCode) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {METRIC_ORDER.map((code) => {
        const r = rows.find((x) => x.metric_code === code);
        if (!r) return null;
        const meta = METRICS[code];
        const progress = r.progress_rate ?? 0;
        const isFocus = focus === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onFocus(code)}
            className={`rounded-md border p-4 text-left transition ${
              isFocus
                ? "border-blue-500 ring-1 ring-blue-500"
                : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{meta.label}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${statusBadgeClass(
                  r.data_status,
                )}`}
              >
                {r.data_status}
              </span>
            </div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${rateColor(
                progress,
              )}`}
            >
              {((r.achievement_rate ?? 0) * 100).toFixed(1)}%
            </div>
            <div className="mt-1 text-xs tabular-nums text-slate-400">
              {fmtWan(r.actual_value ?? 0)} / {fmtWan(r.target_value)} · 进度{" "}
              {(progress * 100).toFixed(0)}%
            </div>
          </button>
        );
      })}
    </div>
  );
}
