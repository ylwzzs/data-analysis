# 企微三应用隔离 + 统一通知服务 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把通讯录同步和消息通知从单一报表应用中拆出，交给新建的全员可见应用（App B），并建立统一通知 edge function，让 web 与 OpenClaw 都走它发通知。

**Architecture:** 同一企微 corp 下三应用隔离——App A（老应用，OAuth/报表）、App B（新建，全员可见+通讯录读取，做全量同步+统一通知）、App C（OpenClaw bot，独立）。通知能力收口到 `functions/wecom-notify`，App B secret 单点存放；web 的 `notifyWecom` 改薄客户端经 InsForge SDK 调它，OpenClaw 复用 `AGENT_API_KEY` 调它。

**Tech Stack:** InsForge Edge Function（Deno, CommonJS, `module.exports`）、Next.js（`@insforge/sdk`）、PostgreSQL、企微开放 API、docker-compose、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-07-07-wecom-multi-app-notify-design.md`

**测试约定（重要）：** 本项目无单元测试框架（CLAUDE.md「测试流程」全部是手动 curl/SSH 验证）。本计划的「验证」步骤一律是真实 curl / psql / 企微实收检查，不写 pytest/jest。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `docs/architecture.md` | 唯一架构文档（CLAUDE.md 要求架构先行） | 改 §7.1 / 加统一通知小节 / 改 §4.3 / §9 决策表 |
| `functions/wecom-notify/index.js` | 统一通知服务：鉴权 → gettoken → message/send | 新建 |
| `functions/wecom-sync-contacts/index.js` | 通讯录全量同步（改读 App B secret） | 改 secret 变量名 |
| `functions/wecom-push/index.js` | 报表卡片推送（改用 App B） | 改 secret/agentid 变量名 |
| `scripts/deploy-functions.sh` | function 部署 + secret 注入（secret 列表硬编码） | 加 3 个 set_secret |
| `web/lib/notify.ts` | 告警通知薄客户端（调 wecom-notify） | 重写内部 |
| `deploy/.env.example` | 配置模板 | 加 3 变量 |
| `deploy/docker-compose.prod.yml` | web 容器 env | 加 `AGENT_API_KEY` |

---

## 前置（用户手动，部署前必须完成）

- [ ] **P1：企微后台新建 App B**（自建应用）→「可见范围」设**全部成员** + 「通讯录」开**读取成员/部门**权限 → 记下 Secret 与 AgentId。
- [ ] **P2：服务器 `deploy/.env` 加 3 行**（真实值，不入库）：
  ```bash
  WECOM_OPS_SECRET=<App B Secret>
  WECOM_OPS_AGENT_ID=<App B AgentId>
  NOTIFY_DEFAULT_TUSERS=ZhangDuo
  ```

> 没做完 P1/P2，Task 8 部署后 function 会因 secret 空而报 `WECOM_OPS secrets not set`。

---

## Task 1: 更新架构文档（CLAUDE.md 要求架构先行）

**Files:**
- Modify: `docs/architecture.md`（§7.1 约 575-590 行；§4.3 约 404-405、419 行；§9 决策表约 673-697 行）

- [ ] **Step 1：改写 §7.1「企业微信」整节**

把现有 §7.1 的「配置 / 功能」替换为三应用拓扑。定位 `### 7.1 企业微信` 到下一个 `###` 之间，替换为：

```markdown
### 7.1 企业微信（三应用隔离，2026-07-07）

同一 corp（`ww8252c1eee248867c`）下三个自建应用，职责隔离：

| 应用 | 可见范围 | 用途 | secret |
|---|---|---|---|
| **App A · 报表应用**（Agent 1000008） | 仅有权限的人 | OAuth 登录 + 报表页展示（软门禁） | `WECOM_SECRET` |
| **App B · 同步/通知应用**（新建） | **全部成员** + 通讯录读取 | ① 通讯录全量同步 ② 统一消息通知 | `WECOM_OPS_SECRET` / `WECOM_OPS_AGENT_ID` |
| **App C · OpenClaw bot** | 按需 | OpenClaw 对话 channel（收发 DM） | openclaw 容器 env（不在 web 管辖） |

- App A 可见范围 = 报表授权人，作报表访问软门禁；App B 全员可见 + 通讯录读取权限（同步全量的**前提**，否则 `department/list`、`user/list` 只返可见范围子集）。
- 历史 `WECOM_CONTACTS_SECRET` 已废（代码从未读取，死配置已清）。

**功能矩阵：**
| 功能 | API | 走哪个应用 | 状态 |
|------|-----|-----------|------|
| 登录 OAuth | `/cgi-bin/oauth2/authorize` | App A | ✅ |
| 用户信息 | `/cgi-bin/auth/getuserinfo` | App A | ✅ |
| 通讯录同步 | `/cgi-bin/department/list`、`/cgi-bin/user/list` | App B | ✅（全量） |
| 消息通知（统一） | `/cgi-bin/message/send` | App B（`functions/wecom-notify`） | ✅ |
| OpenClaw 对话 | 回调收消息 + 主动消息 | App C | ✅ |
```

- [ ] **Step 2：在 §7.1 后新增「统一通知服务」小节**

```markdown
### 7.1.1 统一消息通知服务（`functions/wecom-notify`，2026-07-07）

所有系统告警/通知收口到一个 edge function，用 App B 发送。凭据（App B secret）单点存于 function secret。

```
web（scheduler / collect-lemeng）─┐  AGENT_API_KEY   ┌─────────────────┐  WECOM_OPS_SECRET  ┌─────────┐
OpenClaw（主动通知）──────────────┴─ POST /functions/wecom-notify ─►│ gettoken(App B) │─────────────────────►│ 企微 App B│ → 员工
                                  {agent_api_key, content, title?,   │ message/send    │                     └─────────┘
                                   touser?, msgtype?}                └─────────────────┘
```

- **接口**：`POST /functions/wecom-notify`，body `{ agent_api_key, content, title?, touser?, msgtype? }`，鉴权 `agent_api_key === AGENT_API_KEY`。
- **默认收件人**：secret `NOTIFY_DEFAULT_TUSERS`（`|` 分隔），替代历史写死的单 `ZhangDuo`。
- **调用方**：web `notifyWecom`（薄客户端，经 `@insforge/sdk` invoke）、OpenClaw 主动通知（复用 `AGENT_API_KEY`）。
- **限**：token 每次现取（告警量低，可接受）；InsForge 挂则告警发不出（其挂即大故障）。
```

- [ ] **Step 3：订正 §4.3 OpenClaw 通知链路**

在 §4.3「可信 userid 流」之后或「实测运维要点」中，把 OpenClaw 主动通知的出口指向统一服务。定位 §4.3 里提到 `AGENT_API_KEY 注入` 的那条运维要点，在其后补一行：

```markdown
- **主动通知出口（统一）**：OpenClaw 需要主动发通知（采集完成/异常告警）时，POST `http://insforge:7130/functions/wecom-notify`（body `agent_api_key` + `content`），复用 `AGENT_API_KEY`，走 App B 发送（见 §7.1.1）。对话回复仍走 App C channel。
```

- [ ] **Step 4：§9 决策表补一行**

在「已确认的架构决策」表末尾加：

```markdown
| 企微应用拓扑 | 三应用隔离：报表/同步通知/bot 各一 | 2026-07-07 |
| 统一通知服务 | edge function `wecom-notify`（App B，凭据单点） | 2026-07-07 |
```

- [ ] **Step 5：提交**

```bash
git add docs/architecture.md
git commit -m "docs(arch): §7.1 三应用隔离 + §7.1.1 统一通知服务

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 新建 `functions/wecom-notify/index.js`

**Files:**
- Create: `functions/wecom-notify/index.js`

- [ ] **Step 1：写 function 完整代码**

```js
// functions/wecom-notify/index.js
// 统一消息通知服务（架构文档 §7.1.1）：所有系统告警/通知收口到此，用 App B（全员可见）发送。
// 调用方：① web notifyWecom（薄客户端，@insforge/sdk invoke）② OpenClaw 主动通知。
// 鉴权：body.agent_api_key === AGENT_API_KEY（与 agent-query 同款，防 anon_key 滥用）。
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / WECOM_OPS_AGENT_ID / NOTIFY_DEFAULT_TUSERS / AGENT_API_KEY
// 注意：InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno）。

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

  // ① 解析 body
  let body = {};
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "invalid_json_body" }, 400);
  }

  // ② 鉴权：agent_api_key
  const apiKey = Deno.env.get("AGENT_API_KEY");
  if (!apiKey || body.agent_api_key !== apiKey) {
    return json({ error: "unauthorized" }, 401);
  }

  // ③ 参数与 secret
  const corpId = Deno.env.get("WECOM_CORP_ID");
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
  const agentId = Deno.env.get("WECOM_OPS_AGENT_ID");
  const defaultTusers = Deno.env.get("NOTIFY_DEFAULT_TUSERS") || "";
  if (!corpId || !corpSecret || !agentId) {
    return json({ error: "WECOM_OPS secrets not set" }, 500);
  }
  const content = body.content;
  if (!content || typeof content !== "string") {
    return json({ error: "missing content" }, 400);
  }
  const touser = (body.touser && String(body.touser).trim()) || defaultTusers;
  if (!touser) {
    return json({ error: "missing touser (set NOTIFY_DEFAULT_TUSERS or pass touser)" }, 400);
  }
  const msgtype = body.msgtype || "markdown";
  const title = body.title || "通知";

  try {
    // ④ 取 access_token（App B）
    const tokenRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`,
    );
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return json({ error: "failed_to_get_access_token", detail: tokenData }, 502);
    }

    // ⑤ 组消息体
    const message = { touser, msgtype, agentid: Number(agentId) };
    if (msgtype === "markdown") {
      message.markdown = { content: `### ${title}\n${content}` };
    } else if (msgtype === "text") {
      message.text = { content };
    } else if (msgtype === "textcard") {
      message.textcard = { title, description: content, url: body.url || "" };
    } else {
      return json({ error: "unsupported msgtype: " + msgtype }, 400);
    }

    // ⑥ 发送
    const sendRes = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      },
    );
    const sendData = await sendRes.json();
    return json({
      ok: sendData.errcode === 0,
      errcode: sendData.errcode,
      errmsg: sendData.errmsg,
      sent_to: touser,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
```

- [ ] **Step 2：本地语法 + 结构校验**

Run: `node -c functions/wecom-notify/index.js && bash scripts/check-functions.sh | grep wecom-notify`
Expected: 无语法错误，输出 `✅ wecom-notify`。

- [ ] **Step 3：提交**

```bash
git add functions/wecom-notify/index.js
git commit -m "feat(function): 新建 wecom-notify 统一通知服务

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 改 `functions/wecom-sync-contacts/index.js` 读 App B secret

**Files:**
- Modify: `functions/wecom-sync-contacts/index.js`（第 4 行注释 + 第 26、29 行）

- [ ] **Step 1：改 secret 变量名**

把第 26 行 `const corpSecret = Deno.env.get("WECOM_SECRET");` 改为：
```js
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
```
把第 29 行错误信息里的 `WECOM_CORP_ID/WECOM_SECRET secrets not set` 改为 `WECOM_CORP_ID/WECOM_OPS_SECRET secrets not set`。

- [ ] **Step 2：改文件头注释（第 4 行）**

把 `// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / ANON_KEY` 改为：
```js
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / ANON_KEY（App B 全员可见，同步全量）
```

- [ ] **Step 3：校验**

Run: `node -c functions/wecom-sync-contacts/index.js`
Expected: 无输出（语法 OK）。

- [ ] **Step 4：提交**

```bash
git add functions/wecom-sync-contacts/index.js
git commit -m "refactor(sync): 通讯录同步改用 App B(WECOM_OPS_SECRET) 拉全量

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 改 `functions/wecom-push/index.js` 用 App B

**Files:**
- Modify: `functions/wecom-push/index.js`（第 4 行注释 + 第 49、50 行）

- [ ] **Step 1：改 secret/agentid 变量名**

把第 49-50 行：
```js
  const corpSecret = Deno.env.get("WECOM_SECRET");
  const agentId = Deno.env.get("WECOM_AGENT_ID");
```
改为：
```js
  const corpSecret = Deno.env.get("WECOM_OPS_SECRET");
  const agentId = Deno.env.get("WECOM_OPS_AGENT_ID");
```
把第 53 行错误信息 `WECOM_CORP_ID/WECOM_SECRET/WECOM_AGENT_ID secrets not set` 改为 `WECOM_CORP_ID/WECOM_OPS_SECRET/WECOM_OPS_AGENT_ID secrets not set`。

- [ ] **Step 2：改文件头注释（第 4 行）**

把 `// 所需 secrets：WECOM_CORP_ID / WECOM_SECRET / WECOM_AGENT_ID` 改为：
```js
// 所需 secrets：WECOM_CORP_ID / WECOM_OPS_SECRET / WECOM_OPS_AGENT_ID（App B）
```

- [ ] **Step 3：校验**

Run: `node -c functions/wecom-push/index.js`
Expected: 无输出。

- [ ] **Step 4：提交**

```bash
git add functions/wecom-push/index.js
git commit -m "refactor(push): 报表推送改用 App B(WECOM_OPS_*)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: `scripts/deploy-functions.sh` 加新 secret

**Files:**
- Modify: `scripts/deploy-functions.sh`（第 119 行后插入）

- [ ] **Step 1：在 `set_secret "WECOM_AGENT_ID"` 后加 3 行**

定位第 119 行 `set_secret "WECOM_AGENT_ID" "${WECOM_AGENT_ID:-}"`，紧接其后插入：
```bash
# 企微 App B（同步/通知全员应用，架构文档 §7.1）
set_secret "WECOM_OPS_SECRET" "${WECOM_OPS_SECRET:-}"
set_secret "WECOM_OPS_AGENT_ID" "${WECOM_OPS_AGENT_ID:-}"
set_secret "NOTIFY_DEFAULT_TUSERS" "${NOTIFY_DEFAULT_TUSERS:-}"
```

> 不要动 `set_secret "WECOM_SECRET"`（第 118 行）—— `wecom-oauth`（App A 登录）仍读它。

- [ ] **Step 2：提交**

```bash
git add scripts/deploy-functions.sh
git commit -m "chore(deploy): deploy-functions.sh 注入 App B secrets

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 重写 `web/lib/notify.ts` 为薄客户端

**Files:**
- Modify: `web/lib/notify.ts`（整文件替换内容）

- [ ] **Step 1：用薄客户端实现替换整文件**

```ts
// web/lib/notify.ts
// 企微告警通知 —— 薄客户端：统一走 functions/wecom-notify（架构文档 §7.1.1）。
// App B secret 单点存于 function secret；web 仅持 AGENT_API_KEY 做调用鉴权（compose 注入 web 容器）。
// notifyWecom(title, content) 签名不变，scheduler / collect-lemeng 调用点无需改动。
import { insforge } from "@/lib/insforge";

export async function notifyWecom(title: string, content: string) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) {
    console.warn("[notifyWecom] Missing AGENT_API_KEY（compose 未注入 web 容器？）");
    return;
  }
  try {
    const { data, error } = await insforge.functions.invoke("wecom-notify", {
      method: "POST",
      body: { agent_api_key: apiKey, title, content, msgtype: "markdown" },
    });
    if (error) {
      console.error("[notifyWecom] invoke error:", error);
      return;
    }
    if (data && data.ok) {
      console.log(`[notifyWecom] sent to ${data.sent_to}`);
    } else {
      console.error("[notifyWecom] send failed:", data);
    }
  } catch (err: any) {
    console.error("[notifyWecom] Error:", err.message);
  }
}
```

- [ ] **Step 2：TypeScript 编译通过**

Run: `cd web && npx tsc --noEmit`
Expected: 无错误（`notifyWecom` 签名不变，scheduler/collect-lemeng 调用点不需改）。

- [ ] **Step 3：提交**

```bash
git add web/lib/notify.ts
git commit -m "refactor(web): notifyWecom 改薄客户端走 wecom-notify

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 配置——`.env.example` + `docker-compose.prod.yml`

**Files:**
- Modify: `deploy/.env.example`（第 41 行后加段）
- Modify: `deploy/docker-compose.prod.yml`（web 服务 env，第 34 行后）

- [ ] **Step 1：`.env.example` 加 App B 变量段**

定位第 41 行 `WECOM_SECRET=`（在「企业微信（function secrets）」段内），其下插入：
```bash

# 企微 App B（同步/通知全员应用，架构文档 §7.1）
# 可见范围=全部成员 + 通讯录读取权限；用于通讯录全量同步 + 统一通知
WECOM_OPS_SECRET=
WECOM_OPS_AGENT_ID=
# 统一通知默认收件人（| 分隔的 userid，或 @all）；替代历史写死的单 ZhangDuo
NOTIFY_DEFAULT_TUSERS=ZhangDuo
```

- [ ] **Step 2：`.env.example` 更新 AGENT_API_KEY 注入说明**

定位「智能问数」段（第 44-45 行）那段「同时注入三处」注释，把「三处」改「四处」并补 web：
```bash
# 同时注入四处：① duckdb 服务 env（compose 读此变量）② agent-query function secret（deploy-functions.sh 读此变量）
#            ③ openclaw 容器 env（compose openclaw 服务，§4.3）
#            ④ web 容器 env（compose web 服务，供 notifyWecom 调 wecom-notify 鉴权，§7.1.1）
```

- [ ] **Step 3：`docker-compose.prod.yml` web 服务加 `AGENT_API_KEY`**

定位 web 服务 environment 块第 34 行 `- WECOM_AGENT_ID=${WECOM_AGENT_ID}`，其下插入一行（与周围同样用数组式）：
```yaml
      # 统一通知：notifyWecom 调 wecom-notify 的鉴权密钥（架构文档 §7.1.1）
      - AGENT_API_KEY=${AGENT_API_KEY:-}
```

> web 现有 `WECOM_CORP_ID/SECRET/AGENT_ID`（31-34 行）保留不动——`WECOM_SECRET` 仍由 `deploy-functions.sh` 作 function secret 注入给 `wecom-oauth`；web 侧这几行虽不再被 notify.ts 读，但留着无害，清理留后续。

- [ ] **Step 4：提交**

```bash
git add deploy/.env.example deploy/docker-compose.prod.yml
git commit -m "chore(deploy): 配 App B secrets + web 容器注入 AGENT_API_KEY

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 部署（GHA，改了 function+web+config，走完整部署）

> 前提：前置 P1/P2 已完成（App B 已建、服务器 `deploy/.env` 已加 3 个真实值）。

- [ ] **Step 1：推送触发 GHA**

Run: `git push origin main`
Expected: GHA `deploy` workflow 触发；quality（lint/typecheck/check-functions）→ rsync 代码到服务器 → SSH 跑 `deploy.sh`（起后端 → migrate → `deploy-functions.sh` 部署 3 个 function + 注入新 secret → build/push 前端镜像 → compose up）。

- [ ] **Step 2：监控 GHA**

Run: `gh run watch`（或 `gh run list --limit 1`）
Expected: 5 个步骤全绿，约 3-4 分钟。

- [ ] **Step 3：若 function 跑旧代码（Deno 缓存），清缓存**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```
Expected: 缓存清空、deno 重启。（仅当 Step 验证发现 function 行为异常时执行。）

---

## Task 9: 端到端验证

- [ ] **Step 1：验证通讯录全量同步**

Run:
```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT COUNT(*) FROM org_users;'"
```
Expected: function 返回 `{ok:true, users:N}`，N 明显大于此前「总经办一小撮」；`org_users` 行数跳到全员（YangWei 应在内：`SELECT wecom_id FROM org_users WHERE wecom_id ILIKE '%yang%';`）。

- [ ] **Step 2：验证 wecom-notify（带正确 key）**

Run（把 `<AGENT_API_KEY>` 换成 deploy/.env 里的值）：
```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-notify \
  -H "Content-Type: application/json" \
  -d '{"agent_api_key":"<AGENT_API_KEY>","title":"自检","content":"notify 服务自检 ok"}'
```
Expected: `{"ok":true,"errcode":0,...,"sent_to":"ZhangDuo"}`，且 ZhangDuo 企微收到该消息。

- [ ] **Step 3：验证鉴权（错 key 被拒）**

Run:
```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-notify \
  -H "Content-Type: application/json" \
  -d '{"agent_api_key":"wrong","content":"x"}'
```
Expected: `{"error":"unauthorized"}`，HTTP 401。

- [ ] **Step 4：验证 web 告警链路（scheduler 实发）**

确认 web 容器有 `AGENT_API_KEY`：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-web-1 printenv AGENT_API_KEY | head -c 8"
```
Expected: 打印 key 前 8 字符（非空）。

> 触发一次真实告警（如手动跑一次会失败/或 token 过期的采集任务），观察 `docker logs deploy-web-1 --tail 30` 出现 `[notifyWecom] sent to ...`，且企微收到。

- [ ] **Step 5：验证 OpenClaw 通知出口**

让 OpenClaw 触发一次主动通知（经 `wecom-notify`）。如暂无触发点，跳过实发，仅在 §4.3/§7.1.1 文档已说明调用方式；后续 OpenClaw 侧接入时按文档 POST `http://insforge:7130/functions/wecom-notify`。

- [ ] **Step 6：收尾——记录运维要点**

把「App B secret 在 deploy/.env」「NOTIFY_DEFAULT_TUSERS 改收件人」「wecom-notify 接口」记入 CLAUDE.md 或 memory（如用户要求）。

---

## Self-Review（已核对）

- **Spec 覆盖**：spec §2 目标（全量同步/统一通知/隔离）→ Task 2/3/8/9；§3 拓扑 → Task 1；§4 改动清单逐项 → Task 2-7；§5 接口 → Task 2 代码；§6 配置 → Task 5/7；§8 部署验证 → Task 8/9。全覆盖。
- **补充项**：spec §8.2「设 secret」实为改 `deploy-functions.sh`（secret 列表硬编码）→ Task 5（spec 未列文件，计划补上）。
- **类型一致**：`notifyWecom(title, content)` 签名 Task 6 保持不变，Task 6 Step 2 验证调用点无影响；`agent_api_key` 字段名 Task 2（function）、Task 6（web）、Task 9（curl）三处一致。
- **占位符**：前置 P1/P2 的 `<App B Secret>` 等是用户手填真实值（非设计 TBD），已明示。
