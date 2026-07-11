// web/app/api/admin/targets/import/route.ts
// D 目标 CSV 批量导入（逐行调 upsert_target_admin RPC，校验在 RPC 内）
// 模板列: name,system_book_code,branch_num,start_date,end_date,target_sale[,target_purchase]
import { NextRequest, NextResponse } from 'next/server';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File;
  if (!file) return NextResponse.json({ error: 'no file' }, { status: 400 });
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return NextResponse.json({ error: 'empty csv (need header+1 row)' }, { status: 400 });
  const header = lines[0].split(',').map(h => h.trim());
  let imported = 0;
  const errors: { row: number; reason: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, idx) => row[h] = cols[idx] ?? '');
    const metrics: { metric_code: string; target_value: number }[] = [];
    for (const h of header) {
      const m = h.match(/^target_(.+)$/);
      if (m && row[h]) metrics.push({ metric_code: m[1], target_value: Number(row[h]) });
    }
    const r = await fetch(`${INSFORGE_API_BASE}/rpc/upsert_target_admin`, {
      method: 'POST', headers,
      body: JSON.stringify({
        p_name: row.name, p_sbc: row.system_book_code, p_branch: row.branch_num,
        p_start: row.start_date, p_end: row.end_date, p_metrics: metrics, p_created_by: 'csv-import',
      }),
    });
    const d = await r.json().catch(() => ({ ok: false, error: 'rpc failed' }));
    if (d?.ok) imported++;
    else errors.push({ row: i + 1, reason: d?.error || 'failed' });
  }
  return NextResponse.json({ imported, failed: errors.length, errors });
}
