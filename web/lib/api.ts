// 前端数据层：通过 InsForge PostgREST 读取业务表。
// 对上层组件保持原有类型与函数签名不变（snake_case → camelCase 映射在此完成）。
import { insforge } from "@/lib/insforge";

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

export interface DataSource {
  id: string;
  name: string;
  description?: string;
  apiEndpoint: string;
  authType: "none" | "api_key" | "oauth" | "basic";
  schedule: string;
  enabled: boolean;
  lastSync?: string;
  rowCount?: number;
}

// PostgREST 原始行（数据库 snake_case）
interface ReportRow {
  id: string;
  name: string;
  description: string | null;
  updated_at: string | null;
  metrics: Metric[] | null;
}
interface SourceRow {
  id: string;
  name: string;
  description: string | null;
  api_endpoint: string;
  auth_type: DataSource["authType"];
  schedule: string;
  enabled: boolean;
  last_sync: string | null;
  row_count: number | null;
}

// "2026-06-29T10:30:00.000Z" / "2026-06-29 10:30:00" → "2026-06-29 10:30"
function formatTime(ts: string | null): string {
  if (!ts) return "";
  return ts.replace("T", " ").substring(0, 16);
}

export async function getReports(): Promise<Report[]> {
  const { data, error } = await insforge.database
    .from("reports")
    .select("id,name,description,updated_at,metrics");
  if (error) throw error;
  return (data as ReportRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    updatedAt: formatTime(r.updated_at),
    metrics: r.metrics ?? [],
  }));
}

export async function getReport(id: string): Promise<Report | null> {
  const { data, error } = await insforge.database
    .from("reports")
    .select("id,name,description,updated_at,metrics")
    .eq("id", id)
    .single();
  if (error || !data) return null;
  const r = data as ReportRow;
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    updatedAt: formatTime(r.updated_at),
    metrics: r.metrics ?? [],
  };
}

export async function getSources(): Promise<DataSource[]> {
  const { data, error } = await insforge.database
    .from("data_sources")
    .select(
      "id,name,description,api_endpoint,auth_type,schedule,enabled,last_sync,row_count"
    );
  if (error) throw error;
  return (data as SourceRow[]).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    apiEndpoint: s.api_endpoint,
    authType: s.auth_type,
    schedule: s.schedule,
    enabled: s.enabled,
    lastSync: s.last_sync ? formatTime(s.last_sync) : undefined,
    rowCount: s.row_count ?? undefined,
  }));
}
