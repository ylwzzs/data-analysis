// functions/wecom-notify/index.js
// 统一消息通知服务（架构文档 §7.1.1）：所有系统告警/通知收口到此，用 App B（全员可见）发送。
// 调用方：① web notifyWecom（薄客户端，@insforge/sdk invoke）② OpenClaw 主动通知。
// 鉴权：body.agent_api_key === AGENT_API_KEY（与 agent-query 同款，防 anon_key 滥用）。
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / WECOM_OPS_AGENT_ID / NOTIFY_DEFAULT_TUSERS / AGENT_API_KEY
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno）。

module.exports = async function (req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ① 解析 body
  let body = {};
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  // ② 鉴权：agent_api_key
  const apiKey = Deno.env.get("AGENT_API_KEY");
  if (!apiKey || body.agent_api_key !== apiKey) {
    return json({ error: "unauthorized" }, 401);
  }

  // ③ 参数与 secret
  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
  const agentId = Deno.env.get("WECOM_OPS_AGENT_ID");
  const defaultTusers = Deno.env.get("NOTIFY_DEFAULT_TUSERS") || "";
  if (!corpId || !corpSecret || !agentId) {
    return json({ error: "WECOM_OPS secrets not set" }, 500);
  }
  const content = body.content;
  if (!content || typeof content !== "string") {
    return json({ error: "missing content" }, 400);
  }
  const touser = (body.touser && String(body.touser).trim()) || defaultTusers;
  if (!touser) {
    return json({ error: "missing touser (set NOTIFY_DEFAULT_TUSERS or pass touser)" }, 400);
  }
  const msgtype = body.msgtype || "markdown";
  const title = body.title || "通知";

  try {
    // ④ 取 access_token（App B）
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // ⑤ 组消息体
    const message = { touser, msgtype, agentid: Number(agentId) };
    if (msgtype === "markdown") {
      message.markdown = { content: `### ${title}\n${content}` };
    } else if (msgtype === "text") {
      message.text = { content };
    } else if (msgtype === "textcard") {
      message.textcard = { title, description: content, url: body.url || "" };
    } else {
      return json({ error: "unsupported msgtype: " + msgtype }, 400);
    }

    // ⑥ 发送
    const sendRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      },
    );
    const sendData = await sendRes.json();
    return json({
      ok: sendData.errcode === 0,
      errcode: sendData.errcode,
      errmsg: sendData.errmsg,
      sent_to: touser,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
