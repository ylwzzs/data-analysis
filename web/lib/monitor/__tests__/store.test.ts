import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store';

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
});
