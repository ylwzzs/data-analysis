// web/app/api/admin/reconcile-check/route.ts
// 临时对账：4 采集任务 × 指定每天 API total vs 库 parquet count，返异常（库<API）
import { NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { countRetailApi, decodeCompanyId } from '@/lib/collect';
import { countDeliveryApi } from '@/lib/collect-delivery';
import { countWholesaleApi } from '@/lib/collect-wholesale';
import { notifyWecom } from '@/lib/notify';

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY!;

async function duckdbCount(pathGlob: string): Promise<number> {
  try {
    const r = await fetch(`${DUCKDB_URL}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY }, body: JSON.stringify({ sql: `SELECT count(*) AS c FROM read_parquet('s3://lemeng-datasource/${pathGlob}')` }) });
    return (await r.json()).data?.[0]?.c || 0;
  } catch { return 0; }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) || {};
  const dayList: string[] = body.days?.length ? body.days : Array.from({ length: 15 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
  const client = createClient({ baseUrl: process.env.INSFORGE_API_BASE!, anonKey: process.env.INSFORGE_API_KEY! });
  const { data: tasks } = await client.database.from('collect_tasks').select('id,name,function_slug,source_id,params').in('function_slug', ['collect-lemeng', 'collect-delivery', 'collect-wholesale']);
  const results: any[] = [];
  for (const t of tasks || []) {
    const { data: cred } = await client.database.from('auth_credentials').select('credential_data').eq('source_id', t.source_id).single();
    let token = '';
    try { token = JSON.parse(cred?.credential_data || '{}').token; } catch {}
    const authToken = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
    const companyId = decodeCompanyId(authToken);
    for (const day of dayList) {
      let apiCount = -1, libPath = '';
      try {
        if (t.function_slug === 'collect-lemeng') {
          const bn: number[] = t.params?.branch_nums || [];
          apiCount = await countRetailApi(authToken, bn, bn.join(','), [day, day]);
          libPath = `lemeng/retail_detail/${companyId}/${day}/all.parquet`;
        } else if (t.function_slug === 'collect-delivery') {
          const db = Number(t.params?.distribution_branch_num) || 99;
          apiCount = await countDeliveryApi(authToken, db, String(db), `${day} 00:00:00`, `${day} 23:59:59`);
          libPath = `lemeng/transfer_detail/${companyId}/${day.replace(/-/g, '')}/all.parquet`;
        } else {
          apiCount = await countWholesaleApi(authToken, '99', `${day} 00:00:00`, `${day} 23:59:59`);
          libPath = `lemeng/wholesale_detail/${companyId}/${day.replace(/-/g, '')}/all.parquet`;
        }
      } catch (e: any) { apiCount = -1; }
      const libCount = await duckdbCount(libPath);
      await new Promise(r => setTimeout(r, 600 + Math.floor(Math.random() * 800))); // 反爬随机间隔
      results.push({ task: t.name, day, api: apiCount, lib: libCount, ok: apiCount >= 0 && libCount >= apiCount });
    }
  }
  const abnormal = results.filter(r => !r.ok);
  if (abnormal.length) {
    await notifyWecom('⚠️ 采集周对账异常', `${abnormal.length}/${results.length} 项异常（库<API）:\n${abnormal.slice(0, 15).map(x => `${x.task} ${x.day} API=${x.api} 库=${x.lib}`).join('\n')}`).catch(() => {});
  } else {
    await notifyWecom('✅ 采集周对账通过', `${results.length} 项全部对齐（库≥API）`).catch(() => {});
  }
  return NextResponse.json({ total: results.length, abnormal_count: abnormal.length, abnormal, all: results });
}
