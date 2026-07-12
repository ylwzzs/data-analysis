// web/app/api/admin/targets/breakdown/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/targets/breakdown?parent_id=X  → 分解行（门店×指标）+ 校验
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  if (!pid) return NextResponse.json({ error: 'missing parent_id' }, { status: 400 });
  const [br, ck] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
    fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
  ]);
  return NextResponse.json({ rows: br || [], balance: ck || {} });
}

// POST 批量保存分解 { parent_id, sbc, rows: [{branch_num, metrics:{metric:value}}] }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.parent_id || !b?.rows) return NextResponse.json({ ok: false, error: '缺 parent_id/rows' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_target_breakdown`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || '3120', p_rows: b.rows, p_by: 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d);
}
