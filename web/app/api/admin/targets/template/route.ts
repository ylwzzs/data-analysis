// web/app/api/admin/targets/template/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET 模板（CSV：战区,分组,门店号,门店名,指标1,指标2...）
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  const r = await fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) });
  const rows = await r.json();
  const metrics = rows?.[0]?.metrics ? Object.keys(rows[0].metrics) : ['sale'];
  const head = ['战区', '分组', '门店号', '门店名', ...metrics].join(',');
  const body = (rows || []).map((x: any) => [x.war_zone || '', x.group || '', x.branch_num, x.branch_name, ...metrics.map(m => x.metrics?.[m] ?? '')].join(',')).join('\n');
  return new NextResponse(`${head}\n${body}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="breakdown-template.csv"` } });
}
