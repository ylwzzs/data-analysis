# 企微通讯录实时同步（回调 + 兜底全量）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` 跟踪。
> 设计依据：`docs/superpowers/specs/2026-07-08-wecom-contact-realtime-sync-design.md` + `docs/architecture.md` §7.1.2。

**Goal:** 补全既有半成品 `functions/wecom-contacts-webhook`（AES 解密空壳）实现企微通讯录秒级实时同步，加 is_active 软删除，全量兜底改造 + 每日 03:17 调度，复用既有 secret。

**Architecture:** 回调（实时增量）+ 每日全量（兜底自愈）双轨。回调验证用既有 WECOM_TOKEN/WECOM_ENCODING_AES_KEY；user/get 拉快照用 WECOM_OPS_SECRET（App B）；DB 写入用签 authenticated JWT。delete 软删除（is_active=false）。

**Tech Stack:** InsForge Edge Function（Deno + CommonJS + 全局 Deno/createClient）、Web Crypto API（AES-256-CBC + SHA-1）、PostgreSQL、node-cron（Next.js instrumentation）。

---

## Task 1：数据库迁移（is_active 软删除列）

**Files:**
- Create: `database/migrations/017_contact_realtime_sync.sql`

- [ ] **Step 1：写迁移文件**

创建 `database/migrations/017_contact_realtime_sync.sql`：
```sql
-- 017_contact_realtime_sync.sql
-- 通讯录实时同步支持：org_users / org_departments 加 is_active 软删除列。
-- 语义：企微离职/删除 → is_active=false（保留行，保历史 + 不破坏 retail_query_user_perms 关联）。
-- 现有数据默认 true，不受影响。
-- 幂等：ADD COLUMN IF NOT EXISTS。

BEGIN;

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE org_departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN org_users.is_active IS '通讯录同步软删除标记：false=企微已离职/删除，保留行（架构 §7.1.2）';
COMMENT ON COLUMN org_departments.is_active IS '通讯录同步软删除标记：false=企微已删除，保留行（架构 §7.1.2）';

COMMIT;
```

- [ ] **Step 2：本地语法校验**

Run: `docker exec deploy-postgres-1 psql -U postgres -d insforge -f -` 灌入测试（或 GHA 部署时自动跑）。
本地 dev 有 postgres 容器则：
```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/017_contact_realtime_sync.sql
```
Expected: `ALTER TABLE` ×2 + `COMMENT` ×2，无 error；重复执行不报错（幂等）。

- [ ] **Step 3：验证列存在**

```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d org_users" | grep is_active
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d org_departments" | grep is_active
```
Expected: 两表都有 `is_active | boolean | default true`。

- [ ] **Step 4：commit**

```bash
git add database/migrations/017_contact_realtime_sync.sql
git commit -m "feat(db): 017 org_users/org_departments 加 is_active 软删除列（通讯录实时同步）"
```

---

## Task 2：补全 webhook 加解密 + 事件处理（核心）

**Files:**
- Modify: `functions/wecom-contacts-webhook/index.js`（整体重写为可运行版）

这是本特性核心。既有文件 AES 解密是 TODO 空壳、GET 返未解密 echostr、POST 未解密 Encrypt、delete 硬删。整体替换为下方完整实现。

- [ ] **Step 1：整体替换 `functions/wecom-contacts-webhook/index.js`**

完整新内容：
```js
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
async function decrypt(encryptB64, aesKey) {
  const iv = aesKey.slice(0, 16);
  const cipher = base64ToBytes(encryptB64);
  const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, cipher);
  const buf = new Uint8Array(plain);
  // PKCS7 unpad
  const pad = buf[buf.length - 1];
  const unpadded = buf.subarray(0, buf.length - pad);
  // 结构：16B 随机 + 4B msg_len(大端) + msg + receiveid
  const dv = new DataView(unpadded.buffer, unpadded.byteOffset, unpadded.byteLength);
  const msgLen = dv.getUint32(16);
  const msg = new TextDecoder().decode(unpadded.subarray(20, 20 + msgLen));
  const receiveid = new TextDecoder().decode(unpadded.subarray(20 + msgLen));
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
```

- [ ] **Step 2：commit**

```bash
git add functions/wecom-contacts-webhook/index.js
git commit -m "feat(webhook): 补全 wecom-contacts-webhook——AES 解密+GET明文+POST解密分派+user/get快照+软删除"
```

（部署与 e2e 验证留到 Task 6。）

---

## Task 3：全量兜底改造（sync-contacts）

**Files:**
- Modify: `functions/wecom-sync-contacts/index.js`

在现有全量 upsert 基础上加 is_active 对齐（让全量也纠正离职），upsert 行带 `is_active: true`。

- [ ] **Step 1：upsert 部门行带 is_active**

在 `5.1 同步部门` 的 `deptRows` map 里加 `is_active: true`：
```js
const deptRows = departments.map((d) => ({
  id: String(d.id),
  name: d.name,
  parent_id: d.parentid ? String(d.parentid) : null,
  order_weight: d.order || 0,
  is_active: true,
  synced_at: new Date().toISOString(),
}));
```

- [ ] **Step 2：upsert 用户行带 is_active**

在 `5.2 同步用户` 的 `userRows` push 里加 `is_active: true`：
```js
userRows.push({
  wecom_id: u.userid,
  name: u.name,
  department_ids: u.department ? u.department.map(String) : [],
  position: u.position || null,
  mobile: u.mobile || null,
  email: u.email || null,
  avatar: u.avatar || null,
  is_active: true,
  synced_at: new Date().toISOString(),
});
```

- [ ] **Step 3：加离职对齐逻辑（upsert 成功后）**

在用户 upsert 成功之后、`return json({ ok: true ... })` 之前，加：
```js
// 6. 离职对齐：企微没有但库里 is_active=true 的 → 标离职（纠正回调漏的离职）
const syncedUserIds = new Set(userRows.map((r) => r.wecom_id));
const { data: activeUsers, error: activeErr } = await client.database
  .from("org_users")
  .select("wecom_id")
  .eq("is_active", true);
if (!activeErr && activeUsers) {
  const toDeactivate = activeUsers
    .map((r) => r.wecom_id)
    .filter((id) => !syncedUserIds.has(id));
  if (toDeactivate.length > 0) {
    const { error: deactErr } = await client.database
      .from("org_users")
      .update({ is_active: false })
      .in("wecom_id", toDeactivate);
    if (deactErr) console.error("[sync-contacts] deactivate users failed:", deactErr);
    else console.log(`[sync-contacts] 标记离职 ${toDeactivate.length} 人:`, toDeactivate);
  }
}

// 部门同理
const syncedDeptIds = new Set(deptRows.map((r) => r.id));
const { data: activeDepts, error: activeDeptErr } = await client.database
  .from("org_departments")
  .select("id")
  .eq("is_active", true);
if (!activeDeptErr && activeDepts) {
  const toDeactDept = activeDepts
    .map((r) => r.id)
    .filter((id) => !syncedDeptIds.has(id));
  if (toDeactDept.length > 0) {
    const { error: deactDeptErr } = await client.database
      .from("org_departments")
      .update({ is_active: false })
      .in("id", toDeactDept);
    if (deactDeptErr) console.error("[sync-contacts] deactivate depts failed:", deactDeptErr);
    else console.log(`[sync-contacts] 标记删除部门 ${toDeactDept.length} 个:`, toDeactDept);
  }
}
```

并把 `return json({ ok: true, departments: departments.length, users: userRows.length })` 之前可加 `deactivated_users` 信息（可选）。

- [ ] **Step 4：commit**

```bash
git add functions/wecom-sync-contacts/index.js
git commit -m "feat(sync-contacts): 全量兜底改造——upsert 带 is_active + 离职/删部门对齐自愈"
```

---

## Task 4：调度（scheduler.ts 独立 03:17 cron）

**Files:**
- Modify: `web/lib/scheduler.ts`

通讯录兜底是平台基础设施，独立注册 cron，不进 collect_tasks 表、不改 executeTask。

- [ ] **Step 1：加 registerContactSyncJob 函数**

在 `web/lib/scheduler.ts` 的 `getScheduledTasks` 函数之前（或 `reloadScheduler` 之后）加：
```ts
/**
 * 注册通讯录全量兜底同步（平台基础设施，独立于 collect_tasks）。
 * 每日 03:17 调 functions/wecom-sync-contacts 全量自愈（架构 §7.1.2）。
 */
function registerContactSyncJob() {
  const JOB_KEY = '__contact_sync';
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate('17 3 * * *')) return;
  const job = cron.schedule('17 3 * * *', async () => {
    if (runningTasks.has(JOB_KEY)) {
      console.warn('[scheduler] 通讯录同步已在运行，跳过本次触发');
      return;
    }
    runningTasks.add(JOB_KEY);
    try {
      console.log('[scheduler] ⏰ 通讯录全量兜底同步触发');
      const resp = await fetch(`${INSFORGE_API_BASE}/functions/wecom-sync-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INSFORGE_API_KEY}` },
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[scheduler] 通讯录同步结果:', resp.status, data);
    } catch (e: any) {
      console.error('[scheduler] 通讯录同步异常:', e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set(JOB_KEY, job);
  console.log('[scheduler] 注册通讯录兜底同步 (17 3 * * *, Asia/Shanghai)');
}
```

- [ ] **Step 2：在 ensureSchedulerInitialized 末尾调用**

在 `ensureSchedulerInitialized()` 的 `state.initialized = true;` 之前（collect 任务注册循环之后）加：
```ts
    // 通讯录全量兜底（平台基础设施，独立于 collect_tasks）
    registerContactSyncJob();

    state.initialized = true;
```

- [ ] **Step 3：确认 reloadScheduler 覆盖**

`reloadScheduler()` 已 `for...of scheduledJobs` 全部 stop + clear，会覆盖 `__contact_sync`。重新 `ensureSchedulerInitialized()` 会再注册。确认无需额外改动。

- [ ] **Step 4：TypeScript 编译校验**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```
Expected: 无新增 error（有关 `__contact_sync` 的）。

- [ ] **Step 5：commit**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(scheduler): 注册通讯录全量兜底同步独立 cron（每日 03:17，架构 §7.1.2）"
```

---

## Task 5：.env.example 补 secret

**Files:**
- Modify: `deploy/.env.example`

`WECOM_TOKEN`/`WECOM_ENCODING_AES_KEY` 在 deploy-functions.sh 已 set_secret（行 132-133）但 .env.example 缺，补上避免漏配。

- [ ] **Step 1：在企业微信段补两行**

在 `deploy/.env.example` 的 `NOTIFY_DEFAULT_TUSERS=ZhangDuo` 行之后、`# ============ 智能问数` 段之前，加：
```env
# 企微「通讯录同步」功能回调验证（架构 §7.1.2）：企微后台「管理工具→通讯录同步→API接口同步」生成
# 用于 functions/wecom-contacts-webhook 的 GET 验证签名 + POST 解密（非 API 调用，与 WECOM_OPS_SECRET 无关）
WECOM_TOKEN=
WECOM_ENCODING_AES_KEY=
```

- [ ] **Step 2：commit**

```bash
git add deploy/.env.example
git commit -m "feat(deploy): .env.example 补 WECOM_TOKEN/WECOM_ENCODING_AES_KEY（通讯录回调验证）"
```

---

## Task 6：部署 + 验证（手动操作）

**前置（用户，企微后台）**：开启「通讯录同步→API接口同步」，拿 Token + EncodingAESKey。回调 URL 填 `https://data.shanhaiyiguo.com/functions/wecom-contacts-webhook`（企微保存时会先 GET 验证，故 function 须先部署）。

- [ ] **Step 1：SSH PUT 部署两个 function（webhook + sync-contacts）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
for fn in wecom-contacts-webhook wecom-sync-contacts; do
  body=$(jq -n --arg slug "$fn" --arg name "$fn" --arg desc "$fn" --rawfile code "$PWD/../functions/$fn/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
  curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/$fn && echo " → $fn OK"
done'
```

- [ ] **Step 2：清 Deno 缓存（关键，否则跑旧代码）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 3：服务器 .env 填 secret + 重跑 deploy-functions.sh 注入**

用户把企微后台的 Token/EncodingAESKey 填进服务器 `/opt/data-analytics-platform/deploy/.env` 的 `WECOM_TOKEN`/`WECOM_ENCODING_AES_KEY`，然后：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform && bash scripts/deploy-functions.sh"
```

- [ ] **Step 4：push 走 GHA（迁移 + scheduler + .env.example）**

```bash
git push origin main
gh run watch <run-id>
```
确认：迁移 017 跑通、web 容器重建、scheduler 加载新 cron。

- [ ] **Step 5：验证迁移 + is_active 列**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '\d org_users' | grep is_active"
```
Expected: `is_active | boolean | default true`。

- [ ] **Step 6：企微后台填回调 URL，确认 GET 验证通过**

企微保存回调 URL 时会 GET 验证。通过 = GET 验证（签名 + 解密 echostr 返明文）逻辑正确。失败查 webhook 日志：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-deno-1 --tail 50 2>&1 | grep webhook"
```

- [ ] **Step 7：e2e 实测 create/update_user（核心）**

企微后台手动改一个测试员工信息（如改 position），观察：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-deno-1 --since 10m 2>&1 | grep webhook"
```
Expected: 日志见 `[webhook] event: change_contact changeType: update_user`，无 error。
DB 验证：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT wecom_id,name,position,is_active FROM org_users WHERE wecom_id='<测试userid>';\""
```
Expected: position 秒级更新为企微新值，is_active=true。

- [ ] **Step 8：e2e 实测 delete_user 软删除**

企微后台删除一个测试员工，观察 DB：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT wecom_id,name,is_active FROM org_users WHERE wecom_id='<测试userid>';\""
```
Expected: 行仍在，`is_active=f`（软删除生效，非 hard delete）。

- [ ] **Step 9：实测全量兜底离职对齐**

手动触发全量同步：
```bash
curl -s -X POST -H "Authorization: Bearer $INSFORGE_API_KEY" https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
```
Expected: 返回 `{ok:true,...}`，deno 日志见离职对齐（若企微比库少人则标离职）。

- [ ] **Step 10：实测 name 漂移纠正**

记录测试员工"微信昵称→实名"过程：若回调触发 update → user/get 拉实名 → 秒级纠正；若回调未触发 → 确认次日 03:17 全量纠正（可临时手动跑 Step 9 加速验证）。

- [ ] **Step 11：cron 注册确认**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-web-1 --tail 100 2>&1 | grep '通讯录'"
```
Expected: 见 `[scheduler] 注册通讯录兜底同步 (17 3 * * *, Asia/Shanghai)`。或调 `/api/admin/scheduler/reload` 后再看。

- [ ] **Step 12：收尾 commit（如有部署中发现的 hotfix）**

```bash
git add -A && git commit -m "fix: 部署验证 hotfix（如有）"
```
