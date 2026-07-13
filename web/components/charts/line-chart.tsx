"use client";

import ReactECharts from "echarts-for-react";

export interface TrendPoint {
  date: string;
  cum_actual: number;
  target_line: number;
}

// 累计达成趋势：实际累计 vs 匀速目标线。
// 实际线主色 #1E40AF（DESIGN primary 深蓝），目标线 #94A3B8 虚线（faint 中性）。
export function LineChart({ data, height = 300 }: { data: TrendPoint[]; height?: number }) {
  const option = {
    tooltip: { trigger: "axis" },
    legend: { data: ["实际累计", "目标线"], top: 0 },
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    xAxis: { type: "category", data: data.map((d) => d.date.slice(5)) },
    yAxis: { type: "value" },
    series: [
      {
        name: "实际累计",
        type: "line",
        smooth: true,
        data: data.map((d) => d.cum_actual),
        areaStyle: { opacity: 0.1 },
        itemStyle: { color: "#1E40AF" },
        lineStyle: { color: "#1E40AF" },
      },
      {
        name: "目标线",
        type: "line",
        smooth: true,
        data: data.map((d) => d.target_line),
        lineStyle: { type: "dashed", color: "#94A3B8" },
        itemStyle: { color: "#94A3B8" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height }} />;
}
