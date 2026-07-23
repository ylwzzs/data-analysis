// 指标依赖图数据：metric_registry → nodes + edges（derived → depends_on）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/metric_registry?order=measure_type,metric_code`, { headers });
  const rows: any[] = await r.json();
  const nodes = rows.map((m) => ({
    id: m.metric_code,
    name: m.name,
    measure_type: m.measure_type,
    formula: m.formula,
    additive: m.additive,
    cost_sensitive: m.cost_sensitive,
  }));
  const edges: { source: string; target: string }[] = [];
  for (const m of rows) {
    if (m.measure_type === 'derived' && Array.isArray(m.depends_on)) {
      for (const dep of m.depends_on) edges.push({ source: m.metric_code, target: dep });
    }
  }
  return NextResponse.json({ nodes, edges });
}
