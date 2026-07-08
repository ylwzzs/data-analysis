import type { MonitorRule } from './types';

export interface ActiveAlert {
  status: string;
  last_notify_at: string | null;
}

// 是否到该发通知（suppress 窗口外，或从未发过）
export function shouldNotify(
  alert: ActiveAlert | null,
  rule: Pick<MonitorRule, 'suppress_window_seconds'>,
  now: Date
): boolean {
  if (!alert || !alert.last_notify_at) return true;
  const last = new Date(alert.last_notify_at).getTime();
  return now.getTime() - last >= rule.suppress_window_seconds * 1000;
}

// active → 恢复判定
export function isRecovery(active: ActiveAlert | null, result: { firing: boolean }): boolean {
  return !!active && active.status === 'active' && !result.firing;
}

// 模板渲染：{key} → context[key]；缺失字段保留 {key}
export function renderTemplate(
  template: string | null | undefined,
  context: Record<string, any>,
  fallback = ''
): string {
  if (!template) return fallback;
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in context ? String(context[key]) : m));
}
