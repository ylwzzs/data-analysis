"use client";

import Link from "next/link";

import { type ColumnDef } from "@tanstack/react-table";

import { BarChart } from "@/components/charts/bar-chart";
import { DataTable } from "@/components/reports/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Report } from "@/lib/api";

interface DesktopReportDetailProps {
  report: Report;
}

interface DetailRow {
  date: string;
  region: string;
  amount: string;
  orders: number;
}

const detailColumns: ColumnDef<DetailRow>[] = [
  { accessorKey: "date", header: "日期" },
  { accessorKey: "region", header: "区域" },
  { accessorKey: "amount", header: "金额" },
  { accessorKey: "orders", header: "订单数" },
];

// TODO: 明细数据接入真实查询结果
const detailRows: DetailRow[] = [
  { date: "2026-06-23", region: "华东", amount: "¥32,000", orders: 85 },
  { date: "2026-06-23", region: "华北", amount: "¥18,500", orders: 52 },
  { date: "2026-06-24", region: "华东", amount: "¥41,200", orders: 102 },
  { date: "2026-06-24", region: "华南", amount: "¥27,800", orders: 71 },
  { date: "2026-06-25", region: "华北", amount: "¥35,400", orders: 88 },
];

export function DesktopReportDetail({ report }: DesktopReportDetailProps) {
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
          <DataTable columns={detailColumns} data={detailRows} />
        </CardContent>
      </Card>
    </div>
  );
}