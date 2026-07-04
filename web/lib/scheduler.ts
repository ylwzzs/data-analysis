// web/lib/scheduler.ts
// 定时采集调度器，使用 node-cron 注册任务
// 在首次调用时自动初始化

import cron, { ScheduledTask } from 'node-cron';
import { createClient } from '@insforge/sdk';
import { collectOnce, getYesterdayChina, ALL_BRANCH_NUMS, CollectResult } from './collect';
import { collectItems, CollectItemsResult } from './collect-items';
import { notifyWecom } from './notify';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// 存储已注册的 cron 任务
const scheduledJobs: Map<string, ScheduledTask> = new Map();

// 是否已初始化
let initialized = false;

// 对账重试最大次数
const MAX_VERIFY_RETRIES = 3;

/**
 * 初始化调度器：读取所有启用的任务，注册 cron（自动初始化）
 */
export async function ensureSchedulerInitialized() {
  if (initialized) return;

  console.log('[scheduler] 初始化定时采集调度器...');

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    // 查询所有启用的采集任务
    const { data: tasks, error } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, function_slug, schedule_cron, params, enabled')
      .eq('enabled', true);

    if (error) {
      console.error('[scheduler] 查询任务失败:', error);
      return;
    }

    if (!tasks || tasks.length === 0) {
      console.log('[scheduler] 无启用的采集任务');
      initialized = true;
      return;
    }

    console.log(`[scheduler] 发现 ${tasks.length} 个启用的任务`);

    for (const task of tasks) {
      registerTask(task);
    }

    initialized = true;
    console.log('[scheduler] 调度器初始化完成');
  } catch (err: any) {
    console.error('[scheduler] 初始化异常:', err.message);
  }
}

/**
 * 注册单个任务的 cron
 */
function registerTask(task: {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  schedule_cron: string;
  params: any;
}) {
  // 如果已注册，先取消
  if (scheduledJobs.has(task.id)) {
    scheduledJobs.get(task.id)?.stop();
    scheduledJobs.delete(task.id);
  }

  // 校验 cron 表达式
  if (!task.schedule_cron || !cron.validate(task.schedule_cron)) {
    console.warn(`[scheduler] 任务 ${task.name} 的 cron 表达式无效: ${task.schedule_cron}`);
    return;
  }

  console.log(`[scheduler] 注册任务: ${task.name} (${task.schedule_cron})`);

  // 注册 cron 任务
  const job = cron.schedule(task.schedule_cron, async () => {
    console.log(`[scheduler] ⏰ 定时触发: ${task.name} (${task.id})`);
    await executeTask(task);
  }, {
    timezone: 'Asia/Shanghai'
  });

  scheduledJobs.set(task.id, job);
}

/**
 * 执行单个采集任务（含对账重试）
 * 根据 params.task_type 判断采集类型：
 *   - 'items' → 商品档案采集
 *   - 其他/无 → 订单明细采集
 */
async function executeTask(task: {
  id: string;
  name: string;
  source_id: string;
  function_slug: string;
  params: any;
}) {
  const startedAt = new Date();
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    // 1. 获取凭证
    let credentials: Record<string, string> = {};
    if (task.source_id) {
      const { data: cred } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', task.source_id)
        .single();

      if (cred?.credential_data) {
        try { credentials = JSON.parse(cred.credential_data); } catch { /* ignore */ }
      }
    }

    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) {
      console.error(`[scheduler] 任务 ${task.name}: 无凭证`);
      await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, 'No token configured');
      return;
    }

    // 2. 根据任务类型选择采集逻辑
    const params = task.params || {};

    if (params.task_type === 'items') {
      // ===== 商品档案采集 =====
      console.log(`[scheduler] 商品档案采集: ${task.name}`);
      const branchId = params.branch_id || 28444;
      const pageSize = params.page_size || 200;

      const result = await collectItems(authToken, branchId, pageSize);

      const finishedAt = new Date();
      await client.database
        .from('collect_tasks')
        .update({ last_run_at: finishedAt.toISOString() })
        .eq('id', task.id);

      const finalStatus = result.error ? 'failed' : 'success';
      await writeLog(
        client,
        task.id,
        startedAt,
        finishedAt,
        finalStatus,
        result.collected,
        result.error || undefined,
        { total: result.total }
      );

      console.log(`[scheduler] 商品档案采集完成: ${result.collected}/${result.total} 条 ${result.error ? '❌' : '✅'}`);
      return;
    }

    // ===== 订单明细采集（默认） =====
    const dates = params.dates || [getYesterdayChina(), getYesterdayChina()];
    const branchNums = params.branch_nums || ALL_BRANCH_NUMS;
    const branchNumsStr = branchNums.join(',');
    const pageSize = params.page_size || 200;

    console.log(`[scheduler] 任务 ${task.name}: dates=${dates[0]}, branches=${branchNums.length}`);

    // 3. 对账重试循环
    let lastResult: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '' };
    let verified = false;
    let retryCount = 0;

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);

      lastResult = await collectOnce(authToken, branchNums, branchNumsStr, dates, pageSize);

      // Token 过期直接退出
      if (lastResult.error.startsWith('Token expired')) {
        await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
        await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
        return;
      }

      // 无数据直接退出
      if (lastResult.apiTotal === 0) {
        await writeLog(client, task.id, startedAt, new Date(), 'success', 0);
        return;
      }

      // 对账
      const missing = lastResult.apiTotal - lastResult.records.length;
      verified = lastResult.records.length >= lastResult.apiTotal;

      if (verified) {
        console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`);
        break;
      }

      retryCount = attempt;

      if (attempt < MAX_VERIFY_RETRIES) {
        console.warn(`[scheduler] ⚠️ 对账失败: 缺少 ${missing} 条，5 秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次均失败: 缺少 ${missing} 条`);
        await notifyWecom(
          '❌ 定时采集不完整（已重试3次）',
          `**任务**: ${task.name}\n**日期**: ${dates[0]}\n**采集数**: ${lastResult.records.length}\n**API总数**: ${lastResult.apiTotal}\n**缺少**: ${missing} 条\n**建议**: 请检查网络或手动重新采集`
        );
        lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): 缺少 ${missing} 条`;
      }
    }

    // 4. 更新任务状态
    const finishedAt = new Date();
    await client.database
      .from('collect_tasks')
      .update({ last_run_at: finishedAt.toISOString() })
      .eq('id', task.id);

    const finalStatus = lastResult.error ? 'partial' : 'success';
    await writeLog(
      client,
      task.id,
      startedAt,
      finishedAt,
      finalStatus,
      lastResult.records.length,
      lastResult.error || undefined,
      lastResult.storagePath || undefined,
      { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified }
    );

    console.log(`[scheduler] 任务 ${task.name}: ${finalStatus} (${lastResult.records.length} 条) ${verified ? '✅' : '❌'}`);

  } catch (error: any) {
    console.error(`[scheduler] 任务 ${task.name} 异常:`, error.message);
    await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, error.message);
    await notifyWecom('❌ 定时采集异常', `**任务**: ${task.name}\n**错误**: ${error.message}`);
  }
}

/**
 * 写入采集日志
 */
async function writeLog(
  client: any,
  taskId: string,
  startedAt: Date,
  finishedAt: Date,
  status: string,
  rowsCollected: number,
  errorMessage?: string,
  storagePath?: string,
  verification?: { api_total: number; missing: number; verified: boolean }
) {
  await client.database
    .from('collect_logs')
    .insert([{
      task_id: taskId,
      status: status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rows_collected: rowsCollected,
      error_message: errorMessage || null,
      response_summary: storagePath ? {
        storage_path: storagePath,
        verification: verification || null,
      } : null,
    }]);
}

/**
 * 重新加载调度器（任务配置变更后调用）
 */
export async function reloadScheduler() {
  console.log('[scheduler] 重新加载调度器...');

  // 停止所有任务
  for (const [id, job] of scheduledJobs) {
    job.stop();
    console.log(`[scheduler] 停止任务: ${id}`);
  }
  scheduledJobs.clear();

  // 重置初始化标记，重新初始化
  initialized = false;
  await ensureSchedulerInitialized();
}

/**
 * 获取已注册的任务列表
 */
export function getScheduledTasks() {
  return Array.from(scheduledJobs.entries()).map(([id, job]) => ({
    task_id: id,
    running: job.getStatus() === 'scheduled'
  }));
}