"use client";

import Link from "next/link";

import { BarChart } from "@/components/charts/bar-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Report } from "@/lib/api";

interface MobileReportDetailProps {
  report: Report;
}

export function MobileReportDetail({ report }: MobileReportDetailProps) {
  // TODO: 图表数据接入真实查询结果
  const chartData = [
    { name: "周一", value: 12000 },
    { name: "周二", value: 15000 },
    { name: "周三", value: 18000 },
    { name: "周四", value: 14000 },
    { name: "周五", value: 20000 },
    { name: "周六", value: 25000 },
    { name: "周日", value: 21000 },
  ];

  // TODO: 明细数据接入真实查询结果
  const detailRows = [
    { date: "2026-06-23", region: "华东", amount: "¥32,000", orders: 85 },
    { date: "2026-06-23", region: "华北", amount: "¥18,500", orders: 52 },
    { date: "2026-06-24", region: "华东", amount: "¥41,200", orders: 102 },
    { date: "2026-06-24", region: "华南", amount: "¥27,800", orders: 71 },
    { date: "2026-06-25", region: "华北", amount: "¥35,400", orders: 88 },
  ];

  return (
    <div className="space-y-4 p-4">
      {/* 标题区 */}
      <div className="flex items-center gap-2 mb-4">
        <Link href="/">
          <Button variant="ghost" size="sm" className="px-2">
            ←
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold truncate">{report.name}</h1>
          <p className="text-sm text-muted-foreground truncate">
            {report.description}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs flex-shrink-0">
          {report.updatedAt}
        </Badge>
      </div>

      {/* 核心指标 - 横向滚动 */}
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
        {report.metrics.map((metric, i) => (
          <Card key={i} className="flex-shrink-0 w-32">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground mb-1">{metric.name}</p>
              <p className="text-xl font-bold">{metric.value}</p>
              {metric.change && (
                <p
                  className={
                    metric.trend === "up"
                      ? "text-xs text-green-600"
                      : metric.trend === "down"
                        ? "text-xs text-red-600"
                        : "text-xs text-gray-600"
                  }
                >
                  {metric.change}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 图表区 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">趋势分析</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={chartData} title="近7日数据" />
        </CardContent>
      </Card>

      {/* 数据表格区 - 移动端简化显示 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">明细数据</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {detailRows.map((row, i) => (
              <div key={i} className="p-3 flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium">{row.date}</p>
                  <p className="text-xs text-muted-foreground">{row.region}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold">{row.amount}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.orders} 单
                  </p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}