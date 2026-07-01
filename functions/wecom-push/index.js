// functions/wecom-push/index.js
// 定时推送报表摘要到企业微信（应用消息 textcard）。
// 由 InsForge schedule 定时 POST 触发，也可手动 invoke。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno），
//       不要用 ESM 的 import/export。
// HS256 JWT 签发（deno runtime 内联——InsForge function 单文件部署，无法 require 共享模块）。
// 推送时用 role=authenticated 的 token 读 reports/写 query_logs（anon 已被 REVOKE SELECT）。
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signJwt(payload, secret) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

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

    // 2. 读取报表数据生成摘要（用 authenticated JWT；anon 已被 REVOKE SELECT）
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      { sub: "wecom-push", role: "authenticated", iss: "wecom-push", iat: now, exp: now + 300 },
      Deno.env.get("JWT_SECRET"),
    );
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: token,
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
