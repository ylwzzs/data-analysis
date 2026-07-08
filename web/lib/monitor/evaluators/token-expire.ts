import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';
import { decodeJwtPayload } from '../jwt';

// 乐檬 token 过期前置告警：读 JWT exp claim，算剩余小时，remain < before_hours(默认 24h) 即 firing
// rule.target = source_id（UUID 字符串，data_sources.id）；alert_key = token:<source_id>
// 异常（token 缺失 / 无法解析）也 firing：否则引擎会把此前 active 的告警当"恢复"自动 resolve，
// 发误导性 ✅ 已恢复并致盲（曾发生：credential 被清成 {} → 假恢复）。
export const evalTokenExpire: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const sourceId = rule.target ?? '';
  const beforeHours = Number(rule.threshold?.before_hours ?? 24);
  const alertKey = `token:${sourceId}`;

  const token = await deps.getCredentialToken(sourceId);
  if (!token) {
    return {
      firing: true,
      alert_key: alertKey,
      context: { missing: true, source_id: sourceId },
      message: `token 缺失：auth_credentials 未存可用 token，采集与监控将失效（source ${sourceId}）`,
    };
  }

  const payload = decodeJwtPayload(token);
  const exp = payload?.exp as number | undefined;
  if (!payload || !exp) {
    return {
      firing: true,
      alert_key: alertKey,
      context: { undecodable: true, source_id: sourceId },
      message: `token 无法解析（非 JWT 或缺 exp claim），请检查凭证格式（source ${sourceId}）`,
    };
  }

  const remainHours = (exp - Math.floor(deps.now.getTime() / 1000)) / 3600;
  return {
    firing: remainHours < beforeHours,
    alert_key: alertKey,
    context: { source_id: sourceId, brand: payload.company_id ?? sourceId, remain_hours: Math.round(remainHours), exp_at: exp },
  };
};
