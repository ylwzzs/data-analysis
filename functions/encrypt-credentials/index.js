/**
 * 凭证加密存储 Function
 *
 * 将凭证 AES-GCM 加密后存入 auth_credentials 表
 * 环境变量：ENCRYPTION_KEY（32 字节 hex）
 */

module.exports = async function(req) {
  try {
    const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY");
    if (!ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not configured");
    }

    const body = await req.json();
    const { source_id, credentials, expires_at } = body;

    if (!source_id || !credentials) {
      throw new Error("Missing source_id or credentials");
    }

    // AES-GCM 加密
    const keyBytes = new Uint8Array(ENCRYPTION_KEY.match(/.{2}/g).map(b => parseInt(b, 16)));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);

    const encoder = new TextEncoder();
    const plaintext = JSON.stringify(credentials);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext)
    );

    // 组合 iv + ciphertext，base64 编码存储
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    const encryptedData = btoa(String.fromCharCode(...combined));

    // 写入 auth_credentials（upsert）
    const POSTGREST_BASE_URL = Deno.env.get("POSTGREST_BASE_URL") || "http://postgrest:3000";

    // 先删除旧凭证
    await fetch(`${POSTGREST_BASE_URL}/auth_credentials?source_id=eq.${source_id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      }
    });

    // 插入新凭证
    const insertRes = await fetch(`${POSTGREST_BASE_URL}/auth_credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        source_id: source_id,
        credential_data: encryptedData,
        expires_at: expires_at || null
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      throw new Error(`Failed to save credentials: ${insertRes.status} ${errText}`);
    }

    const result = await insertRes.json();

    return new Response(JSON.stringify({
      success: true,
      expires_at: expires_at || null
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Encrypt credentials error:", error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
