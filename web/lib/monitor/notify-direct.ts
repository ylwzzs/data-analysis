// InsForge-down 兜底：web 直连企微 message/send，绕开 functions/wecom-notify（架构 §8.1 / spec §6.2）
// 仅当 service_down 探到 insforge 不可达时由 engine 调用。
const QYAPI = 'https://qyapi.weixin.qq.com/cgi-bin';

async function getAccessToken(): Promise<string> {
  const corpid = process.env.WECOM_CORP_ID;
  const corpsecret = process.env.WECOM_OPS_SECRET;
  if (!corpid || !corpsecret) throw new Error('notifyWecomDirect: missing WECOM_CORP_ID/WECOM_OPS_SECRET');
  const url = `${QYAPI}/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(corpsecret)}`;
  const resp = await fetch(url);
  const data = await resp.json() as any;
  if (!data.access_token) throw new Error(`notifyWecomDirect: gettoken returned no access_token (${data.errcode} ${data.errmsg})`);
  return data.access_token as string;
}

export async function notifyWecomDirect(title: string, content: string): Promise<void> {
  const agentid = process.env.WECOM_OPS_AGENT_ID;
  const touser = process.env.NOTIFY_DEFAULT_TUSERS || '';
  if (!agentid) throw new Error('notifyWecomDirect: missing WECOM_OPS_AGENT_ID');
  const token = await getAccessToken();
  const url = `${QYAPI}/message/send?access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser,
      msgtype: 'text',
      agentid,
      text: { content: `${title}\n${content}` },
    }),
  });
  const data = await resp.json() as any;
  if (data.errcode !== 0) throw new Error(`notifyWecomDirect: send failed ${data.errcode} ${data.errmsg}`);
}
