// web/app/api/admin/collect-items/route.ts
// 乐檬商品档案采集 API（手动触发入口）

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { collectItems } from '@/lib/collect-items';
import { ensureSchedulerInitialized } from '@/lib/scheduler';

// 使用内部 API 地址（容器内访问 insforge 服务）
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE || 'http://insforge:7130';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

// ===== 主流程 =====
export async function POST(req: NextRequest) {
  const startedAt = new Date();

  try {
    const body = await req.json();
    const { task_id } = body;

    const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

    // 获取任务信息
    const { data: task } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, params')
      .eq('id', task_id)
      .single();

    if (!task) {
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'Task not found');
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    // 获取凭证
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
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'No token configured');
      return NextResponse.json({ success: false, error: 'No token configured' }, { status: 400 });
    }

    const params = task.params || {};
    const branchId = params.branch_id || 28444;
    const pageSize = params.page_size || 200;

    console.log(`[collect-items] Manual trigger: task=${task.name}, branch_id=${branchId}`);

    // 首次调用时初始化定时调度器
    await ensureSchedulerInitialized();

    // 执行采集
    const result = await collectItems(authToken, branchId, pageSize);

    // ===== 更新任务状态 =====
    const finishedAt = new Date();
    await client.database
      .from('collect_tasks')
      .update({ last_run_at: finishedAt.toISOString() })
      .eq('id', task_id);

    const finalStatus = result.error ? 'failed' : 'success';
    await writeLog(
      client,
      task_id,
      startedAt,
      finishedAt,
      finalStatus,
      result.collected,
      result.error || undefined,
      { total: result.total }
    );

    // C3: 商品档案采集后回调 carry-dims（fire-and-forget，dim_item parquet 刷新）
    if (!result.error && result.verified) {
      fetch(`${process.env.DUCKDB_URL || "http://duckdb:9000"}/carry-dims`, {
        method: "POST", headers: { "x-agent-key": process.env.AGENT_API_KEY! },
      }).catch(() => {});
    }

    return NextResponse.json({
      success: !result.error && result.verified,
      total: result.total,
      collected: result.collected,
      deduped: result.deduped,
      dbCount: result.dbCount,
      verified: result.verified,
      error: result.error || undefined
    });

  } catch (error: any) {
    console.error('[collect-items] Fatal error:', error);
    const finishedAt = new Date();

    try {
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const body = await req.json();
      await writeLog(client, body.task_id, startedAt, finishedAt, 'failed', 0, error.message);
    } catch { /* ignore */ }

    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// ===== 写入日志 =====
async function writeLog(
  client: any,
  taskId: string,
  startedAt: Date,
  finishedAt: Date,
  status: string,
  rowsCollected: number,
  errorMessage?: string,
  extra?: any
) {
  await client.database
    .from('collect_logs')
    .insert([{
      task_id: taskId,
      status: status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rows_collected: rowsCollected,
      error_message: errorMessage || null,
      response_summary: extra || null,
    }]);
}