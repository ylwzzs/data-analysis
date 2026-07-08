import type { CheckType, Evaluator } from '../types';
import { evalServiceDown } from './service-down';
import { evalTokenExpire } from './token-expire';

// check_type → evaluator 注册表。Phase A 注册两个；Phase B 追加其余五种。
export const EVALUATORS: Partial<Record<CheckType, Evaluator>> = {
  service_down: evalServiceDown,
  token_expire: evalTokenExpire,
};
