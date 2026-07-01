// functions/wecom-contacts-webhook/index.js
// 企微通讯录变更事件推送接收
// 处理：验证 URL、解密事件、更新数据库
// 所需 secrets：WECOM_CORP_ID / WECOM_TOKEN / WECOM_ENCODING_AES_KEY / JWT_SECRET
//
// 企微事件类型：
// - change_contact: 通讯录变更（create_user/update_user/delete_user/create_party/update_party/delete_party）

// 简易 AES 解密（企微使用 AES-CBC + PKCS#7）
// 注：完整实现需要 crypto 库，这里使用简化方案
async function decryptMessage(encrypted, aesKey) {
  // TODO: 完整 AES 解密实现
  // 企微使用：AES-256-CBC，密钥从 EncodingAESKey 派生
  // 参考：https://developer.work.weixin.qq.com/document/path/96234
  // 由于 Deno runtime 限制，这里暂时返回简化解析
  return { message: encrypted, needFullImpl: true };
}

// 解析 XML 消息
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
  return result;
}

// 生成签名
function generateSignature(token, timestamp, nonce, encrypted) {
  const arr = [token, timestamp, nonce, encrypted].sort();
  const str = arr.join("");
  // 使用 crypto.subtle 进行 SHA1
  return crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
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
  const token = Deno.env.get("WECOM_TOKEN");
  const aesKey = Deno.env.get("WECOM_ENCODING_AES_KEY");

  if (!corpId || !token || !aesKey) {
    return json({ error: "WECOM_CORP_ID/TOKEN/ENCODING_AES_KEY not set" }, 500);
  }

  const url = new URL(req.url);

  // GET 请求：URL 验证（企微首次配置时验证）
  if (req.method === "GET") {
    const msgSignature = url.searchParams.get("msg_signature");
    const timestamp = url.searchParams.get("timestamp");
    const nonce = url.searchParams.get("nonce");
    const echostr = url.searchParams.get("echostr");

    if (!msgSignature || !timestamp || !nonce || !echostr) {
      return json({ error: "missing verify params" }, 400);
    }

    // 验证签名
    const signature = await generateSignature(token, timestamp, nonce, echostr);
    const signatureHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (signatureHex !== msgSignature) {
      return json({ error: "signature mismatch" }, 403);
    }

    // 返回 echostr 完成验证
    return new Response(echostr, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // POST 请求：接收事件推送
  if (req.method === "POST") {
    try {
      const body = await req.text();
      const data = parseXml(body);

      console.log("Received event:", data);

      // 检查事件类型
      const eventType = data.Event || data.InfoType;
      const changeType = data.ChangeType;

      // 只处理通讯录变更事件
      if (eventType === "change_contact") {
        // 签发临时 JWT 用于数据库写入
        const jwtSecret = Deno.env.get("JWT_SECRET");
        const now = Math.floor(Date.now() / 1000);

        // 内联 signJwt（简化版）
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

        const serviceToken = await signJwt(
          { sub: "wecom-webhook", role: "authenticated", iss: "wecom-contacts-webhook", iat: now, exp: now + 300 },
          jwtSecret,
        );

        const client = createClient({
          baseUrl: Deno.env.get("INSFORGE_API_BASE") || "http://insforge:7130",
          anonKey: serviceToken,
        });

        // 处理不同变更类型
        switch (changeType) {
          case "create_user":
          case "update_user": {
            // 新增或更新用户
            const { error } = await client.database.from("org_users").upsert({
              wecom_id: data.UserID,
              name: data.Name,
              department_ids: data.Department ? data.Department.split(",").map((d) => d.trim()) : [],
              position: data.Position || null,
              mobile: data.Mobile || null,
              email: data.Email || null,
              avatar: data.Avatar || null,
              synced_at: new Date().toISOString(),
            }, { onConflict: "wecom_id" });

            if (error) {
              console.error("Upsert user failed:", error);
              return json({ error: "upsert_user_failed", detail: error }, 502);
            }
            break;
          }

          case "delete_user": {
            // 删除用户（软删除或硬删除）
            const { error } = await client.database.from("org_users").delete().eq("wecom_id", data.UserID);
            if (error) {
              console.error("Delete user failed:", error);
              return json({ error: "delete_user_failed", detail: error }, 502);
            }
            break;
          }

          case "create_party":
          case "update_party": {
            // 新增或更新部门
            const { error } = await client.database.from("org_departments").upsert({
              id: data.Id,
              name: data.Name,
              parent_id: data.ParentId || null,
              order_weight: data.Order || 0,
              synced_at: new Date().toISOString(),
            }, { onConflict: "id" });

            if (error) {
              console.error("Upsert department failed:", error);
              return json({ error: "upsert_department_failed", detail: error }, 502);
            }
            break;
          }

          case "delete_party": {
            // 删除部门
            const { error } = await client.database.from("org_departments").delete().eq("id", data.Id);
            if (error) {
              console.error("Delete department failed:", error);
              return json({ error: "delete_department_failed", detail: error }, 502);
            }
            break;
          }

          default:
            console.log("Unhandled change type:", changeType);
        }
      }

      // 返回 success（企微要求）
      return new Response("success", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    } catch (e) {
      console.error("Webhook error:", e);
      return json({ error: String(e) }, 500);
    }
  }

  return json({ error: "method not allowed" }, 405);
};
