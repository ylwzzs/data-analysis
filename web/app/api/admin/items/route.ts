// web/app/api/admin/items/route.ts
// 商品档案维护：GET 列表(查 item_admin_v，筛+分页) + PATCH ext(单行) + POST ext(批量)
// 直连 PostgREST（gateway 不代理 /rpc；同 branches route 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/items?sbc=3120&category_l1=&category_l2=&custom_group=&q=&page=1&page_size=20
//     或 ?distinct=category_l1&sbc=3120 → L1 列表；?distinct=category_l2&sbc=&category_l1= → L2 联动列表
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  // distinct 支持：品类下拉（L1；L2 按 L1 联动）
  if (p.get('distinct') === 'category_l1') {
    const sbcD = p.get('sbc') || '3120';
    const r = await fetch(`${POSTGREST_URL}/item_admin_v?select=category_l1&system_book_code=eq.${sbcD}&is_active=eq.true&order=category_l1`, { headers });
    const rows = await r.json();
    const set = new Set(rows.map((x: any) => x.category_l1).filter(Boolean));
    return NextResponse.json({ data: [...set] });
  }
  if (p.get('distinct') === 'category_l2') {
    const sbcD = p.get('sbc') || '3120';
    const l1 = p.get('category_l1');
    const and = [`system_book_code=eq.${sbcD}`, `is_active=eq.true`];
    if (l1) and.push(`category_l1=eq.${l1}`);
    const r = await fetch(`${POSTGREST_URL}/item_admin_v?select=category_l2&${and.join('&')}&order=category_l2`, { headers });
    const rows = await r.json();
    const set = new Set(rows.map((x: any) => x.category_l2).filter(Boolean));
    return NextResponse.json({ data: [...set] });
  }
  const sbc = p.get('sbc') || '3120';
  const page = Number(p.get('page') || '1');
  const pageSize = Number(p.get('page_size') || '20');
  const and = [`system_book_code=eq.${sbc}`, `is_active=eq.true`];
  if (p.get('category_l1')) and.push(`category_l1=eq.${p.get('category_l1')}`);
  if (p.get('category_l2')) and.push(`category_l2=eq.${p.get('category_l2')}`);
  if (p.get('custom_group')) and.push(`custom_group=eq.${p.get('custom_group')}`);
  if (p.get('q')) {
    const q = p.get('q')!;
    and.push(`or=(item_num.ilike.*${q}*,item_name.ilike.*${q}*,item_code.ilike.*${q}*,bar_code.ilike.*${q}*)`);
  }
  const range = `${(page - 1) * pageSize}-${page * pageSize - 1}`;
  const r = await fetch(`${POSTGREST_URL}/item_admin_v?select=*&${and.join('&')}&order=item_num`, {
    headers: { ...headers, Range: range, Prefer: 'count=exact' },
  });
  const data = await r.json();
  const total = Number(r.headers.get('content-range')?.split('/')[1] || '0');
  return NextResponse.json({ data, total, page, pageSize });
}

// PATCH /api/admin/items { system_book_code, item_num, custom_group, note }
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  if (!b?.system_book_code || !b?.item_num) return NextResponse.json({ ok: false, error: 'missing key' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_item_ext`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_sbc: b.system_book_code, p_item: b.item_num, p_group: b.custom_group ?? '', p_note: b.note ?? '', p_by: b.by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}

// POST /api/admin/items { rows: [{system_book_code,item_num,custom_group,note}], by? }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!Array.isArray(b?.rows) || b.rows.length === 0) return NextResponse.json({ ok: false, error: 'empty rows' }, { status: 400 });
  const p_rows = b.rows.map((r: any) => ({
    system_book_code: r.system_book_code, item_num: r.item_num,
    custom_group: r.custom_group ?? '', note: r.note ?? '', updated_by: b.by || 'admin',
  }));
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_items_ext_batch`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_rows }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
