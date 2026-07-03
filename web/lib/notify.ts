// web/lib/notify.ts
// 企微告警通知

export async function notifyWecom(title: string, content: string) {
  const corpid = process.env.WECOM_CORP_ID;
  const secret = process.env.WECOM_SECRET;
  const agentid = process.env.WECOM_AGENT_ID;

  if (!corpid || !secret || !agentid) {
    console.warn('[notifyWecom] Missing WeChat work credentials');
    return;
  }

  try {
    // 获取 access_token
    const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${secret}`);
    const tokenData = await tokenRes.json();

    if (tokenData.errcode !== 0) {
      console.error('[notifyWecom] Failed to get token:', tokenData.errmsg);
      return;
    }

    const accessToken = tokenData.access_token;

    // 发送应用消息
    const sendRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: 'ZhangDuo',
        msgtype: 'markdown',
        agentid: parseInt(agentid),
        markdown: { content: `### ${title}\n${content}` },
      }),
    });

    const sendData = await sendRes.json();
    if (sendData.errcode !== 0) {
      console.error('[notifyWecom] Failed to send:', sendData.errmsg);
    } else {
      console.log('[notifyWecom] Notification sent');
    }
  } catch (err: any) {
    console.error('[notifyWecom] Error:', err.message);
  }
}