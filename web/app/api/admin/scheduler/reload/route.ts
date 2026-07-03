// web/app/api/admin/scheduler/reload/route.ts
// 重新加载定时调度器（任务配置变更后调用）

import { NextRequest, NextResponse } from 'next/server';
import { reloadScheduler, getScheduledTasks } from '@/lib/scheduler';

export async function POST(req: NextRequest) {
  try {
    await reloadScheduler();

    const tasks = getScheduledTasks();

    return NextResponse.json({
      success: true,
      message: 'Scheduler reloaded',
      tasks: tasks,
    });
  } catch (error: any) {
    console.error('[scheduler-reload] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// 查看当前调度状态
export async function GET(req: NextRequest) {
  try {
    const tasks = getScheduledTasks();

    return NextResponse.json({
      success: true,
      scheduled_count: tasks.length,
      tasks,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}