"use client";

import { Badge } from "@/components/ui/badge";
import { BarChart } from "@/components/charts/bar-chart";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Report } from "@/lib/api";

interface ReportDetailProps {
  report: Report;
}

export function ReportDetail({ report }: ReportDetailProps) {
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

  return (
    <div className="space-y-6">
      {/* 标题区 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{report.name}</h1>
          <p className="text-muted-foreground">{report.description}</p>
        </div>
        <Badge variant="secondary">{report.updatedAt} 更新</Badge>
      </div>

      {/* 核心指标 */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {report.metrics.map((metric, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {metric.name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{metric.value}</p>
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
        <CardHeader>
          <CardTitle>趋势分析</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={chartData} title="近7日数据" />
        </CardContent>
      </Card>

      {/* 数据表格区 */}
      <Card>
        <CardHeader>
          <CardTitle>明细数据</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">
            数据表格组件将在后续添加
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
