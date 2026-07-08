// web/app/api/wecom-contacts-webhook/route.ts
// 企微通讯录变更回调接收（架构 §7.1.2）。Next.js Route Handler（Node runtime）。
// 走 web/api 而非 InsForge function：InsForge gateway 把 raw XML body 吞成 {}（memory insforge-function-body-limit）。
// 逻辑从 functions/wecom-contacts-webhook/index.js 搬运，适配 Web Request API + web 写库（@insforge/sdk + ANON_KEY）。

import { createClient } from "@insforge/sdk";

const TOKEN = process.env.WECOM_TOKEN || "";
const ENCODING_AES_KEY = process.env.WECOM_ENCODING_AES_KEY || "";
const CORP_ID = process.env.WECOM_CORP_ID || "";
const OPS_SECRET = process.env.WECOM_OPS_SECRET || "";
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE || "http://insforge:7130";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY || "";

// ---------- 加解密（Node crypto.subtle，企微 WXBizMsgCrypt）----------
// subtle.decrypt AES-CBC 已自动去 PKCS7 padding，勿再手动 unpad。
function deriveAesKey(encodingAesKey: string): Uint8Array {
  const bin = atob(encodingAesKey + "=");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decrypt(encryptB64: string, aesKey: Uint8Array) {
  const iv = aesKey.subarray(0, 16);
  const cipher = base64ToBytes(encryptB64);
  const key = await crypto.subtle.importKey("raw", aesKey as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, key, cipher as BufferSource);
  const buf = new Uint8Array(plain);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const msgLen = dv.getUint32(16);
  const msg = new TextDecoder().decode(buf.subarray(20, 20 + msgLen));
  const receiveid = new TextDecoder().decode(buf.subarray(20 + msgLen));
  return { msg, receiveid };
}

async function sha1Hex(...parts: string[]): Promise<string> {
  const sorted = parts.slice().sort().join("");
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sorted));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const matches = xml.match(/<(\w+)><!\[CDATA\[(.*?)\]\]><\/\w+>/g);
  if (matches) {
    for (const m of matches) {
      const key = m.match(/<(\w+)>/)![1];
      const value = m.match(/<!\[CDATA\[(.*?)\]\]>/)![1];
      result[key] = value;
    }
  }
  const simple = xml.match(/<(\w+)>([^<\n]*)<\/\w+>/g);
  if (simple) {
    for (const m of simple) {
      const key = m.match(/<(\w+)>/)![1];
      const value = m.match(/>([^<\n]*)<\//)?.[1];
      if (value !== undefined && !(key in result)) result[key] = value;
    }
  }
  return result;
}

function extractEncrypt(xml: string): string | null {
  const m = xml.match(/<Encrypt><!\[CDATA\[([^\]]+)\]\]><\/Encrypt>/);
  return m ? m[1] : null;
}

// ---------- user/get 拉权威快照（App B）----------
async function getUserSnapshot(userId: string): Promise<any> {
  const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${OPS_SECRET}`);
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("gettoken failed: " + JSON.stringify(tokenData));
  const res = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${tokenData.access_token}&userid=${encodeURIComponent(userId)}`);
  return res.json();
}

function json(data: unknown, status: number) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// ---------- GET：URL 验证 ----------
export async function GET(request: Request) {
  const url = new URL(request.url);
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const echostr = url.searchParams.get("echostr") || "";
  if (!msgSignature || !echostr) return json({ error: "missing verify params" }, 400);

  const sig = await sha1Hex(TOKEN, timestamp, nonce, echostr);
  if (sig !== msgSignature) return json({ error: "signature mismatch" }, 403);

  try {
    const aesKey = deriveAesKey(ENCODING_AES_KEY);
    const { msg } = await decrypt(echostr, aesKey);
    return new Response(msg, { status: 200, headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    console.error("[webhook] GET decrypt failed:", e);
    return json({ error: "decrypt failed" }, 500);
  }
}

// ---------- POST：事件推送 ----------
export async function POST(request: Request) {
  const url = new URL(request.url);
  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  if (!msgSignature) return json({ error: "missing sig params" }, 400);

  let body: string;
  try {
    body = await request.text();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  const encrypt = extractEncrypt(body);
  console.log("[webhook] POST bodyLen:", body.length, "| body(head 300):", body.slice(0, 300));
  console.log("[webhook] encrypt:", encrypt ? `len=${encrypt.length}` : "null");
  if (encrypt) {
    try {
      const dec = base64ToBytes(encrypt);
      console.log("[webhook] encrypt decode bytes:", dec.length, "| %16=", dec.length % 16);
    } catch (e: any) {
      console.log("[webhook] encrypt base64 decode err:", e.message);
    }
  }
  if (!encrypt) {
    console.warn("[webhook] no <Encrypt> in body");
    return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  const sig = await sha1Hex(TOKEN, timestamp, nonce, encrypt);
  if (sig !== msgSignature) {
    console.warn("[webhook] POST signature mismatch");
    return json({ error: "signature mismatch" }, 403);
  }

  let eventXml: string;
  try {
    const aesKey = deriveAesKey(ENCODING_AES_KEY);
    const { msg, receiveid } = await decrypt(encrypt, aesKey);
    if (receiveid !== CORP_ID) {
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

  if (data.Event !== "change_contact") {
    return new Response("success", { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

  try {
    switch (changeType) {
      case "create_user":
      case "update_user": {
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
