// web/app/api/admin/targets/import/route.ts
// D 目标 CSV 批量导入（逐行校验 + 部分成功）
// 模板列: name,system_book_code,branch_num,start_date,end_date,target_sale[,target_purchase]
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File;
  if (!file) return NextResponse.json({ error: 'no file' }, { status: 400 });
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return NextResponse.json({ error: 'empty csv (need header+1 row)' }, { status: 400 });
  const header = lines[0].split(',').map(h => h.trim());
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data: branches } = await client.database.from('dim_branch')
    .select('system_book_code,branch_num').eq('is_active', true);
  const branchSet = new Set((branches || []).map((b: any) => `${b.system_book_code}|${b.branch_num}`));
  let imported = 0;
  const errors: { row: number; reason: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, idx) => row[h] = cols[idx] ?? '');
    try {
      const { name, system_book_code, branch_num, start_date, end_date } = row;
      if (!name || !system_book_code || !branch_num || !start_date || !end_date) throw new Error('缺必填字段');
      if (!branchSet.has(`${system_book_code}|${branch_num}`)) throw new Error(`门店 ${system_book_code}/${branch_num} 不在 dim_branch`);
      if (end_date < start_date) throw new Error('end_date < start_date');
      const { data: t, error } = await client.database.from('targets')
        .upsert({ name, system_book_code, branch_num, start_date, end_date },
          { onConflict: 'system_book_code,branch_num,start_date,end_date' }).select();
      if (error || !t?.length) throw new Error(error?.message || 'upsert failed');
      const mv: { target_id: number; metric_code: string; target_value: number }[] = [];
      for (const h of header) {
        const m = h.match(/^target_(.+)$/);
        if (m && row[h]) mv.push({ target_id: t[0].id, metric_code: m[1], target_value: Number(row[h]) });
      }
      if (mv.length) {
        const { error: me } = await client.database.from('target_metric_values').upsert(mv, { onConflict: 'target_id,metric_code' });
        if (me) throw new Error(me.message);
      }
      imported++;
    } catch (e: any) { errors.push({ row: i + 1, reason: e.message }); }
  }
  return NextResponse.json({ imported, failed: errors.length, errors });
}
