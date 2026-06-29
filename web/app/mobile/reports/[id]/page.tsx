import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Share2 } from "lucide-react";

import { BarChart } from "@/components/charts/bar-chart";
import { getReport } from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MobileReportPage({ params }: PageProps) {
  const { id } = await params;
  const report = await getReport(id);

  if (!report) {
    notFound();
  }

  // TODO: 图表数据接入真实查询结果
  const chartData = [
    { name: "周一", value: 12000 },
    { name: "周二", value: 15000 },
    { name: "周三", value: 18000 },
    { name: "周四", value: 14000 },
    { name: "周五", value: 20000 },
  ];

  return (
    <div className="min-h-screen bg-gray-100">
      {/* 顶部导航 */}
      <header className="bg-white px-4 py-3 border-b sticky top-0 flex items-center justify-between">
        <Link href="/mobile" className="flex items-center">
          <ChevronLeft className="w-5 h-5" />
          <span className="ml-1">返回</span>
        </Link>
        <h1 className="font-medium">{report.name}</h1>
        <Share2 className="w-5 h-5" />
      </header>

      <main className="p-4 space-y-4">
        {/* 核心指标 */}
        <div className="bg-white rounded-lg p-4">
          <h2 className="text-sm text-muted-foreground mb-3">核心指标</h2>
          <div className="grid grid-cols-2 gap-4">
            {report.metrics.map((m, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground">{m.name}</p>
                <p className="text-xl font-bold">{m.value}</p>
                {m.change && (
                  <p
                    className={
                      m.trend === "up"
                        ? "text-xs text-green-600"
                        : m.trend === "down"
                          ? "text-xs text-red-600"
                          : "text-xs text-gray-600"
                    }
                  >
                    {m.change}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 图表 */}
        <div className="bg-white rounded-lg p-4">
          <h2 className="text-sm text-muted-foreground mb-3">趋势分析</h2>
          <BarChart data={chartData} />
        </div>
      </main>
    </div>
  );
}
