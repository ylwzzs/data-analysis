import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probe } from '../probe';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
beforeEach(() => fetchMock.mockReset());

describe('probe', () => {
  it('200 → ok', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as any);
    const r = await probe('http://x/health');
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('非 200 → not ok 带 status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as any);
    const r = await probe('http://x/health');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });

  it('抛错 → not ok 带 error', async () => {
    // NOTE: vitest 4.x flags persistent `mockRejectedValue` as an unhandled rejection
    // even when awaited inside try/catch; `mockRejectedValueOnce` asserts identical
    // behavior (fetch is called exactly once here) without the harness friction.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await probe('http://x/health');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
