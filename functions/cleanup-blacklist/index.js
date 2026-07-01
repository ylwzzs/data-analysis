// functions/cleanup-blacklist/index.js
// 定时清理已过期的黑名单记录
// 建议 schedule：每日 03:00 执行
// 所需 secrets：JWT_SECRET（用于签 service token）

// 内联 JWT 签名（CommonJS 无法共享模块）
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

  const jwtSecret = Deno.env.get("JWT_SECRET");
  if (!jwtSecret) {
    return json({ error: "JWT_SECRET not set" }, 500);
  }

  try {
    // 签临时 authenticated JWT
    const now = Math.floor(Date.now() / 1000);
    const serviceToken = await signJwt(
      { sub: "cleanup-blacklist", role: "authenticated", iss: "cleanup-blacklist", iat: now, exp: now + 300 },
      jwtSecret,
    );

    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: serviceToken,
    });

    // 删除已过期的黑名单记录
    const { data, error } = await client.database
      .from("token_blacklist")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .select("id"); // 返回被删除的记录数以统计

    if (error) {
      return json({ error: "cleanup_failed", detail: error }, 502);
    }

    return json({
      ok: true,
      cleaned: data?.length || 0,
      message: `Cleaned ${data?.length || 0} expired tokens from blacklist`,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
