// functions/wecom-sync-contacts/index.js
// 企微通讯录同步：获取部门列表 + 用户列表，upsert 到数据库。
// 定时执行（每日）或手动触发。
// 所需 secrets：WECOM_CORP_ID / WECOM_CONTACTS_SECRET（通讯录同步专用）
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
  const corpSecret = Deno.env.get("WECOM_CONTACTS_SECRET");
  if (!corpId || !corpSecret) {
    return json({ error: "WECOM_CORP_ID/WECOM_CONTACTS_SECRET secrets not set" }, 500);
  }

  try {
    // 1. 获取 access_token（通讯录同步专用）
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
    if (deptData.errcode !== 0) {
      return json({ error: "failed_to_get_departments", detail: deptData }, 502);
    }
    const departments = deptData.department || [];

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

    // 4. upsert 到数据库
    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: Deno.env.get("ANON_KEY"),
    });

    // 4.1 同步部门
    if (departments.length > 0) {
      const deptRows = departments.map((d) => ({
        id: String(d.id),
        name: d.name,
        parent_id: d.parentid ? String(d.parentid) : null,
        order_weight: d.order || 0,
        synced_at: new Date().toISOString(),
      }));
      const { error: deptError } = await client.database
        .from("org_departments")
        .upsert(deptRows, { onConflict: "id" });
      if (deptError) {
        return json({ error: "upsert_departments_failed", detail: deptError }, 502);
      }
    }

    // 4.2 同步用户（去重）
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
      const { error: userError } = await client.database
        .from("org_users")
        .upsert(userRows, { onConflict: "wecom_id" });
      if (userError) {
        return json({ error: "upsert_users_failed", detail: userError }, 502);
      }
    }

    return json({
      ok: true,
      departments: departments.length,
      users: userRows.length,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};