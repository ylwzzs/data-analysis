// web/app/api/admin/collect-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET - 日志列表
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('task_id');
  const status = url.searchParams.get('status');
  const limit = parseInt(url.searchParams.get('limit') || '50');

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  let query = client.database
    .from('collect_logs')
    .select('*, collect_tasks(id, name, data_sources(name))')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (taskId) {
    query = query.eq('task_id', taskId);
  }

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
