// web/app/api/admin/collect-stats/route.ts
import { NextResponse } from 'next/server';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET - 统计数据
export async function GET() {
  // 调用 PostgreSQL RPC 函数获取聚合统计
  const response = await fetch(
    `${INSFORGE_API_BASE}/rpc/collect_stats`,
    {
      headers: {
        'Authorization': `Bearer ${INSFORGE_API_KEY}`
      }
    }
  );

  if (!response.ok) {
    // 如果 RPC 不存在，返回默认值
    return NextResponse.json({
      total: 0,
      enabled: 0,
      disabled: 0,
      success_today: 0,
      failed_today: 0,
      avg_duration_ms: 0
    });
  }

  const data = await response.json();
  return NextResponse.json(data);
}
