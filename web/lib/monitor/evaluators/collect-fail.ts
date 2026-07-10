import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';

// 采集连续失败告警（架构 §8.1 / spec §4.2）
// rule.target = task_id（collect_tasks.id）；读 collect_logs 最近 window 条，
// 从最新向前数连续 failed/partial 段，>= consecutive 即 firing。
// alert_key = collect:<task_id>；context = {task_id, consecutive_count, window, last_status, last_error}
// 无日志（任务未跑过）不告警；rule.name 承载人类可读任务名（dispatchAlert 用作标题）。
export const evalCollectFail: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const taskId = rule.target ?? '';
  const consecutive = Number(rule.threshold?.consecutive ?? 3);
  const window = Number(rule.threshold?.window ?? 5);
  const alertKey = `collect:${taskId}`;

  if (!taskId) {
    return { firing: false, alert_key: alertKey, context: { reason: 'rule 缺 target(task_id)' } };
  }

  const logs = await deps.getCollectLogs(taskId, window);
  if (!logs || logs.length === 0) {
    return { firing: false, alert_key: alertKey, context: { task_id: taskId, reason: '该任务尚无采集日志' } };
  }

  // 数组首条为最新；从最新向前数连续失败段
  let consecutiveCount = 0;
  for (const l of logs) {
    if (l.status === 'failed' || l.status === 'partial') {
      consecutiveCount++;
    } else {
      break;
    }
  }

  return {
    firing: consecutiveCount >= consecutive && consecutiveCount > 0,
    alert_key: alertKey,
    context: {
      task_id: taskId,
      consecutive_count: consecutiveCount,
      window,
      last_status: logs[0]?.status,
      last_error: (logs[0]?.error_message ?? '').slice(0, 200),
    },
  };
};
