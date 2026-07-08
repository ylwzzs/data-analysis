import { NextResponse } from 'next/server';

// web 应用存活探针（service_down 监控用）。仅 liveness；依赖深度检查归 service_down 各 evaluator。
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'web' });
}
