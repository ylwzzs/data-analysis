// web/app/api/admin/collect-tasks/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET - 任务列表
export async function GET() {
  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { data, error } = await client.database
    .from('collect_tasks')
    .select(`
      id,
      name,
      source_id,
      function_slug,
      schedule_cron,
      enabled,
      storage_type,
      storage_path,
      params,
      last_run_at,
      next_run_at,
      created_at,
      data_sources(id, name, auth_type),
      collect_logs(status, started_at, rows_collected, error_message)
    `)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// POST - 创建任务
export async function POST(req: NextRequest) {
  const body = await req.json();

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const nextRunAt = calculateNextRun(body.schedule_cron);

  const { data, error } = await client.database
    .from('collect_tasks')
    .insert([{
      ...body,
      next_run_at: nextRunAt
    }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// PUT - 更新任务
export async function PUT(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const body = await req.json();

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  if (body.schedule_cron) {
    body.next_run_at = calculateNextRun(body.schedule_cron);
  }

  const { data, error } = await client.database
    .from('collect_tasks')
    .update(body)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// PATCH - 手动触发执行
export async function PATCH(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { data: task, error: taskError } = await client.database
    .from('collect_tasks')
    .select('id, name, source_id, function_slug, params, storage_type, storage_path, data_sources(id, name, auth_type)')
    .eq('id', id)
    .single();

  if (taskError || !task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  let credentials = null;
  if (task.source_id) {
    const { data: cred } = await client.database
      .from('auth_credentials')
      .select('credential_data, expires_at')
      .eq('source_id', task.source_id)
      .single();

    if (cred?.credential_data) {
      try {
        credentials = JSON.parse(cred.credential_data);
      } catch {
        credentials = null;
      }
    }
  }

  // 获取乐檬签名密钥（仅在 collect-lemeng 任务时需要）
  const isLemeng = task.function_slug === 'collect-lemeng';
  const lemengSecret = isLemeng ? process.env.LEMENG_SECRET_KEY || '' : '';

  const response = await fetch(
    `${INSFORGE_API_BASE}/functions/${task.function_slug}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INSFORGE_API_KEY}`
      },
      body: JSON.stringify({
        credentials,
        params: task.params,
        storage_type: task.storage_type,
        storage_path: task.storage_path,
        manual: true,
        secret_key: lemengSecret
      })
    }
  );

  const result = await response.json();
  return NextResponse.json(result);
}

// DELETE - 删除任务
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { error } = await client.database
    .from('collect_tasks')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

function calculateNextRun(cronExpr: string): string {
  const now = new Date();
  const parts = cronExpr.split(' ');

  if (parts[0] === '0' && parts[1] === '*') {
    now.setHours(now.getHours() + 1, 0, 0, 0);
  } else if (parts[0] === '0' && parts[1] === '*/6') {
    const nextHour = Math.ceil((now.getHours() + 1) / 6) * 6;
    now.setHours(nextHour, 0, 0, 0);
  } else if (parts[1] === '2' && parts[2] === '*') {
    now.setDate(now.getDate() + 1);
    now.setHours(2, 0, 0, 0);
  } else {
    now.setHours(now.getHours() + 1);
  }

  return now.toISOString();
}
