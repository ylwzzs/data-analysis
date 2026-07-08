// functions/wecom-contacts-webhook/index.js
// 企微通讯录变更事件回调（架构文档 §7.1.2）。
// 补全历史半成品：AES 解密原为 TODO 空壳、GET 返未解密 echostr、POST 未解密 Encrypt、delete 硬删。
//
// 双轨之一（实时增量）；另一轨 functions/wecom-sync-contacts 每日全量兜底自愈。
//
// 企微事件：Event=change_contact，ChangeType=create_user/update_user/delete_user/
//           create_party/update_party/delete_party（企微用 party 表示部门）。
//
// 策略：
// - 回调只当"谁变了"的通知；create/update_user 一律补 user/get(userid) 拉权威全量快照再 upsert
//   （update_user 回调只带变化字段且不保证触发，如"微信昵称→实名"）。
// - delete_user/delete_party → 软删除 is_active=false（保行，不破坏 retail_query_user_perms 关联）。
// - DB 写入用签 authenticated JWT（JWT_SECRET），非 ANON_KEY。
//
// 所需 secrets：
//   WECOM_CORP_ID / WECOM_TOKEN / WECOM_ENCODING_AES_KEY（回调验证解密，企微「通讯录同步」功能生成）
//   WECOM_OPS_SECRET（user/get 拉快照，App B）/ JWT_SECRET（签 DB token）
//
// 注意：InsForge OSS runtime = CommonJS + 全局注入（createClient、Deno）。Web Crypto 经 crypto.subtle。

// ---------- 加解密工具（企微 WXBizMsgCrypt 协议，Web Crypto 手写零依赖）----------

// EncodingAESKey(43字符) → 32 字节 AES key
function deriveAesKey(encodingAesKey) {
  const b64 = encodingAesKey + "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes; // 32B
}

// base64 密文 → Uint8Array
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// AES-256-CBC 解密 → { msg, receiveid }
// ⚠ Web Crypto subtle.decrypt AES-CBC 已自动去 PKCS7 padding，返回的 plain 即明文，
//   不能再手动 unpad（否则会把 receiveid 尾字节当 padding 截断）。
async function decrypt(encryptB64, aesKey) {
  const iv = aesKey.slice(0, 16);
  const cipher = base64ToBytes(encryptB64);
  const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, cipher);
  const buf = new Uint8Array(plain);
  // 结构：16B 随机 + 4B msg_len(大端) + msg + receiveid
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const msgLen = dv.getUint32(16);
  const msg = new TextDecoder().decode(buf.subarray(20, 20 + msgLen));
  const receiveid = new TextDecoder().decode(buf.subarray(20 + msgLen));
  return { msg, receiveid };
}

// sha1(sort([token, ts, nonce, encrypt])) → hex
async function sha1Hex(...parts) {
  const sorted = parts.slice().sort().join("");
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sorted));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 复用既有 parseXml：提取 <Key><![CDATA[val]]></Key>
function parseXml(xml) {
  const result = {};
  const matches = xml.match(/<(\w+)><!\[CDATA\[(.*?)\]\]><\/\w+>/g);
  if (matches) {
    matches.forEach((match) => {
      const key = match.match(/<(\w+)>/)[1];
      const value = match.match(/<!\[CDATA\[(.*?)\]\]>/)[1];
      result[key] = value;
    });
  }
  // 兼容非 CDATA 的简单字段（如 <Id>123</Id>）
  const simple = xml.match(/<(\w+)>([^<\n]*)<\/\w+>/g);
  if (simple) {
    simple.forEach((match) => {
      const key = match.match(/<(\w+)>/)[1];
      const value = match.match(/>([^<\n]*)<\//)?.[1];
      if (value !== undefined && !(key in result)) result[key] = value;
    });
  }
  return result;
}

// 提取外层 <Encrypt> 密文
function extractEncrypt(xml) {
  const m = xml.match(/<Encrypt><!\[CDATA\[([^\]]+)\]\]><\/Encrypt>/);
  return m ? m[1] : null;
}

// ---------- DB 写入 token（签 authenticated JWT，沿用既有方式）----------
async function signServiceJwt() {
  const jwtSecret = Deno.env.get("JWT_SECRET");
  const now = Math.floor(Date.now() / 1000);
  function b64url(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify({ sub: "wecom-webhook", role: "authenticated", iss: "wecom-contacts-webhook", iat: now, exp: now + 300 })));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

// ---------- user/get 拉权威快照（App B secret）----------
async function getUserSnapshot(userId) {
  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
  const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`);
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("gettoken failed: " + JSON.stringify(tokenData));
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${tokenData.access_token}&userid=${encodeURIComponent(userId)}`);
  return res.json();
}

module.exports = async function (req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  function json(data, status) {
    return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const corpId = Deno.env.get("WECOM_CORP_ID");
  const token = Deno.env.get("WECOM_TOKEN");
  const encodingAesKey = Deno.env.get("WECOM_ENCODING_AES_KEY");
  if (!corpId || !token || !encodingAesKey) {
    return json({ error: "WECOM_CORP_ID/TOKEN/ENCODING_AES_KEY not set" }, 500);
  }

  let aesKey;
  try {
    aesKey = deriveAesKey(encodingAesKey);
  } catch (e) {
    return json({ error: "invalid ENCODING_AES_KEY" }, 500);
  }

  const url = new URL(req.url);
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");

  // ---------- GET：URL 验证 ----------
  if (req.method === "GET") {
    const echostr = url.searchParams.get("echostr");
    if (!msgSignature || !timestamp || !nonce || !echostr) {
      return json({ error: "missing verify params" }, 400);
    }
    // GET 验证签名包含 echostr 原始密文串
    const sig = await sha1Hex(token, timestamp, nonce, echostr);
    if (sig !== msgSignature) return json({ error: "signature mismatch" }, 403);
    // 解密 echostr → 明文（历史 bug：返了未解密的 echostr）
    try {
      const { msg } = await decrypt(echostr, aesKey);
      return new Response(msg, { status: 200, headers: { "Content-Type": "text/plain" } });
    } catch (e) {
      console.error("[webhook] GET decrypt failed:", e);
      return json({ error: "decrypt failed" }, 500);
    }
  }

  // ---------- POST：事件推送 ----------
  if (req.method === "POST") {
    if (!msgSignature || !timestamp || !nonce) return json({ error: "missing sig params" }, 400);
    let body;
    try {
      body = await req.text();
    } catch (e) {
      return json({ error: "invalid body" }, 400);
    }

    const encrypt = extractEncrypt(body);
    if (!encrypt) {
      console.warn("[webhook] no <Encrypt> in body");
      return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // ① 签名校验
    const sig = await sha1Hex(token, timestamp, nonce, encrypt);
    if (sig !== msgSignature) {
      console.warn("[webhook] POST signature mismatch");
      return json({ error: "signature mismatch" }, 403);
    }

    // ② 解密 + receiveid 校验
    let eventXml;
    try {
      const { msg, receiveid } = await decrypt(encrypt, aesKey);
      if (receiveid !== corpId) {
        console.warn("[webhook] receiveid mismatch:", receiveid);
        return json({ error: "receiveid mismatch" }, 403);
      }
      eventXml = msg;
    } catch (e) {
      console.error("[webhook] POST decrypt failed:", e);
      return json({ error: "decrypt failed" }, 500);
    }

    const data = parseXml(eventXml);
    const changeType = data.ChangeType || data.changeType;
    console.log("[webhook] event:", data.Event, "changeType:", changeType);

    // 只处理通讯录变更
    if (data.Event !== "change_contact") {
      return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    const client = createClient({
      baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
      anonKey: await signServiceJwt(),
    });

    try {
      switch (changeType) {
        case "create_user":
        case "update_user": {
          // 补 user/get 拉权威全量快照（不信任回调零散字段）
          const u = await getUserSnapshot(data.UserID);
          if (u.errcode && u.errcode !== 0) {
            console.error("[webhook] user/get failed:", u);
            return json({ error: "user_get_failed", detail: u }, 502);
          }
          const { error } = await client.database.from("org_users").upsert({
            wecom_id: u.userid,
            name: u.name,
            department_ids: Array.isArray(u.department) ? u.department.map(String) : [],
            position: u.position || null,
            mobile: u.mobile || null,
            email: u.email || null,
            avatar: u.avatar || null,
            is_active: true,
            synced_at: new Date().toISOString(),
          }, { onConflict: "wecom_id" });
          if (error) {
            console.error("[webhook] upsert user failed:", error);
            return json({ error: "upsert_user_failed", detail: error }, 502);
          }
          break;
        }
        case "delete_user": {
          // 软删除（保留行，不破坏 retail_query_user_perms 关联）
          const { error } = await client.database.from("org_users").update({ is_active: false }).eq("wecom_id", data.UserID);
          if (error) {
            console.error("[webhook] soft-delete user failed:", error);
            return json({ error: "delete_user_failed", detail: error }, 502);
          }
          break;
        }
        case "create_party":
        case "update_party": {
          const { error } = await client.database.from("org_departments").upsert({
            id: String(data.Id),
            name: data.Name,
            parent_id: data.ParentId ? String(data.ParentId) : null,
            order_weight: Number(data.Order) || 0,
            is_active: true,
            synced_at: new Date().toISOString(),
          }, { onConflict: "id" });
          if (error) {
            console.error("[webhook] upsert dept failed:", error);
            return json({ error: "upsert_department_failed", detail: error }, 502);
          }
          break;
        }
        case "delete_party": {
          const { error } = await client.database.from("org_departments").update({ is_active: false }).eq("id", String(data.Id));
          if (error) {
            console.error("[webhook] soft-delete dept failed:", error);
            return json({ error: "delete_department_failed", detail: error }, 502);
          }
          break;
        }
        default:
          console.log("[webhook] unhandled changeType:", changeType);
      }
      return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
    } catch (e) {
      console.error("[webhook] handler error:", e);
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "method not allowed" }, 405);
};
