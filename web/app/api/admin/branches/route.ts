// web/app/api/admin/branches/route.ts
// 门店维护：GET 列表(查 branch_admin_v，筛+分页) + PATCH ext(行内编辑)
// 直连 PostgREST（gateway 不代理 /rpc；同 D 子系统 targets route 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/branches?sbc=3120&war_zone=&region=&city=&q=&page=1&page_size=20
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const sbc = p.get('sbc') || '3120';
  const page = Number(p.get('page') || '1');
  const pageSize = Number(p.get('page_size') || '20');
  const and = [`system_book_code=eq.${sbc}`, `is_active=eq.true`];
  if (p.get('war_zone')) and.push(`war_zone=eq.${p.get('war_zone')}`);
  if (p.get('region')) and.push(`region_name=eq.${p.get('region')}`);
  if (p.get('city')) and.push(`city=eq.${p.get('city')}`);
  if (p.get('q')) and.push(`or=(branch_num.ilike.*${p.get('q')}*,branch_name.ilike.*${p.get('q')}*)`);
  const range = `${(page - 1) * pageSize}-${page * pageSize - 1}`;
  const r = await fetch(`${POSTGREST_URL}/branch_admin_v?select=*&${and.join('&')}&order=branch_num`, {
    headers: { ...headers, Range: range, Prefer: 'count=exact' },
  });
  const data = await r.json();
  const total = Number(r.headers.get('content-range')?.split('/')[1] || '0');
  return NextResponse.json({ data, total, page, pageSize });
}

// PATCH /api/admin/branches { system_book_code, branch_num, custom_group, note }
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  if (!b?.system_book_code || !b?.branch_num) return NextResponse.json({ ok: false, error: 'missing key' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_branch_ext`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_sbc: b.system_book_code, p_branch: b.branch_num, p_group: b.custom_group ?? '', p_note: b.note ?? '', p_by: b.by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
