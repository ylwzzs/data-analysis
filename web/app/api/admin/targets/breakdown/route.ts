// web/app/api/admin/targets/breakdown/route.ts
// 目标分解：一个目标返品类+门店两种 children；POST 按 rows 内容分派
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET ?parent_id=X → {categoryRows(总部品类), branchRows(门店), balance}
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  if (!pid) return NextResponse.json({ error: 'missing parent_id' }, { status: 400 });
  const [cat, br, ck] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_hq_category_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
    fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
    fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
  ]);
  return NextResponse.json({ categoryRows: cat || [], branchRows: br || [], balance: ck || {} });
}

// POST { parent_id, sbc?, rows } → 按 rows[0].category 分派(品类→hq RPC / 门店→store RPC)
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.parent_id || !b?.rows?.length) return NextResponse.json({ ok: false, error: '缺 parent_id/rows' }, { status: 400 });
  const isCategory = !!b.rows[0].category;
  const url = isCategory ? `${POSTGREST_URL}/rpc/upsert_hq_category_breakdown` : `${POSTGREST_URL}/rpc/upsert_target_breakdown`;
  const body = isCategory
    ? JSON.stringify({ p_parent_id: Number(b.parent_id), p_rows: b.rows, p_by: 'admin' })
    : JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || '3120', p_rows: b.rows, p_by: 'admin' });
  const r = await fetch(url, { method: 'POST', headers, body });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d);
}
