import { ReportCard } from "@/components/mobile/report-card";
import { getReports } from "@/lib/api";
import { buildWecomAuthUrl } from "@/lib/wecom";

export default async function MobileHomePage() {
  const reports = await getReports();
  const loginUrl = buildWecomAuthUrl(
    process.env.NEXT_PUBLIC_WECOM_REDIRECT_URI ||
      "http://localhost:3000/auth/callback",
  );

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white px-4 py-3 border-b sticky top-0 flex items-center justify-between">
        <h1 className="text-lg font-semibold">📊 报表中心</h1>
        {loginUrl ? (
          <a href={loginUrl} className="text-sm text-blue-600">
            企微登录
          </a>
        ) : null}
      </header>
      <main className="p-4 space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </main>
    </div>
  );
}
