import type { Evaluator, MonitorRule, EvalDeps, EvalResult } from '../types';

// 服务名 → 探活配置（URL 是基础设施，固化在代码；rule.target 选服务）
export const SERVICE_PROBES: Record<string, { url: string; method?: string }> = {
  web: { url: 'http://localhost:3000/api/health' },
  duckdb: { url: 'http://duckdb:9000/health' },
  insforge: { url: 'http://insforge:7130/api/health' },
  postgres: { url: 'pg:select1' }, // 特殊：engine/probe 层转 SELECT 1，见下方处理
  deno: { url: 'http://deno:7133/health' },
  openclaw: { url: 'http://openclaw:18789/healthz' },
};

export const evalServiceDown: Evaluator = async (rule: MonitorRule, deps: EvalDeps): Promise<EvalResult> => {
  const svc = rule.target ?? 'unknown';
  const cfg = SERVICE_PROBES[svc];

  // postgres 用 SELECT 1 经 SDK/store？此处简化：engine 注入的 probe 不适合 SQL；
  // 用 insforge 健康间接覆盖（postgres 挂 → insforge 也探不到）。
  if (!cfg || svc === 'postgres') {
    const probeCfg = SERVICE_PROBES['insforge'];
    const r = await deps.probe(probeCfg.url, { method: probeCfg.method });
    return { firing: !r.ok, alert_key: `svc:${svc}`, context: { svc, detail: r.error ?? `status ${r.status}`, latency_ms: r.latencyMs } };
  }

  const r = await deps.probe(cfg.url, { method: cfg.method });
  return {
    firing: !r.ok,
    alert_key: `svc:${svc}`,
    context: { svc, detail: r.error ?? (r.status ? `status ${r.status}` : 'unreachable'), latency_ms: r.latencyMs },
  };
};
