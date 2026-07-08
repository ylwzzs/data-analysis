import { describe, it, expect } from 'vitest';
import { evalTokenExpire } from '../token-expire';
import type { MonitorRule, EvalDeps } from '../../types';

const now = new Date('2026-07-08T10:00:00Z'); // epoch ms = 1751971200000

// 造一个 exp 在 now 之后 N 小时的 token
const tokenWithExp = (expSec: number) => {
  const payload = Buffer.from(JSON.stringify({ company_id: 3120, exp: expSec })).toString('base64url');
  return `h.${payload}.s`;
};

const rule = (beforeHours: number, sourceId: number): MonitorRule => ({
  id: 1, name: 'token', check_type: 'token_expire', target: String(sourceId), threshold: { before_hours: beforeHours },
  severity: 'critical', touser: '@default', template: '乐檬-{brand} token 剩 {remain_hours}h',
  suppress_window_seconds: 3600, enabled: true,
});

const deps = (token: string | null): EvalDeps => ({
  now,
  probe: async () => ({ ok: true, latencyMs: 1 }),
  getCredentialToken: async () => token,
});

describe('evalTokenExpire', () => {
  it('剩 2h，阈值 24h → firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 2 * 3600;
    const r = await evalTokenExpire(rule(24, 3120), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(true);
    expect(r.alert_key).toBe('token:3120');
    expect(r.context.remain_hours).toBeCloseTo(2, 0);
    expect(r.context.brand).toBe(3120);
  });

  it('剩 48h，阈值 24h → 不 firing', async () => {
    const exp = Math.floor(now.getTime() / 1000) + 48 * 3600;
    const r = await evalTokenExpire(rule(24, 3120), deps(tokenWithExp(exp)));
    expect(r.firing).toBe(false);
  });

  it('无凭证 → 不 firing（context 标 missing），不误报', async () => {
    const r = await evalTokenExpire(rule(24, 3120), deps(null));
    expect(r.firing).toBe(false);
    expect(r.context.missing).toBe(true);
  });

  it('token 无法解码 exp → 不 firing，context 标 undecodable', async () => {
    const r = await evalTokenExpire(rule(24, 3120), deps('not-a-jwt'));
    expect(r.firing).toBe(false);
    expect(r.context.undecodable).toBe(true);
  });
});
