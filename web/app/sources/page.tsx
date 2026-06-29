import { Header } from "@/components/layout/header";
import { Sidebar } from "@/components/layout/sidebar";
import { SourcesTable } from "@/components/sources/sources-table";
import { getSources } from "@/lib/api";

export default async function SourcesPage() {
  const sources = await getSources();

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">
          <div className="mb-6">
            <h2 className="text-2xl font-bold">数据源</h2>
            <p className="text-muted-foreground">管理 API 数据采集源</p>
          </div>
          <SourcesTable data={sources} />
        </main>
      </div>
    </div>
  );
}
