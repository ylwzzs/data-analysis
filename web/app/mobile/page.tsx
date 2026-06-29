import { ReportCard } from "@/components/mobile/report-card";
import { getReports } from "@/lib/api";

export default async function MobileHomePage() {
  const reports = await getReports();

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white px-4 py-3 border-b sticky top-0">
        <h1 className="text-lg font-semibold">📊 报表中心</h1>
      </header>
      <main className="p-4 space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </main>
    </div>
  );
}
