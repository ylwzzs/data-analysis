// web/app/api/admin/targets/breakdown/route.ts
// 目标分解：按 parent.target_type 分派(hq→品类 / store→门店)
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

async function parentType(pid: number): Promise<string> {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_target_type`, { method: 'POST', headers, body: JSON.stringify({ p_id: pid }) });
  return (await r.json()) || 'store';
}

// GET /api/admin/targets/breakdown?parent_id=X → {mode, rows, balance}
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  if (!pid) return NextResponse.json({ error: 'missing parent_id' }, { status: 400 });
  const mode = await parentType(Number(pid)) === 'hq' ? 'hq' : 'store';
  const br = mode === 'hq'
    ? await fetch(`${POSTGREST_URL}/rpc/get_hq_category_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json())
    : await fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json());
  const ck = await fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json());
  return NextResponse.json({ mode, rows: br || [], balance: ck || {} });
}

// POST { parent_id, sbc?, rows } → 按 parent 类型分派
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.parent_id || !b?.rows) return NextResponse.json({ ok: false, error: '缺 parent_id/rows' }, { status: 400 });
  const mode = await parentType(Number(b.parent_id)) === 'hq' ? 'hq' : 'store';
  const url = mode === 'hq' ? `${POSTGREST_URL}/rpc/upsert_hq_category_breakdown` : `${POSTGREST_URL}/rpc/upsert_target_breakdown`;
  const body = mode === 'hq'
    ? JSON.stringify({ p_parent_id: Number(b.parent_id), p_rows: b.rows, p_by: 'admin' })
    : JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || '3120', p_rows: b.rows, p_by: 'admin' });
  const r = await fetch(url, { method: 'POST', headers, body });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d);
}
