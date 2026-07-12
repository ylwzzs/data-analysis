// web/app/api/admin/regions/unmapped/route.ts
import { NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_unmapped_regions`, { method: 'POST', headers, body: '{}' });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}
