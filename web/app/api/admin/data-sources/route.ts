// web/app/api/admin/data-sources/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET /api/admin/data-sources - 列表
export async function GET() {
  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { data, error } = await client.database
    .from('data_sources')
    .select(`
      id,
      name,
      description,
      api_endpoint,
      auth_type,
      auth_config,
      enabled,
      auth_credentials(expires_at, last_updated)
    `)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// POST /api/admin/data-sources - 创建
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, api_endpoint, auth_type, auth_config, enabled } = body;

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { data, error } = await client.database
    .from('data_sources')
    .insert([{
      name,
      description,
      api_endpoint,
      auth_type: auth_type || 'none',
      auth_config: auth_config || {},
      enabled: enabled ?? true
    }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// PUT /api/admin/data-sources?id=xxx - 更新
export async function PUT(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const body = await req.json();

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  const { data, error } = await client.database
    .from('data_sources')
    .update(body)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

// DELETE /api/admin/data-sources?id=xxx - 删除
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
    .from('data_sources')
    .delete()
    .eq('id', id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
