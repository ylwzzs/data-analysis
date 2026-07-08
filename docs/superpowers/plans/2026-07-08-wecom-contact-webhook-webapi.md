# 企微通讯录回调接收（web/api）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` 跟踪。
> 设计依据：`docs/superpowers/specs/2026-07-08-wecom-contact-webhook-webapi.md` + `docs/architecture.md` §7.1.2。

**Goal:** 企微通讯录变更回调接收从 InsForge function 移到 Next.js Route Handler（绕开 InsForge gateway 对 raw XML body 的吞 body 限制）。

**Architecture:** 回调走 `web/app/api/wecom-contacts-webhook/route.ts`（Next.js Node runtime，`request.text()` 读 raw XML）；nginx 加 location 避开 `/api` 兜底；secrets 注入 web 容器；写库用 web 现有 `@insforge/sdk` + ANON_KEY。兜底全量 sync-contacts 保留（JSON 调用不受影响）。

**Tech Stack:** Next.js Route Handler（Node runtime，Web Request API）、Node `crypto.subtle`（AES-CBC + SHA-1）、`@insforge/sdk`、nginx。

---

## Task 1：route.ts（核心）

**Files:**
- Create: `web/app/api/wecom-contacts-webhook/route.ts`

逻辑从已验证的 `functions/wecom-contacts-webhook/index.js`（含去 padding 修复 + 第 82 行正则修复）搬运，适配 TS + Next.js Route Handler + web 写库。

- [ ] **Step 1：写 route.ts**

创建 `web/app/api/wecom-contacts-webhook/route.ts`，完整内容：

```ts
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
  const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, cipher);
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
```

- [ ] **Step 2：tsc 校验**

```bash
(cd web && npx tsc --noEmit 2>&1 | grep -iE "wecom-contacts-webhook|webhook/route") || echo "✅ route.ts 无类型错误"
```
预期：无 route.ts 相关错误（既有其他文件错误忽略）。`crypto.subtle`/`atob` 在 Node 18+ 全局可用，Next.js Node runtime 默认支持。

- [ ] **Step 3：commit**

```bash
git add web/app/api/wecom-contacts-webhook/route.ts
git commit -m "feat(web): 企微通讯录回调接收 route.ts（web/api，绕开 InsForge XML body 限制）"
```

---

## Task 2：nginx 加 location（避开 /api 兜底）

**Files:**
- Modify: `deploy/nginx/server.conf.tpl`

- [ ] **Step 1：加 location**

在 `deploy/nginx/server.conf.tpl` 的 `location /api/auth { ... }` 之后、`location /api { ... }`（兜底 insforge:7130）之前，插入：

```nginx
    # 企微通讯录回调（web/api，架构 §7.1.2）——必须在 /api 兜底之前，最长前缀匹配优先 → web:3000
    # 否则 /api 兜底送到 insforge:7130，raw XML body 被 gateway 吞成 {}
    location /api/wecom-contacts-webhook {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
```

- [ ] **Step 2：commit**

```bash
git add deploy/nginx/server.conf.tpl
git commit -m "feat(nginx): 加 /api/wecom-contacts-webhook → web:3000（避开 /api 兜底 InsForge）"
```

---

## Task 3：compose web env 加 secrets

**Files:**
- Modify: `deploy/docker-compose.prod.yml`

- [ ] **Step 1：web 服务 environment 加 3 行**

在 `deploy/docker-compose.prod.yml` web 服务 environment 段（现有 `WECOM_CORP_ID`/`WECOM_SECRET`/`WECOM_AGENT_ID` 之后），加：

```yaml
      # 企微通讯录回调（web/api route 验证解密 + user/get，架构 §7.1.2）
      - WECOM_TOKEN=${WECOM_TOKEN}
      - WECOM_ENCODING_AES_KEY=${WECOM_ENCODING_AES_KEY}
      - WECOM_OPS_SECRET=${WECOM_OPS_SECRET}
```

- [ ] **Step 2：commit**

```bash
git add deploy/docker-compose.prod.yml
git commit -m "feat(deploy): web 容器注入通讯录回调 secrets（WECOM_TOKEN/ENCODING_AES_KEY/OPS_SECRET）"
```

---

## Task 4：废弃 function

**Files:**
- Delete: `functions/wecom-contacts-webhook/`

- [ ] **Step 1：git rm**

```bash
git rm -r functions/wecom-contacts-webhook
git commit -m "chore: 废弃 functions/wecom-contacts-webhook（逻辑移至 web/app/api，InsForge 接不了 XML body）"
```

- [ ] **Step 2（可选）：清理 InsForge 注册**

服务器上 InsForge 仍注册着该 function（无人调用，留着无害）。如要清理：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   curl -sf -X DELETE -H "Authorization: Bearer $INSFORGE_API_KEY" http://localhost:7130/api/functions/wecom-contacts-webhook'
```
失败/跳过都无碍。

---

## Task 5：部署验证（GHA + 企微后台 + e2e）

**部署全走 GHA**（web route + nginx conf + compose env 都非 function 改动）。

- [ ] **Step 1：push 触发 GHA**

```bash
git push origin main
gh run watch <run-id>
```
确认：nginx reload（新 location）+ web 重建（route + env）。

- [ ] **Step 2：验证 nginx 路由（curl 无参 GET，应到 web 非 InsForge）**

```bash
curl -s https://data.shanhaiyiguo.com/api/wecom-contacts-webhook
```
预期：返 `{"error":"missing verify params"}`（route.ts GET 的 400，说明到 web）；若返 InsForge 风格错误说明仍走兜底（查 nginx location 顺序）。

- [ ] **Step 3：本地 node 自测 GET 验证逻辑（企微后台改 URL 前）**

```bash
node -e '
const crypto=require("crypto");
const TOKEN="<服务器 WECOM_TOKEN>";
const AESKEY="<服务器 WECOM_ENCODING_AES_KEY>";
const CORPID="ww8252c1eee248867c";
(async()=>{
  const aesKey=Buffer.from(AESKEY+"=","base64"), iv=aesKey.subarray(0,16);
  const msg=Buffer.from("echo_test_ok");
  const random=crypto.randomBytes(16);
  const lenBuf=Buffer.alloc(4); lenBuf.writeUInt32BE(msg.length,0);
  const plain=Buffer.concat([random,lenBuf,msg,Buffer.from(CORPID)]);
  const c=crypto.createCipheriv("aes-256-cbc",aesKey,iv);
  const cipher=Buffer.concat([c.update(plain),c.final()]);
  const echostr=cipher.toString("base64");
  const ts=String(Math.floor(Date.now()/1000)), nonce="n"+ts;
  const sig=crypto.createHash("sha1").update([TOKEN,ts,nonce,echostr].sort().join("")).digest("hex");
  const r=await fetch(`https://data.shanhaiyiguo.com/api/wecom-contacts-webhook?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`);
  console.log("HTTP",r.status,"| body:",await r.text());
})();'
```
预期：`HTTP 200 | body: echo_test_ok`（route.ts GET 验证逻辑通）。Token/EncodingAESKey 用服务器 .env 的值（之前生成）。

- [ ] **Step 4：企微后台改回调 URL + GET 验证**

企微后台「通讯录同步」→ 回调 URL 改 `https://data.shanhaiyiguo.com/api/wecom-contacts-webhook`（Token/EncodingAESKey 不变）→ 保存 → 企微 GET 验证通过。

- [ ] **Step 5：e2e update_user**

企微后台改一个测试员工 position（如「e2e-webapi」）→ 查：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker logs deploy-web-1 --since 5m 2>&1 | grep webhook | tail -10"
```
预期：`[webhook] event: change_contact changeType: update_user`，无 error。DB：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT wecom_id,position,is_active,synced_at FROM org_users WHERE position='e2e-webapi';\""
```
预期：position 秒级更新，is_active=true，synced_at=今天。

- [ ] **Step 6：e2e delete_user（软删除）**

企微后台删一个测试员工 → DB：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT wecom_id,name,is_active FROM org_users WHERE wecom_id='<测试userid>';\""
```
预期：行仍在，is_active=f（软删除，非 hard delete）。
