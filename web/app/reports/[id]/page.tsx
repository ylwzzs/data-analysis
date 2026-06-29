import Link from "next/link";
import { notFound } from "next/navigation";

import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { ReportDetail } from "@/components/reports/report-detail";
import { Button } from "@/components/ui/button";
import { getReport } from "@/lib/api";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ReportPage({ params }: PageProps) {
  const { id } = await params;
  const report = await getReport(id);

  if (!report) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <Link href="/">
            <Button variant="ghost" className="mb-4">
              ← 返回列表
            </Button>
          </Link>
          <ReportDetail report={report} />
        </main>
      </div>
    </div>
  );
}
