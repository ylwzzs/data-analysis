"use client";

import ReactECharts from "echarts-for-react";

export interface RankItem {
  name: string;
  rate: number; // 达成率 0~1
}

// 横向柱排行：按达成率升序（横向柱从下往上）。达成三色编码（DESIGN 语义色）。
//   rate >= 1   → success #16A34A（达成）
//   rate >= 0.8 → warning #D97706（接近）
//   rate < 0.8  → error #DC2626（落后）
export function RankChart({ data, height = 300 }: { data: RankItem[]; height?: number }) {
  const sorted = [...data].sort((a, b) => a.rate - b.rate);
  const option = {
    tooltip: {
      trigger: "axis",
      formatter: (p: { name: string; value: number }[]) =>
        `${p[0].name}: ${(p[0].value * 100).toFixed(1)}%`,
    },
    grid: { left: 80, right: 30, top: 10, bottom: 20 },
    xAxis: {
      type: "value",
      max: 1,
      axisLabel: { formatter: (v: number) => (v * 100).toFixed(0) + "%" },
    },
    yAxis: { type: "category", data: sorted.map((d) => d.name) },
    series: [
      {
        type: "bar",
        data: sorted.map((d) => ({
          value: d.rate,
          itemStyle: {
            color:
              d.rate >= 1 ? "#16A34A" : d.rate >= 0.8 ? "#D97706" : "#DC2626",
          },
        })),
      },
    ],
  };

  return <ReactECharts option={option} style={{ height }} />;
}
