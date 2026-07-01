import { cookies } from "next/headers";

import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/layout/logout-button";
import { ReportCard } from "@/components/mobile/report-card";
import type { Report } from "@/lib/api";

interface MobileHomePageProps {
  reports: Report[];
}

export async function MobileHomePage({ reports }: MobileHomePageProps) {
  const userid = (await cookies()).get("wecom_userid")?.value;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-white px-4 py-3 border-b sticky top-0 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">数据分析平台</h1>
          <Badge variant="secondary">Beta</Badge>
        </div>
        <div className="flex items-center gap-2">
          {userid ? (
            <>
              <span className="text-sm text-muted-foreground">{userid}</span>
              <LogoutButton />
            </>
          ) : null}
        </div>
      </header>
      <main className="flex-1 p-4 space-y-3">
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} />
        ))}
      </main>
    </div>
  );
}
