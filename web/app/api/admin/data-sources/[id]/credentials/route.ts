// web/app/api/admin/data-sources/[id]/credentials/route.ts
import { NextRequest, NextResponse } from 'next/server';

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

  // 调用 Edge Function 加密凭证（因为前端不能访问 ENCRYPTION_KEY）
  // 这里需要调用后端加密服务
  const response = await fetch(
    `${INSFORGE_API_BASE}/functions/encrypt-credentials`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INSFORGE_API_KEY}`
      },
      body: JSON.stringify({
        source_id: sourceId,
        credentials,
        expires_at
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    return NextResponse.json(
      { error: `Failed to encrypt credentials: ${error}` },
      { status: 500 }
    );
  }

  const data = await response.json();
  return NextResponse.json(data);
}
