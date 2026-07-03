/**
 * Scheduler Edge Function
 *
 * 功能：查询到期的采集任务，调用对应的采集 API
 *
 * 模式：
 * - 自动模式（cron）：查询 next_run_at <= now 的任务
 * - 手动模式（manual + task_id）：直接执行指定任务
 *
 * 目标：
 * - 优先调用 Next.js API Route（/api/admin/collect-lemeng）
 * - 兼容旧版 Edge Function
 */

module.exports = async function(req) {
  try {
    console.log('[scheduler] 开始执行...');

    const body = await req.json().catch(() => ({}));
    const { manual, task_id } = body;

    const postgrestUrl = Deno.env.get('POSTGREST_BASE_URL') || 'http://postgrest:3000';
    const apiKey = Deno.env.get('INSFORGE_API_KEY') || Deno.env.get('ANON_KEY');
    const webUrl = Deno.env.get('WEB_URL') || 'http://web:3000';

    if (!apiKey) {
      throw new Error('Missing INSFORGE_API_KEY or ANON_KEY');
    }

    // 查询任务
    let queryUrl;
    if (manual && task_id) {
      // 手动模式：直接按 ID 查询
      queryUrl = `${postgrestUrl}/collect_tasks?select=id,name,source_id,function_slug,params,storage_type,storage_path,schedule_cron&id=eq.${task_id}`;
    } else {
      // 自动模式：查询到期的任务
      const now = new Date().toISOString();
      queryUrl = `${postgrestUrl}/collect_tasks?select=id,name,source_id,function_slug,params,storage_type,storage_path,schedule_cron&enabled=eq.true&next_run_at=lte.${now}`;
    }

    console.log(`[scheduler] Query URL: ${queryUrl}`);

    const tasksResponse = await fetch(queryUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    if (!tasksResponse.ok) {
      throw new Error(`Failed to query tasks: ${tasksResponse.status}`);
    }

    const tasks = await tasksResponse.json();
    console.log(`[scheduler] Found ${tasks.length} tasks to execute`);

    if (tasks.length === 0) {
      return new Response(JSON.stringify({ success: true, tasks_processed: 0 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 处理每个任务
    const results = [];
    const executedAt = new Date().toISOString();

    for (const task of tasks) {
      console.log(`[scheduler] Processing: ${task.name} (${task.function_slug})`);

      const taskStartedAt = new Date();

      try {
        // 根据采集类型选择调用方式
        let functionResult;

        if (task.function_slug === 'collect-lemeng') {
          // 调用 Next.js API Route
          const apiUrl = `${webUrl}/api/admin/collect-lemeng`;
          console.log(`[scheduler] Calling Next.js API: ${apiUrl}`);

          const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ task_id: task.id })
          });

          functionResult = await apiResponse.json();
        } else {
          // 兼容旧版：调用 Edge Function
          const insforgeUrl = Deno.env.get('INSFORGE_API_BASE') || 'http://insforge:7130';
          const functionUrl = `${insforgeUrl}/functions/${task.function_slug}`;

          // 获取凭证
          let credentials = null;
          if (task.source_id) {
            const credUrl = `${postgrestUrl}/auth_credentials?select=credential_data&source_id=eq.${task.source_id}`;
            const credResponse = await fetch(credUrl, {
              headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (credResponse.ok) {
              const credData = await credResponse.json();
              if (credData[0]?.credential_data) {
                credentials = JSON.parse(credData[0].credential_data);
              }
            }
          }

          const functionResponse = await fetch(functionUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              task_id: task.id,
              credentials,
              params: task.params || {}
            })
          });

          functionResult = await functionResponse.json();
        }

        const taskFinishedAt = new Date();
        const durationMs = taskFinishedAt.getTime() - taskStartedAt.getTime();

        // 更新任务状态
        await fetch(`${postgrestUrl}/collect_tasks?id=eq.${task.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            last_run_at: taskFinishedAt.toISOString(),
            // 计算下次运行时间（简化版：加 24 小时）
            next_run_at: task.schedule_cron ? calculateNextRun(task.schedule_cron) : null
          })
        });

        results.push({
          task_id: task.id,
          task_name: task.name,
          success: functionResult.success,
          rows_collected: functionResult.rows_collected || 0,
          verification: functionResult.verification,
          duration_ms: durationMs,
          error: functionResult.error || null
        });

        console.log(`[scheduler] Task ${task.name}: ${functionResult.success ? 'success' : 'failed'} (${durationMs}ms)`);

      } catch (taskError) {
        console.error(`[scheduler] Task ${task.name} failed:`, taskError.message);

        const taskFinishedAt = new Date();

        // 写入失败日志
        await fetch(`${postgrestUrl}/collect_logs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            task_id: task.id,
            status: 'failed',
            started_at: taskStartedAt.toISOString(),
            finished_at: taskFinishedAt.toISOString(),
            duration_ms: taskFinishedAt.getTime() - taskStartedAt.getTime(),
            error_message: taskError.message
          })
        });

        results.push({
          task_id: task.id,
          task_name: task.name,
          success: false,
          error: taskError.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log(`[scheduler] 完成: ${successCount} 成功, ${failedCount} 失败`);

    return new Response(JSON.stringify({
      success: true,
      tasks_processed: tasks.length,
      success_count: successCount,
      failed_count: failedCount,
      results,
      executed_at: executedAt
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[scheduler] Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

/**
 * 简化版 cron 解析（只支持每天固定时间）
 * 格式: "0 2 * * *" → 明天凌晨 2 点
 */
function calculateNextRun(cronExpr) {
  if (!cronExpr) return null;

  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour] = parts.map(p => {
    if (p === '*') return null;
    return parseInt(p, 10);
  });

  if (minute === null || hour === null) return null;

  // 计算下次运行时间（明天同一时刻）
  const now = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);

  // 如果已经过了今天的执行时间，设置为明天
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.toISOString();
}
