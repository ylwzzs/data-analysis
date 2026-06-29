// functions/wecom-push/index.js
// 定时推送报表摘要到企业微信（应用消息 textcard）。
// 由 InsForge schedule 定时 POST 触发，也可手动 invoke。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno），
//       不要用 ESM 的 import/export。
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

  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_SECRET");
  const agentId = Deno.env.get("WECOM_AGENT_ID");
  if (!corpId || !corpSecret || !agentId) {
    return json(
      { error: "WECOM_CORP_ID/WECOM_SECRET/WECOM_AGENT_ID secrets not set" },
      500,
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const toUser = body.to_user || "@all";

    // 1. 获取企微 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. 读取报表数据生成摘要（createClient 全局注入）
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_BASE_URL"),
      anonKey: Deno.env.get("ANON_KEY"),
    });
    const { data: reports, error } = await client.database
      .from("reports")
      .select("name,metrics,updated_at")
      .limit(5);
    if (error) return json({ error: "db_query_failed", detail: error }, 502);

    const summary = (reports ?? [])
      .map((r) => {
        const m = (r.metrics ?? []).map((x) => `${x.name} ${x.value}`).join("    ");
        return `📊${r.name}\n${m}`;
      })
      .join("\n\n——————\n\n");

    // 3. 发送应用消息（textcard）
    const sendRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          touser: toUser,
          msgtype: "textcard",
          agentid: Number(agentId),
          textcard: {
            title: "📊 数据分析平台 · 报表推送",
            description: summary || "暂无报表数据",
            url: Deno.env.get("REPORT_URL") || "http://localhost:3000",
          },
        }),
      },
    );
    const sendData = await sendRes.json();

    // 4. 写审计日志（best effort）
    await client.database.from("query_logs").insert([
      {
        query_type: "wecom_push",
        status: sendData.errcode === 0 ? "success" : "failed",
        error_message: sendData.errcode === 0 ? null : JSON.stringify(sendData),
      },
    ]);

    return json({ ok: sendData.errcode === 0, to_user: toUser, detail: sendData });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
