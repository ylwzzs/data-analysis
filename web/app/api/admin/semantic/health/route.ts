// 语义层健康：A) 动态发现所有 audit 视图算 rollup diff  B) 跑 validate_semantic_registry
import { NextResponse } from 'next/server';
import { parseAuditViewNames, computeAuditStats } from '@/lib/semantic/health';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  // A: 动态发现 audit 视图（PostgREST 根 OpenAPI）
  const rootRes = await fetch(`${POSTGREST_URL}/`, { headers });
  const openapi = await rootRes.json();
  const auditViews = parseAuditViewNames(openapi);
  const audits = [];
  for (const view of auditViews) {
    const r = await fetch(`${POSTGREST_URL}/${view}?limit=1000`, { headers });
    if (!r.ok) {
      audits.push({ view, diffColumns: [], status: 'warn', totals: {}, error: `query ${r.status}` });
      continue;
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) {
      audits.push({ view, diffColumns: [], status: 'warn', totals: {}, error: 'non-array response' });
      continue;
    }
    audits.push({ view, ...computeAuditStats(rows) });
  }

  // B: 配置校验（/rpc 必须直连 PostgREST，gateway 不代理）
  const vRes = await fetch(`${POSTGREST_URL}/rpc/validate_semantic_registry`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const validationsRaw = await vRes.json();
  const validations = Array.isArray(validationsRaw) ? validationsRaw : [];

  return NextResponse.json({ audits, validations });
}
