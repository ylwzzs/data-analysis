// web/app/api/admin/targets/route.ts
// D 目标 CRUD（走 SECURITY DEFINER RPC 绕 RLS）
// ⚠️ gateway(7130) 不代理 /rpc，直连 PostgREST（同 agent-query 的 POSTGREST_URL 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET: 目标列表（全量，admin 视角）→ report_achievement_v 经 RPC
export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_targets_admin`, {
    method: 'POST', headers, body: '{}',
  });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}

// POST: 建总目标（多指标，branch_num=ALL）
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.metrics?.length || !b.name || !b.start_date || !b.end_date) return NextResponse.json({ ok: false, error: '缺字段' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_target_total`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_id: b.id ?? null, p_name: b.name, p_sbc: b.system_book_code || '3120', p_start: b.start_date, p_end: b.end_date, p_metrics: b.metrics, p_target_type: b.target_type || 'store', p_by: b.created_by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
