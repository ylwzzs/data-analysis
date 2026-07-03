/**
 * Scheduler Edge Function
 * 
 * 功能：查询到期的采集任务，组装凭证和签名密钥，调用对应的采集 Edge Function
 * 
 * 模式：
 * - 自动模式（cron）：查询 next_run_at <= now 的任务
 * - 手动模式（manual + task_id）：直接执行指定任务，不检查 next_run_at
 */

module.exports = async function(req) {
  try {
    console.log('[scheduler] 开始执行...');
    
    const body = await req.json().catch(() => ({}));
    const { manual, task_id } = body;
    
    const postgrestUrl = Deno.env.get('POSTGREST_BASE_URL') || 'http://postgrest:3000';
    const apiKey = Deno.env.get('INSFORGE_API_KEY') || Deno.env.get('ANON_KEY');
    
    if (!apiKey) {
      throw new Error('Missing INSFORGE_API_KEY or ANON_KEY');
    }
    
    // 查询任务
    let queryUrl;
    if (manual && task_id) {
      // 手动模式：直接按 ID 查询，不检查 next_run_at
      queryUrl = `${postgrestUrl}/collect_tasks?select=id,name,source_id,function_slug,params,storage_type,storage_path&id=eq.${task_id}`;
    } else {
      // 自动模式：查询到期的任务
      const now = new Date().toISOString();
      queryUrl = `${postgrestUrl}/collect_tasks?select=id,name,source_id,function_slug,params,storage_type,storage_path&enabled=eq.true&next_run_at=lte.${now}`;
    }
    
    console.log(`[scheduler] Query URL: ${queryUrl}`);
    
    const tasksResponse = await fetch(queryUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    
    if (!tasksResponse.ok) {
      throw new Error(`Failed to query tasks: ${tasksResponse.status}`);
    }
    
    const tasks = await tasksResponse.json();
    console.log(`[scheduler] Found ${tasks.length} tasks`);
    
    if (tasks.length === 0) {
      return new Response(JSON.stringify({ success: true, tasks_processed: 0 }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 处理每个任务
    const results = [];
    const insforgeUrl = Deno.env.get('INSFORGE_API_BASE') || 'http://insforge:7130';
    const startedAt = new Date().toISOString();
    
    for (const task of tasks) {
      console.log(`[scheduler] Processing: ${task.name} (${task.function_slug})`);
      
      try {
        // 1. 获取凭证
        let credentials = null;
        if (task.source_id) {
          const credUrl = `${postgrestUrl}/auth_credentials?select=credential_data&source_id=eq.${task.source_id}`;
          const credResponse = await fetch(credUrl, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
          });
          
          if (credResponse.ok) {
            const credData = await credResponse.json();
            if (credData.length > 0 && credData[0].credential_data) {
              try {
                credentials = JSON.parse(credData[0].credential_data);
                console.log(`[scheduler] Credentials loaded`);
              } catch (e) {
                console.warn(`[scheduler] Failed to parse credentials: ${e.message}`);
              }
            }
          }
        }
        
        // 2. 获取签名密钥
        let secret_key = null;
        if (task.function_slug === 'collect-lemeng') {
          secret_key = Deno.env.get('LEMENG_SECRET_KEY');
          console.log(`[scheduler] LEMENG_SECRET_KEY: ${secret_key ? 'loaded' : 'NOT FOUND'}`);
        }
        
        // 3. 调用目标 Edge Function
        const functionUrl = `${insforgeUrl}/functions/${task.function_slug}`;
        const taskStartedAt = new Date().toISOString();
        
        const functionResponse = await fetch(functionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            task_id: task.id,
            credentials,
            params: task.params || {},
            storage_type: task.storage_type,
            storage_path: task.storage_path,
            secret_key,
            manual: manual || false
          })
        });
        
        const functionResult = await functionResponse.json();
        const taskFinishedAt = new Date().toISOString();
        const durationMs = new Date(taskFinishedAt).getTime() - new Date(taskStartedAt).getTime();
        
        // 4. 更新任务状态
        await fetch(`${postgrestUrl}/collect_tasks?id=eq.${task.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ last_run_at: taskFinishedAt })
        });
        
        // 5. 写入执行日志
        await fetch(`${postgrestUrl}/collect_logs`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            task_id: task.id,
            status: functionResult.success ? 'success' : 'failed',
            started_at: taskStartedAt,
            finished_at: taskFinishedAt,
            duration_ms: durationMs,
            rows_collected: functionResult.rows_collected || 0,
            error_message: functionResult.error || null
          })
        });
        
        results.push({
          task_id: task.id,
          task_name: task.name,
          success: functionResult.success,
          rows_collected: functionResult.rows_collected || 0,
          error: functionResult.error || null
        });
        
        console.log(`[scheduler] Task ${task.name}: ${functionResult.success ? 'success' : 'failed'}`);
        
      } catch (taskError) {
        console.error(`[scheduler] Task ${task.name} failed:`, taskError.message);
        results.push({
          task_id: task.id,
          task_name: task.name,
          success: false,
          error: taskError.message
        });
      }
    }
    
    return new Response(JSON.stringify({
      success: true,
      tasks_processed: tasks.length,
      results,
      timestamp: startedAt
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
