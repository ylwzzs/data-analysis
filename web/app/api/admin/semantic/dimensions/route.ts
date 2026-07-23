// 维度 + 层级（建树数据）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const [dimensions, levels] = await Promise.all([
    fetch(`${POSTGREST_URL}/dimensions?order=dim_code`, { headers }).then((r) => r.json()),
    fetch(`${POSTGREST_URL}/dimension_levels?order=dim_code,depth`, { headers }).then((r) => r.json()),
  ]);
  return NextResponse.json({ dimensions, levels });
}
