// 语义字典：读 semantic_dictionary_v（指标+维度 UNION ALL，A1）
// 直连 PostgREST（同 items route 模式）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/semantic_dictionary_v?order=kind,code`, { headers });
  const data = await r.json();
  return NextResponse.json({ data });
}
