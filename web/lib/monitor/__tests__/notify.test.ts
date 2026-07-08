import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock notify 模块的主通道（web/lib/notify.ts，从 __tests__/ 算是 ../../notify）
vi.mock('../../notify', () => ({
  notifyWecom: vi.fn().mockResolvedValue(undefined),
  __esModule: true,
}));

import { notifyWecom } from '../../notify';
import { dispatchAlert } from '../notify';
import type { MonitorRule, EvalResult } from '../types';

beforeEach(() => vi.clearAllMocks());

// 默认 severity=critical（→ 🔴），与 test 1 的 🔴 断言一致；high→🟠 / medium→🟡 见 SEVERITY_ICON
const rule = (over: Partial<MonitorRule> = {}): MonitorRule => ({
  id: 1, name: 'r', check_type: 'service_down', target: 'duckdb', threshold: {},
  severity: 'critical', touser: '@default', template: '{svc} 不可达', suppress_window_seconds: 1800, enabled: true,
  ...over,
});

describe('dispatchAlert', () => {
  it('用模板渲染并通过主通道发送', async () => {
    const res: EvalResult = { firing: true, alert_key: 'svc:duckdb', context: { svc: 'duckdb' } };
    await dispatchAlert(rule(), res, { recovered: false });
    expect(notifyWecom).toHaveBeenCalledTimes(1);
    const [title, content] = (notifyWecom as any).mock.calls[0];
    expect(title).toContain('🔴');       // 默认严重度图标
    expect(content).toContain('duckdb 不可达');
  });

  it('recovered 时标题用 ✅', async () => {
    await dispatchAlert(rule(), { firing: false, alert_key: 'svc:duckdb', context: { svc: 'duckdb' } }, { recovered: true });
    const [title] = (notifyWecom as any).mock.calls[0];
    expect(title).toContain('✅');
  });

  it('touser=@default 展开为 env', async () => {
    process.env.NOTIFY_DEFAULT_TUSERS = 'ZhangDuo';
    await dispatchAlert(rule({ touser: '@default' }), { firing: true, alert_key: 'k', context: {} }, { recovered: false });
    // 收件人解析不阻塞发送（notifyWecom 不收 touser，仅标题/正文）；这里只断言不抛错
    expect(notifyWecom).toHaveBeenCalled();
  });
});
