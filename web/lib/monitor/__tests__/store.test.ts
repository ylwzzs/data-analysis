import { describe, it, expect } from 'vitest';
import { MemoryStore, SdkStore } from '../store';

describe('MonitorStore 契约 (MemoryStore)', () => {
  it('upsert 新增 alert', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'svc:duckdb', rule_id: 1, check_type: 'service_down', severity: 'critical', context: { a: 1 } });
    const a = await s.getActiveAlert('svc:duckdb');
    expect(a?.status).toBe('active');
    expect(a?.occurrence_count).toBe(1);
  });

  it('upsert 已存在 alert：occurrence_count++ 且更新 context', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: { n: 1 } });
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: { n: 2 } });
    const a = await s.getActiveAlert('k');
    expect(a?.occurrence_count).toBe(2);
    expect(a?.context.n).toBe(2);
  });

  it('markNotified 更新 last_notify_at', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: {} });
    await s.markNotified('k', new Date('2026-07-08T10:00:00Z'));
    const a = await s.getActiveAlert('k');
    // toISOString() 含毫秒（.000Z）；与 SdkStore 生产实现保持一致，下游 shouldNotify 用 new Date() 解析，格式无关
    expect(a?.last_notify_at).toBe('2026-07-08T10:00:00.000Z');
  });

  it('resolve 置 resolved + resolved_at', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: {} });
    await s.resolveAlert('k', new Date('2026-07-08T11:00:00Z'));
    const a = await s.getActiveAlert('k');
    expect(a).toBeNull(); // active 查不到了
  });

  it('loadRules 按 check_type 过滤 enabled', async () => {
    const s = new MemoryStore();
    s._seedRules([
      { id: 1, name: 'r1', check_type: 'service_down', target: 'duckdb', threshold: {}, severity: 'high', touser: null, template: null, suppress_window_seconds: 1800, enabled: true },
      { id: 2, name: 'r2', check_type: 'service_down', target: 'web', threshold: {}, severity: 'high', touser: null, template: null, suppress_window_seconds: 1800, enabled: false },
    ]);
    const rules = await s.loadRules(['service_down']);
    expect(rules).toHaveLength(1);
    expect(rules[0].target).toBe('duckdb');
  });

  it('reopen：resolved 后再 upsert → 重新 active、occurrence 重置、last_notify 清空', async () => {
    const s = new MemoryStore();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: {} });
    await s.markNotified('k', new Date('2026-07-08T10:00:00Z'));
    await s.resolveAlert('k', new Date('2026-07-08T11:00:00Z'));
    expect(await s.getActiveAlert('k')).toBeNull();
    await s.upsertAlert({ alert_key: 'k', rule_id: 1, check_type: 'service_down', severity: 'high', context: { again: true } });
    const a = await s.getActiveAlert('k');
    expect(a?.status).toBe('active');
    expect(a?.occurrence_count).toBe(1);
    expect(a?.last_notify_at).toBeNull();
    expect(a?.context.again).toBe(true);
  });
});

// SdkStore（生产 PostgREST 路径）reopen：用 mock client 验证 resolved→重开 active，
// 不再 insert 撞唯一键（曾导致 service_down/collect_fail 恢复后再失败 duplicate key）。
function mockSdk(existing: any | null) {
  const calls: any[] = [];
  const result = { data: existing, error: null };
  const b: any = {
    select: () => b,
    update: (patch: any) => { calls.push({ kind: 'update', patch }); return b; },
    insert: (rows: any) => { calls.push({ kind: 'insert', rows }); return b; },
    eq: () => b,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  const client: any = { database: { from: () => b } };
  return { store: new SdkStore(client), calls };
}
const ROW = { alert_key: 'k', rule_id: 1, check_type: 'collect_fail' as const, severity: 'high' as const, context: { e: 'x' } };

describe('SdkStore upsertAlert（mock client）', () => {
  it('无已存在 → insert', async () => {
    const { store, calls } = mockSdk(null);
    await store.upsertAlert(ROW);
    expect(calls.some(c => c.kind === 'insert')).toBe(true);
    expect(calls.some(c => c.kind === 'update')).toBe(false);
  });

  it('active 已存在 → update occurrence+1，不改 status', async () => {
    const { store, calls } = mockSdk({ alert_key: 'k', status: 'active', occurrence_count: 2, context: {} });
    await store.upsertAlert(ROW);
    const upd = calls.find(c => c.kind === 'update');
    expect(upd).toBeTruthy();
    expect(upd.patch.occurrence_count).toBe(3);
    expect(upd.patch.status).toBeUndefined();
  });

  it('resolved 已存在 → 重开 active、occurrence=1、清 last_notify_at（不再 insert）', async () => {
    const { store, calls } = mockSdk({ alert_key: 'k', status: 'resolved', occurrence_count: 5, context: {} });
    await store.upsertAlert(ROW);
    expect(calls.some(c => c.kind === 'insert')).toBe(false);
    const upd = calls.find(c => c.kind === 'update');
    expect(upd).toBeTruthy();
    expect(upd.patch.status).toBe('active');
    expect(upd.patch.occurrence_count).toBe(1);
    expect(upd.patch.last_notify_at).toBeNull();
    expect(upd.patch.resolved_at).toBeNull();
  });
});
