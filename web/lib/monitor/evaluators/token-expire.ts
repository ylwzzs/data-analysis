import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';
import { decodeJwtPayload } from '../jwt';

// 乐檬 token 过期前置告警：读 JWT exp claim，算剩余小时，remain < before_hours(默认 24h) 即 firing
// rule.target = source_id（字符串）；alert_key = token:<source_id>
export const evalTokenExpire: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const sourceId = Number(rule.target);
  const beforeHours = Number(rule.threshold?.before_hours ?? 24);
  const alertKey = `token:${sourceId}`;

  const token = await deps.getCredentialToken(sourceId);
  if (!token) return { firing: false, alert_key: alertKey, context: { missing: true, source_id: sourceId } };

  const payload = decodeJwtPayload(token);
  const exp = payload?.exp as number | undefined;
  if (!payload || !exp) return { firing: false, alert_key: alertKey, context: { undecodable: true, source_id: sourceId } };

  const remainHours = (exp - Math.floor(deps.now.getTime() / 1000)) / 3600;
  return {
    firing: remainHours < beforeHours,
    alert_key: alertKey,
    context: { source_id: sourceId, brand: payload.company_id ?? sourceId, remain_hours: Math.round(remainHours), exp_at: exp },
  };
};
