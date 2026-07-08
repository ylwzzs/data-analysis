import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { notifyWecomDirect } from '../notify-direct';

beforeEach(() => {
  fetchMock.mockReset();
  process.env.WECOM_CORP_ID = 'corp1';
  process.env.WECOM_OPS_SECRET = 'sec1';
  process.env.WECOM_OPS_AGENT_ID = '1000009';
  process.env.NOTIFY_DEFAULT_TUSERS = 'ZhangDuo';
});
afterEach(() => { delete process.env.WECOM_CORP_ID; delete process.env.WECOM_OPS_SECRET; delete process.env.WECOM_OPS_AGENT_ID; });

describe('notifyWecomDirect', () => {
  it('先取 token 再发 message/send', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'TOK', errcode: 0 }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) } as any);

    await notifyWecomDirect('标题', '正文');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokenUrl = fetchMock.mock.calls[0][0];
    expect(tokenUrl).toContain('gettoken');
    expect(tokenUrl).toContain('corpid=corp1');
    expect(tokenUrl).toContain('corpsecret=sec1');
    const sendOpts = fetchMock.mock.calls[1][1];
    const body = JSON.parse(sendOpts.body);
    expect(body.agentid).toBe('1000009');
    expect(body.touser).toBe('ZhangDuo');
    expect(body.text.content).toBe('标题\n正文');
  });

  it('gettoken 失败时抛错且不发 send', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: '', errcode: 40013, errmsg: 'invalid' }) } as any);
    await expect(notifyWecomDirect('t', 'c')).rejects.toThrow(/access_token/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
