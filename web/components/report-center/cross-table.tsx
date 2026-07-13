"use client";

import { useMemo } from "react";
import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";
import { ChartActions, exportExcel } from "./chart-actions";

// BreakdownRow 与 lib/report-center/achievement.ts 的 BreakdownRow 对齐。
// desktop 传入 any[]（store breakdown），字段同 report_achievement_v。
export interface BreakdownRow {
  target_id: number;
  branch_num: string;
  branch_name: string;
  war_zone: string;
  category: string | null;
  metric_code: MetricCode;
  target_value: number;
  actual_value: number | null;
  achievement_rate: number | null;
  progress_rate: number | null;
}

// 达成率三色编码（DESIGN L66）：>=1 绿 / >=0.8 琥珀 / <0.8 红 / 无数据灰
function rateClass(rate: number | null) {
  if (rate == null) return "text-slate-300";
  return rate >= 1 ? "text-green-600" : rate >= 0.8 ? "text-amber-600" : "text-red-600";
}

function fmtPct(rate: number, dp = 0) {
  return (rate * 100).toFixed(dp) + "%";
}

interface PivotedStore {
  branch_name: string;
  war_zone: string;
  byMetric: Partial<Record<MetricCode, BreakdownRow>>;
}

// 门店 × 指标 交叉表。
// 列动态：从 rows 提取 unique metric_code（store breakdown 应为 sale/delivery），
// 按 METRIC_ORDER 排序保证列序稳定。不硬编码 4 列，避免 outbound 列全空。
export function CrossTable({ rows }: { rows: BreakdownRow[] }) {
  const { pivot, metricCols } = useMemo(() => {
    const m = new Map<string, PivotedStore>();
    const metricSet = new Set<MetricCode>();
    for (const r of rows) {
      if (!m.has(r.branch_num)) {
        m.set(r.branch_num, {
          branch_name: r.branch_name,
          war_zone: r.war_zone,
          byMetric: {},
        });
      }
      m.get(r.branch_num)!.byMetric[r.metric_code] = r;
      metricSet.add(r.metric_code);
    }
    // 列 = rows 中出现的 metric，按 METRIC_ORDER 排序（sale 在 delivery 前）
    const cols = METRIC_ORDER.filter((c) => metricSet.has(c));
    // 行按战区分组（同战区相邻，DESIGN L68），战区内按门店名排序
    const piv = [...m.entries()].sort((a, b) => {
      const wz = (a[1].war_zone || "").localeCompare(b[1].war_zone || "", "zh-Hans");
      if (wz !== 0) return wz;
      return (a[1].branch_name || a[0]).localeCompare(b[1].branch_name || b[0], "zh-Hans");
    });
    return { pivot: piv, metricCols: cols };
  }, [rows]);

  // 战区合并单元格（DESIGN L68）：同战区相邻，首行 rowSpan=组大小，其余省略。
  const wzSpans = pivot.map(([, v], i) => {
    const wz = v.war_zone || "—";
    const prevWz = i > 0 ? pivot[i - 1][1].war_zone || "—" : null;
    const show = wz !== prevWz;
    let span = 1;
    if (show) {
      for (let j = i + 1; j < pivot.length; j++) {
        if ((pivot[j][1].war_zone || "—") === wz) span++;
        else break;
      }
    }
    return { wz, show, span };
  });

  const handleExcel = () => {
    const head = [
      "战区",
      "门店",
      ...metricCols.map((c) => METRICS[c].label + "达成"),
    ];
    const body = pivot.map(([num, v]) => [
      v.war_zone || "",
      v.branch_name || num,
      ...metricCols.map((c) => {
        const r = v.byMetric[c];
        return r && r.achievement_rate != null
          ? fmtPct(r.achievement_rate, 1)
          : "—";
      }),
    ]);
    exportExcel([head, ...body], "门店指标达成");
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">门店 × 指标达成</h3>
        <ChartActions onExcel={handleExcel} />
      </div>
      <div className="overflow-auto max-h-[480px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">战区</th>
              <th className="px-3 py-2 text-left font-medium">门店</th>
              {metricCols.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium">
                  {METRICS[c].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pivot.length === 0 && (
              <tr>
                <td
                  colSpan={2 + metricCols.length}
                  className="px-3 py-8 text-center text-slate-400"
                >
                  暂无门店数据
                </td>
              </tr>
            )}
            {pivot.map(([num, v], i) => {
              const span = wzSpans[i];
              return (
                <tr key={num} className="hover:bg-slate-50">
                  {span.show ? (
                    <td
                      rowSpan={span.span}
                      className="px-3 py-2 align-top text-slate-500"
                    >
                      {span.wz}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-slate-700">
                    {v.branch_name || num}
                  </td>
                  {metricCols.map((c) => {
                    const r = v.byMetric[c];
                    const rate = r?.achievement_rate ?? null;
                    return (
                      <td
                        key={c}
                        className={`px-3 py-2 text-right tabular-nums ${rateClass(rate)}`}
                      >
                        {rate == null ? "—" : fmtPct(rate)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
