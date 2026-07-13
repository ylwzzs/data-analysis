"use client";

import ReactECharts from "echarts-for-react";

// 环形达成率（移动端卡片用）。环形进度三色编码（DESIGN 语义色）。
//   rate >= 1   → success #16A34A
//   rate >= 0.8 → warning #D97706
//   rate < 0.8  → error #DC2626
// 轨道用 DESIGN border #E2E8F0。
export function GaugeChart({ rate, label }: { rate: number; label?: string }) {
  const pct = Math.round(rate * 100);
  const color = rate >= 1 ? "#16A34A" : rate >= 0.8 ? "#D97706" : "#DC2626";
  const option = {
    series: [
      {
        type: "gauge",
        startAngle: 90,
        endAngle: -270,
        radius: "90%",
        pointer: { show: false },
        progress: {
          show: true,
          overlap: false,
          roundCap: true,
          clip: false,
          itemStyle: { color },
        },
        axisLine: { lineStyle: { width: 16, color: [[1, "#E2E8F0"]] } },
        splitLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        data: [{ value: pct }],
        title: { show: false },
        detail: {
          valueAnimation: true,
          fontSize: 28,
          offsetCenter: [0, 0],
          formatter: "{value}%",
          color,
        },
      },
    ],
  };

  return (
    <div className="relative">
      <ReactECharts option={option} style={{ height: 200 }} />
      {label && (
        <p className="text-center text-sm text-slate-500 -mt-4">{label}</p>
      )}
    </div>
  );
}
