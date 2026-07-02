// functions/wecom-sync-contacts/index.js
// 企微通讯录同步：获取部门列表 + 用户列表，upsert 到数据库。
// 定时执行（每日）或手动触发。
// 所需 secrets：WECOM_CORP_ID / WECOM_CONTACT_SECRET（通讯录同步专用）或 WECOM_SECRET / JWT_SECRET
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno）。
// 数据写入需要 authenticated role，故用 JWT_SECRET 签临时 token。
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
  // 使用应用 Secret（通讯录同步 Secret IP 白名单限制）
  const corpSecret = Deno.env.get("WECOM_SECRET");
  const jwtSecret = Deno.env.get("JWT_SECRET");

  // 调试：检查 secrets 是否正确加载
  const debugInfo = {
    hasCorpId: !!corpId,
    hasSecret: !!corpSecret,
    secretPrefix: corpSecret ? corpSecret.substring(0, 8) + "..." : null,
    hasJwtSecret: !!jwtSecret
  };
  console.log("Secrets loaded:", JSON.stringify(debugInfo));

  if (!corpId || !corpSecret || !jwtSecret) {
    return json({ error: "WECOM_CORP_ID/WECOM_SECRET/JWT_SECRET secrets not set", debug: debugInfo }, 500);
  }

  try {
    // 1. 获取企微 access_token
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // 2. 获取部门列表
    const deptRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${accessToken}`
    );
    const deptData = await deptRes.json();
    console.log("Department API response:", JSON.stringify(deptData));
    if (deptData.errcode !== 0) {
      return json({ error: "failed_to_get_departments", detail: deptData }, 502);
    }
    const departments = deptData.department || [];
    console.log("Departments found:", departments.length);

    // 3. 获取用户列表（遍历每个部门）
    const users = [];
    for (const dept of departments) {
      const userRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${accessToken}&department_id=${dept.id}`
      );
      const userData = await userRes.json();
      if (userData.errcode === 0 && userData.userlist) {
        users.push(...userData.userlist);
      }
    }

    // 4. 签临时 authenticated JWT（用于数据库写入）
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = await signJwt(
      { sub: "wecom-sync-contacts", role: "authenticated", iss: "wecom-sync-contacts", iat: now, exp: now + 300 },
      jwtSecret,
    );

    // 5. upsert 到数据库（用 authenticated token）
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: serviceToken,  // 用 service token 当 anonKey 传，SDK 会作为 Bearer
    });

    // 5.1 同步部门
    let deptRows = [];
    if (departments.length > 0) {
      deptRows = departments.map((d) => ({
        id: String(d.id),
        name: d.name,
        parent_id: d.parentid ? String(d.parentid) : null,
        order_weight: d.order || 0,
        synced_at: new Date().toISOString(),
      }));
      console.log("Upserting departments:", JSON.stringify(deptRows));
      const { data: deptData, error: deptError } = await client.database
        .from("org_departments")
        .upsert(deptRows, { onConflict: "id" });
      console.log("Departments result:", JSON.stringify({ data: deptData, error: deptError }));
      if (deptError) {
        return json({ error: "upsert_departments_failed", detail: deptError }, 502);
      }
    }

    // 5.2 同步用户（去重）
    const seen = new Set();
    const userRows = [];
    for (const u of users) {
      if (seen.has(u.userid)) continue;
      seen.add(u.userid);
      userRows.push({
        wecom_id: u.userid,
        name: u.name,
        department_ids: u.department ? u.department.map(String) : [],
        position: u.position || null,
        mobile: u.mobile || null,
        email: u.email || null,
        avatar: u.avatar || null,
        synced_at: new Date().toISOString(),
      });
    }
    if (userRows.length > 0) {
      console.log("Upserting users:", JSON.stringify(userRows.slice(0, 2)));
      const { data: userData, error: userError } = await client.database
        .from("org_users")
        .upsert(userRows, { onConflict: "wecom_id" });
      console.log("Users result:", JSON.stringify({ data: userData, error: userError }));
      if (userError) {
        return json({ error: "upsert_users_failed", detail: userError }, 502);
      }
    }

    return json({
      ok: true,
      departments: departments.length,
      users: userRows.length,
      debug: {
        deptRowsCount: deptRows.length,
        userRowsCount: userRows.length,
        sampleDept: deptRows[0] || null,
        sampleUser: userRows[0] || null,
        jwtSigned: !!serviceToken
      }
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
