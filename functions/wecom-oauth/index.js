// functions/wecom-oauth/index.js
// 企业微信 OAuth 回调处理（H5 网页授权 snsapi_base）：
//   code → 企微 userid → upsert org_users → 签发会话
// 框架状态：真实联调待「可信回调域名」就绪（企微后台配置 + 公网可达）。
// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID（与 wecom-push 共用）
// 前端发起授权（移动端 H5）：
//   https://open.weixin.qq.com/connect/oauth2/authorize?appid=${CORPID}
//     &redirect_uri=${APP_URL}/auth/callback&response_type=code&scope=snsapi_base
//     &state=xxx&agentid=${AGENTID}#wechat_redirect
// HS256 JWT 签发（deno runtime 内联——InsForge function 单文件部署，无法 require 共享模块）。
// 用 JWT_SECRET 签 role=authenticated 的 token，PostgREST 验签后切到 authenticated role。
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
    const wecomToken = tokenData.access_token;
    if (!wecomToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. code → 企业微信 userid
    const userRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=${wecomToken}&code=${code}`,
    );
    const userData = await userRes.json();
    const wecomUserId = userData.userid;
    if (!wecomUserId) {
      return json({ error: "failed_to_get_userid", detail: userData }, 401);
    }

    // 3. upsert org_users + 查询部门信息
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });

    // 先尝试 upsert（确保用户存在）
    await client.database.from("org_users").upsert(
      { wecom_id: wecomUserId },
      { onConflict: "wecom_id" },
    );

    // 查询用户的部门信息
    const { data: user, error: userError } = await client.database
      .from("org_users")
      .select("department_ids")
      .eq("wecom_id", wecomUserId)
      .single();

    const departmentIds = user?.department_ids || [];

    // 4. 签发 access_token（role=authenticated，携带部门信息）
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await signJwt(
      {
        sub: wecomUserId,
        role: "authenticated",
        departments: departmentIds,  // 新增：部门 ID 数组
        iss: "wecom-oauth",
        iat: now,
        exp: now + 7 * 86400,
      },
      Deno.env.get("JWT_SECRET"),
    );
    return json({ ok: true, wecom_userid: wecomUserId, access_token: accessToken });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
