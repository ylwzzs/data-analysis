"use client";

import ReactECharts from "echarts-for-react";

interface BarChartProps {
  data: { name: string; value: number }[];
  title?: string;
}

export function BarChart({ data, title }: BarChartProps) {
  const option = {
    title: title ? { text: title, left: "center" } : undefined,
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: data.map((d) => d.name) },
    yAxis: { type: "value" },
    series: [
      {
        data: data.map((d) => d.value),
        type: "bar",
        itemStyle: { color: "#3b82f6" },
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: "300px" }} />;
}
