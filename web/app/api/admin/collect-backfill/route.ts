// web/app/api/admin/collect-backfill/route.ts
// 按日期补采：指定 task_id + 日期范围，full 模式重采该范围（修复漏采/补历史缺口）
// 复用 scheduler 的凭证解析 + collect 函数；full 模式覆盖写
import { NextRequest, NextResponse } from 'next/server';
import { collectOnce } from '@/lib/collect';
import { collectDeliveryOnce } from '@/lib/collect-delivery';
import { collectWholesaleOnce } from '@/lib/collect-wholesale';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// POST { task_id, date_from, date_to } (YYYY-MM-DD)
export async function POST(req: NextRequest) {
  const b = await req.json();
  const { task_id, date_from, date_to } = b;
  if (!task_id || !date_from || !date_to) return NextResponse.json({ ok: false, error: '缺 task_id/date_from/date_to' }, { status: 400 });

  // 取任务
  const tr = await fetch(`${POSTGREST_URL}/collect_tasks?id=eq.${task_id}&select=*`, { headers: H });
  const task = (await tr.json())[0];
  if (!task) return NextResponse.json({ ok: false, error: '任务不存在' }, { status: 404 });

  // 取凭证（auth_credentials by source_id）
  const cr = await fetch(`${POSTGREST_URL}/auth_credentials?source_id=eq.${task.source_id}&select=credential_data`, { headers: H });
  const credRow = (await cr.json())[0];
  const cred = credRow?.credential_data ? JSON.parse(credRow.credential_data) : {};
  if (!cred.token) return NextResponse.json({ ok: false, error: '无凭证 token（source ' + task.source_id + '）' }, { status: 400 });
  const authToken = cred.token.startsWith('Bearer ') ? cred.token : `Bearer ${cred.token}`;

  const params = task.params || {};
  const limit = params.page_size || 200;
  const tt = params.task_type;
  let result: any;
  try {
    if (tt === 'delivery') {
      const dist = Number(params.distribution_branch_num) || 99;
      result = await collectDeliveryOnce(authToken, dist, String(dist), `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
    } else if (tt === 'wholesale') {
      const bn = (params.branch_nums || []).join(',');
      result = await collectWholesaleOnce(authToken, bn, `${date_from} 00:00:00`, `${date_to} 23:59:59`, limit, { mode: 'full' });
    } else {
      // retail（默认）：dates=[from,to]
      const branchNums = (params.branch_nums || []) as number[];
      result = await collectOnce(authToken, branchNums, branchNums.join(','), [date_from, date_to], limit, { mode: 'full' });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: !result.error, records: result.records?.length || 0, apiTotal: result.apiTotal,
    error: result.error, storagePath: result.storagePath,
  });
}
