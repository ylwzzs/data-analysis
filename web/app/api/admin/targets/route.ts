// web/app/api/admin/targets/route.ts
// D 目标 CRUD（走 SECURITY DEFINER RPC 绕 RLS；admin route 用 anon key 无 RLS 权限）
import { NextRequest, NextResponse } from 'next/server';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET: 目标列表（全量，admin 视角）→ report_achievement_v 经 RPC
export async function GET() {
  const r = await fetch(`${INSFORGE_API_BASE}/rpc/get_targets_admin`, {
    method: 'POST', headers, body: '{}',
  });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}

// POST: 新建/更新目标 + 指标值
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.metrics?.length) return NextResponse.json({ ok: false, error: 'missing metrics' }, { status: 400 });
  const r = await fetch(`${INSFORGE_API_BASE}/rpc/upsert_target_admin`, {
    method: 'POST', headers,
    body: JSON.stringify({
      p_name: b.name, p_sbc: b.system_book_code, p_branch: b.branch_num,
      p_start: b.start_date, p_end: b.end_date,
      p_metrics: b.metrics, p_created_by: b.created_by || 'admin',
    }),
  });
  const data = await r.json().catch(() => ({ ok: false, error: 'rpc failed' }));
  return NextResponse.json(data, { status: data?.ok ? 200 : 400 });
}
