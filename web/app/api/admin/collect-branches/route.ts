// web/app/api/admin/collect-branches/route.ts
// 乐檬门店档案采集 API（手动触发入口；cron 走 scheduler 的 task_type=branches 分支）
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { collectBranches } from '@/lib/collect-branches';
import { ensureSchedulerInitialized } from '@/lib/scheduler';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE || 'http://insforge:7130';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    const body = await req.json();
    const { task_id } = body;

    const { data: task } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, params')
      .eq('id', task_id)
      .single();

    if (!task) {
      await writeLog(client, task_id, startedAt, new Date(), 'failed', 0, 'Task not found');
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    // 凭证
    let credentials: Record<string, string> = {};
    if (task.source_id) {
      const { data: cred } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', task.source_id)
        .single();
      if (cred?.credential_data) {
        try { credentials = JSON.parse(cred.credential_data); } catch { /* ignore */ }
      }
    }
    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) {
      await writeLog(client, task_id, startedAt, new Date(), 'failed', 0, 'No token configured');
      return NextResponse.json({ success: false, error: 'No token configured' }, { status: 400 });
    }

    const params = task.params || {};
    const companyId = Number(params.company_id);
    const pageSize = params.page_size || 200;
    if (!companyId) {
      await writeLog(client, task_id, startedAt, new Date(), 'failed', 0, '缺 params.company_id');
      return NextResponse.json({ success: false, error: '缺 params.company_id' }, { status: 400 });
    }

    await ensureSchedulerInitialized();
    const result = await collectBranches(authToken, companyId, pageSize);

    const finishedAt = new Date();
    await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString() }).eq('id', task_id);
    const finalStatus = result.error ? 'failed' : (result.verified ? 'success' : 'partial');
    await writeLog(client, task_id, startedAt, finishedAt, finalStatus, result.collected, result.error || undefined, { total: result.total, dbCount: result.dbCount, verified: result.verified });

    // C3: 门店档案采集后回调 carry-dims（fire-and-forget，dim_branch parquet 刷新）
    if (!result.error && result.verified) {
      fetch(`${process.env.DUCKDB_URL || "http://duckdb:9000"}/carry-dims`, {
        method: "POST", headers: { "x-agent-key": process.env.AGENT_API_KEY! },
      }).catch(() => {});
    }

    return NextResponse.json({
      success: !result.error && result.verified,
      total: result.total,
      collected: result.collected,
      dbCount: result.dbCount,
      verified: result.verified,
      error: result.error || undefined,
    });
  } catch (error: any) {
    console.error('[collect-branches] Fatal:', error);
    try {
      const body = await req.json();
      await writeLog(client, body.task_id, startedAt, new Date(), 'failed', 0, error.message);
    } catch { /* ignore */ }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function writeLog(
  client: any, taskId: string, startedAt: Date, finishedAt: Date,
  status: string, rowsCollected: number, errorMessage?: string, extra?: any
) {
  await client.database.from('collect_logs').insert([{
    task_id: taskId,
    status,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    rows_collected: rowsCollected,
    error_message: errorMessage || null,
    response_summary: extra || null,
  }]);
}
