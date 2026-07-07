// functions/wecom-notify/index.js
// 统一消息通知服务（架构文档 §7.1.1）：所有系统告警/通知收口到此，用 App B（全员可见）发送。
// 调用方：① web notifyWecom（薄客户端，@insforge/sdk invoke）② OpenClaw send_notify 工具。
// 鉴权：body.agent_api_key === AGENT_API_KEY（与 agent-query 同款，防 anon_key 滥用）。
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / WECOM_OPS_AGENT_ID / NOTIFY_DEFAULT_TUSERS / AGENT_API_KEY
//
// 支持的企微应用消息类型（msgtype）：
//   text          纯文本，可 @（mentioned_list / mentioned_mobile_list）
//   markdown      markdown（企微子集：标题/加粗/链接/列表，不支持图片）
//   textcard      单卡片（title + description + url 跳转）
//   news          图文（articles: 1-8 条 {title, description?, url, picurl?}）—— 带图通知走这个
//   template_card 模板卡片：传 template_card 对象则透传（text_notice/news_notice/button_interaction/
//                 vote_interaction/multiple_interaction 任一）；只给 title/content/url 则便捷构造 text_notice
// 不支持 image/voice/video/file/mpnews：需 media_id（要 /cgi-bin/media_upload 上传流水线 + 媒体源）。
//   要带图就用 news 的 picurl（公网图片 URL）。
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

  const touser = (body.touser && String(body.touser).trim()) || defaultTusers;
  if (!touser) {
    return json({ error: "missing touser (set NOTIFY_DEFAULT_TUSERS or pass touser)" }, 400);
  }
  const msgtype = body.msgtype || "markdown";
  const content = body.content; // string | undefined
  const title = body.title; // string | undefined（不强制默认，按类型各自处理）

  // content 是否必填：news（用 articles）和「透传 template_card 对象」时不强制 content
  const hasTemplateCardObj =
    msgtype === "template_card" && body.template_card && typeof body.template_card === "object";
  const needsContent =
    msgtype === "markdown" || msgtype === "text" || msgtype === "textcard" ||
    (msgtype === "template_card" && !hasTemplateCardObj);
  if (needsContent && (!content || typeof content !== "string")) {
    return json(
      { error: "missing content (required for " + msgtype + " unless passing articles/template_card)" },
      400,
    );
  }

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

    // ⑤ 组消息体（按 msgtype 分派）
    const message = { touser, msgtype, agentid: Number(agentId) };

    if (msgtype === "markdown") {
      message.markdown = { content: title ? `### ${title}\n${content}` : content };
    } else if (msgtype === "text") {
      message.text = { content };
      if (Array.isArray(body.mentioned_list)) message.text.mentioned_list = body.mentioned_list;
      if (Array.isArray(body.mentioned_mobile_list))
        message.text.mentioned_mobile_list = body.mentioned_mobile_list;
    } else if (msgtype === "textcard") {
      message.textcard = { title: title || "通知", description: content, url: body.url || "" };
    } else if (msgtype === "news") {
      const articles = body.articles;
      if (!Array.isArray(articles) || articles.length === 0) {
        return json(
          { error: "news 需要 articles 数组（1-8 条 {title, url, description?, picurl?}）" },
          400,
        );
      }
      if (articles.length > 8) {
        return json({ error: "news articles 最多 8 条（收到 " + articles.length + "）" }, 400);
      }
      message.news = { articles };
    } else if (msgtype === "template_card") {
      message.template_card = hasTemplateCardObj
        ? body.template_card // 透传（text_notice/news_notice/button_interaction/vote_interaction/multiple_interaction 任一）
        : {
            // 便捷构造：title/content/url → 默认 text_notice 卡片
            card_type: "text_notice",
            main_title: { title: title || "通知" },
            sub_title_text: content,
            card_action: { type: 1, url: body.url || "" },
          };
    } else {
      return json(
        { error: "unsupported msgtype: " + msgtype + "（支持 text/markdown/textcard/news/template_card）" },
        400,
      );
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
      msgtype,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
