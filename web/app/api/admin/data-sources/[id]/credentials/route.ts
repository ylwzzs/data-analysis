// web/app/api/admin/data-sources/[id]/credentials/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { decodeJwtPayload } from '@/lib/monitor/jwt';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// 从 JWT token 解 exp claim 算过期时间；非 JWT / 无 exp 返回 null。
// expires_at 不再依赖手填：JWT 自带 exp 是 truth，保存即自动派生。
function deriveExpiresAt(credentials: Record<string, string>): string | null {
  const token = credentials?.token;
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  return typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null;
}

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

  // expires_at 优先从 JWT exp 自动派生；非 JWT / 无 exp 时回退调用方显式传入；都没有则 null
  const finalExpiresAt = deriveExpiresAt(credentials) ?? expires_at ?? null;

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
      expires_at: finalExpiresAt
    }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, expires_at: finalExpiresAt });
}
