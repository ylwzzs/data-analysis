// web/app/api/admin/targets/route.ts
// D 目标 CRUD（service 身份直写，现状 admin route 同款无用户鉴权）
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET: 目标列表（读 report_achievement_v，含达成率）
export async function GET() {
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data, error } = await client.database
    .from('report_achievement_v')
    .select('*')
    .order('end_date', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

// POST: 新建/更新目标（含 metric_values）
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, system_book_code, branch_num, start_date, end_date, note, created_by, metrics } = body;
  if (!name || !system_book_code || !branch_num || !start_date || !end_date || !metrics?.length) {
    return NextResponse.json({ error: 'missing fields (name/system_book_code/branch_num/start_date/end_date/metrics)' }, { status: 400 });
  }
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data: t, error: te } = await client.database
    .from('targets')
    .upsert({ name, system_book_code, branch_num, start_date, end_date, note, created_by },
      { onConflict: 'system_book_code,branch_num,start_date,end_date' })
    .select();
  if (te || !t?.length) return NextResponse.json({ error: te?.message || 'upsert target failed' }, { status: 500 });
  const targetId = t[0].id;
  const rows = metrics.map((m: { metric_code: string; target_value: number }) =>
    ({ target_id: targetId, metric_code: m.metric_code, target_value: m.target_value }));
  const { error: me } = await client.database.from('target_metric_values').upsert(rows, { onConflict: 'target_id,metric_code' });
  if (me) return NextResponse.json({ error: me.message }, { status: 500 });
  return NextResponse.json({ success: true, target_id: targetId });
}
