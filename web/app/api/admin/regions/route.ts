// web/app/api/admin/regions/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET 区域映射列表
export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/dim_region?select=*&order=region_name`, { headers });
  const data = await r.json();
  return NextResponse.json({ data });
}

// POST upsert 一条或批量 { region_name, war_zone, sub_region, display_name } 或 { rows: [...] }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (b.rows) {
    const r = await fetch(`${POSTGREST_URL}/rpc/upsert_regions_batch`, { method: 'POST', headers, body: JSON.stringify({ p_rows: b.rows }) });
    return NextResponse.json(await r.json().catch(() => ({ ok: false })));
  }
  if (!b.region_name) return NextResponse.json({ ok: false, error: 'missing region_name' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_region`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_region: b.region_name, p_war_zone: b.war_zone ?? '', p_sub: b.sub_region ?? '', p_display: b.display_name ?? '' }),
  });
  return NextResponse.json(await r.json().catch(() => ({ ok: false })));
}
