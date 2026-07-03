// web/app/api/admin/data-sources/[id]/credentials/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// POST /api/admin/data-sources/[id]/credentials - 更新凭证
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sourceId } = await params;
  const body = await req.json();
  const { credentials, expires_at } = body;

  const client = createClient({
    baseUrl: INSFORGE_API_BASE,
    anonKey: INSFORGE_API_KEY,
  });

  // 先删除旧凭证
  await client.database
    .from('auth_credentials')
    .delete()
    .eq('source_id', sourceId);

  // 插入新凭证（暂不加密，后续迭代）
  const { data, error } = await client.database
    .from('auth_credentials')
    .insert([{
      source_id: sourceId,
      credential_data: JSON.stringify(credentials),
      expires_at: expires_at || null
    }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, expires_at: expires_at || null });
}
