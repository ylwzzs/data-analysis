// 后端地址：process.env.NEXT_PUBLIC_API_URL || "http://localhost:7130"
// TODO: 接入 InsForge Edge Function (GET /api/reports) 后替换以下 Mock 数据。

export interface Metric {
  name: string;
  value: string;
  change?: string;
  trend?: "up" | "down" | "flat";
}

export interface Report {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  metrics: Metric[];
}

export async function getReports(): Promise<Report[]> {
  return [
    {
      id: "1",
      name: "销售日报",
      description: "每日销售数据汇总",
      updatedAt: "2026-06-29 10:30",
      metrics: [
        { name: "销售额", value: "¥125,000", change: "+12%", trend: "up" },
        { name: "订单数", value: "328", change: "+8%", trend: "up" },
      ],
    },
    {
      id: "2",
      name: "运营周报",
      description: "每周运营数据分析",
      updatedAt: "2026-06-28 18:00",
      metrics: [
        { name: "新增用户", value: "1,250", change: "-3%", trend: "down" },
        { name: "活跃用户", value: "8,500", change: "+5%", trend: "up" },
      ],
    },
  ];
}

export async function getReport(id: string): Promise<Report | null> {
  const reports = await getReports();
  return reports.find((r) => r.id === id) ?? null;
}
