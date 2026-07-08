import { notifyWecom } from '../notify';
import { renderTemplate } from './lifecycle';
import type { MonitorRule, EvalResult, Severity } from './types';

const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡' };

// 解析收件人（@default → env NOTIFY_DEFAULT_TUSERS）；当前 wecom-notify 用默认收件人，
// 此函数暂作记录/日志，留待 Phase B 按 touser 分发
export function resolveTouser(touser: string | null | undefined): string {
  if (!touser || touser === '@default') return process.env.NOTIFY_DEFAULT_TUSERS || '';
  return touser;
}

export interface DispatchOpts {
  recovered?: boolean;
}

// 组装标题/正文，走主通道 notifyWecom
export async function dispatchAlert(rule: MonitorRule, result: EvalResult, opts: DispatchOpts = {}): Promise<void> {
  const icon = opts.recovered ? '✅' : SEVERITY_ICON[rule.severity] ?? '🔴';
  const verb = opts.recovered ? '已恢复' : '告警';
  const title = `${icon} [${rule.severity}] ${rule.name} ${verb}`;
  // 异常路径（token 缺失/不可解析等）evaluator 会给完整 message，覆盖模板渲染，避免占位符渲染异常
  const content = result.message ?? renderTemplate(rule.template, result.context, `${rule.check_type}: ${result.alert_key}`);
  const touser = resolveTouser(rule.touser);
  console.log(`[monitor] dispatch → ${touser || '(default)'}: ${title}`);
  await notifyWecom(title, content);
}
