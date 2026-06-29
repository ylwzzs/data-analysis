// functions/wecom-oauth/index.js
// 企业微信 OAuth 回调处理（H5 网页授权 snsapi_base）：
//   code → 企微 userid → upsert org_users → 签发会话
// 框架状态：真实联调待「可信回调域名」就绪（企微后台配置 + 公网可达）。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID（与 wecom-push 共用）
// 前端发起授权（移动端 H5）：
//   https://open.weixin.qq.com/connect/oauth2/authorize?appid=${CORPID}
//     &redirect_uri=${APP_URL}/auth/callback&response_type=code&scope=snsapi_base
//     &state=xxx&agentid=${AGENTID}#wechat_redirect
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
    return json({ error: "WECOM secrets not configured" }, 500);
  }

  try {
    const url = new URL(req.url);
    let code = url.searchParams.get("code");
    if (!code && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      code = body.code;
    }
    if (!code) {
      return json({ error: "missing oauth code" }, 400);
    }

    // 1. 获取企微 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. code → 企业微信 userid
    const userRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${accessToken}&code=${code}`,
    );
    const userData = await userRes.json();
    const wecomUserId = userData.userid;
    if (!wecomUserId) {
      return json({ error: "failed_to_get_userid", detail: userData }, 401);
    }

    // 3. upsert org_users（MVP：用 anon client 只读；生产应走 service role / admin）
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_BASE_URL"),
      anonKey: Deno.env.get("ANON_KEY"),
    });
    await client.database.from("org_users").upsert(
      { wecom_id: wecomUserId },
      { onConflict: "wecom_id" },
    );

    // 4. TODO（待回调域名 + 企微组织架构 API）：
    //    - 拉取用户姓名/部门补全 org_users
    //    - 调用 InsForge auth 签发会话 token（custom provider / admin generate session）
    //    - 设置 cookie 并重定向回前端，而非返回 JSON
    return json({
      ok: true,
      wecom_userid: wecomUserId,
      stage: "framework",
      note: "session token + redirect pending callback domain setup",
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
