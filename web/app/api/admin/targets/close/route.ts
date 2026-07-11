// web/app/api/admin/targets/close/route.ts
// D 目标提前结束并固化（转发 close_target RPC，直连 PostgREST）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

export async function POST(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/close_target`, {
    method: 'POST',
    headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_target_id: id }),
  });
  const data = await r.json().catch(() => ({}));
  return NextResponse.json(data, { status: r.ok ? 200 : 500 });
}
