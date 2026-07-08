import type { ProbeOutcome } from './types';

// 应用级探活：fetch + 超时（AbortController），永不抛——失败返回 { ok:false, error }
export async function probe(url: string, opts: { timeoutMs?: number; method?: string } = {}): Promise<ProbeOutcome> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: opts.method ?? 'GET', signal: controller.signal });
    return { ok: resp.ok, status: resp.status, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}
