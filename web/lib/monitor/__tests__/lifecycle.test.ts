import { describe, it, expect } from 'vitest';
import { shouldNotify, isRecovery, renderTemplate } from '../lifecycle';

describe('shouldNotify', () => {
  const now = new Date('2026-07-08T10:00:00Z');
  it('从未通知过 → true', () => {
    expect(shouldNotify({ last_notify_at: null } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(true);
  });
  it('窗口内已通知 → false', () => {
    expect(shouldNotify({ last_notify_at: '2026-07-08T09:50:00Z' } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(false);
  });
  it('超过窗口 → true', () => {
    expect(shouldNotify({ last_notify_at: '2026-07-08T09:00:00Z' } as any, { suppress_window_seconds: 1800 } as any, now)).toBe(true);
  });
});

describe('isRecovery', () => {
  it('曾 active 且本次不 firing → 恢复', () => {
    expect(isRecovery({ status: 'active' } as any, { firing: false } as any)).toBe(true);
  });
  it('曾 active 且仍 firing → 非恢复', () => {
    expect(isRecovery({ status: 'active' } as any, { firing: true } as any)).toBe(false);
  });
  it('无 active 行 → 非恢复', () => {
    expect(isRecovery(null, { firing: false } as any)).toBe(false);
  });
});

describe('renderTemplate', () => {
  it('占位符替换', () => {
    expect(renderTemplate('乐檬-{brand} 剩 {remain_hours}h', { brand: '3120', remain_hours: 24 })).toBe('乐檬-3120 剩 24h');
  });
  it('无模板时给默认', () => {
    expect(renderTemplate(null, { x: 1 }, '默认')).toBe('默认');
  });
  it('缺失字段保留原占位符不崩', () => {
    expect(renderTemplate('{a}/{b}', { a: '1' })).toBe('1/{b}');
  });
});
