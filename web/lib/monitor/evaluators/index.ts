import type { CheckType, Evaluator } from '../types';
import { evalServiceDown } from './service-down';
import { evalTokenExpire } from './token-expire';
import { evalCollectFail } from './collect-fail';

// check_type → evaluator 注册表。Phase A：service_down/token_expire；Phase B 起追加 collect_fail（其余待填）。
export const EVALUATORS: Partial<Record<CheckType, Evaluator>> = {
  service_down: evalServiceDown,
  token_expire: evalTokenExpire,
  collect_fail: evalCollectFail,
};
