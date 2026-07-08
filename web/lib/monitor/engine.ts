import type { CheckType, EvalDeps, EvalResult, Evaluator, MonitorRule } from './types';
import type { MonitorStore } from './store';
import { shouldNotify, isRecovery } from './lifecycle';
import { dispatchAlert } from './notify';
import { notifyWecomDirect } from './notify-direct';

const INSFORGE_ALERT_KEY = 'svc:insforge';

// 一轮扫描：load rules → 逐条 eval → 生命周期/降噪 → dispatch
// registry 注入（默认正式 EVALUATORS），便于测试
export async function runScan(
  store: MonitorStore,
  checkTypes: CheckType[],
  deps: EvalDeps,
  registry: Partial<Record<CheckType, Evaluator>>,
): Promise<void> {
  const rules = await store.loadRules(checkTypes);
  for (const rule of rules) {
    const evaluator = registry[rule.check_type];
    if (!evaluator) {
      console.warn(`[monitor] 无 ${rule.check_type} evaluator，跳过规则 ${rule.name}`);
      continue;
    }
    try {
      const result = await evaluator(rule, deps);
      await applyResult(store, rule, result, deps.now);
    } catch (e: any) {
      // per-rule 隔离：单条规则崩不拖垮整轮
      console.error(`[monitor] evaluator 异常 rule=${rule.name}(${rule.check_type}):`, e?.message ?? e);
    }
  }
}

async function applyResult(store: MonitorStore, rule: MonitorRule, result: EvalResult, now: Date): Promise<void> {
  const active = await store.getActiveAlert(result.alert_key);

  if (result.firing) {
    await store.upsertAlert({
      alert_key: result.alert_key,
      rule_id: rule.id,
      check_type: rule.check_type,
      severity: rule.severity,
      context: result.context,
    });
    const updated = await store.getActiveAlert(result.alert_key);
    if (shouldNotify(updated, rule, now)) {
      try {
        await dispatchAlert(rule, result, { recovered: false });
        // InsForge-down 兜底：额外直连
        if (result.alert_key === INSFORGE_ALERT_KEY) {
          await notifyWecomDirect(`🔴 [critical] ${rule.name} 告警`, `${result.alert_key} 不可达`);
        }
        await store.markNotified(result.alert_key, now);
      } catch (e: any) {
        console.error(`[monitor] dispatch 失败 ${result.alert_key}:`, e?.message ?? e);
      }
    }
  } else if (isRecovery(active, result)) {
    await store.resolveAlert(result.alert_key, now);
    try {
      await dispatchAlert(rule, result, { recovered: true });
    } catch (e: any) {
      console.error(`[monitor] recovery dispatch 失败 ${result.alert_key}:`, e?.message ?? e);
    }
  }
}
