# Plan 3: 定时应用（C4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** OpenClaw cron 承载定时推送（"每天9点给我推战报"），解决 cron turn 无身份的硬矛盾——plugin 透传 cronSessionKey → agent-query 反查 scheduled_reports.run_as → 按创建者权限查+推送。

**Architecture:** scheduled_reports(cron_job_id→run_as) 绑定表；plugin query_retail_data 透传 ctx.sessionKey；agent-query 检测 cronSessionKey 反查 run_as 走 get_user_perms；create_scheduled_report/push_report plugin 工具；模板优先/SQL 兜底。cron 创建用 OpenClaw agent cron tool（add）。

**Tech Stack:** PostgreSQL（scheduled_reports + RLS）/ OpenClaw plugin（dist/index.js）/ agent-query function / OpenClaw cron tool。

> **测试约定**：无单测，psql/curl/企微验证。
> **⚠️ spike 依赖**：cron 创建走 OpenClaw agent cron tool（action=add），其确切参数（sessionTarget/payload 结构）+ agent 协调可靠性需实现时 spike 验证（OpenClaw 闭源细节）。确定性部分（绑定表/sessionKey 反查/push_report）不受影响。

---

## 文件结构

- **Create** `database/migrations/035_scheduled_reports.sql` — 定时应用绑定表 + RLS
- **Modify** `openclaw/data-query-plugin/dist/index.js` — query_retail_data 透传 cronSessionKey + 新增 create_scheduled_report/push_report 工具
- **Modify** `openclaw/data-query-plugin/openclaw.plugin.json` — contracts.tools 加新工具
- **Modify** `functions/agent-query/index.js` — 入口加 cronSessionKey 反查 run_as
- **Modify** `openclaw/data-query-plugin/skills/retail-query/SKILL.md` — 定时应用创建/推送指引

---

## Task 1: scheduled_reports 绑定表 + RLS

**Files:**
- Create: `database/migrations/035_scheduled_reports.sql`

- [ ] **Step 1: 写迁移**

```sql
-- 035_scheduled_reports.sql
-- C4: 定时应用绑定（OpenClaw cron_job_id → run_as=创建者）。plugin 透传 cronSessionKey，agent-query 反查 run_as。
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wecom_id TEXT NOT NULL,          -- 创建者（=run_as）
  cron_job_id TEXT NOT NULL,             -- OpenClaw cron job id（反查键）
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('template','sql')),
  template_key TEXT,                     -- mode=template：daily_sales_brief/weekly/category_rank
  query_intent TEXT,                     -- mode=sql：自然语言意图
  delivery_to TEXT NOT NULL,             -- 推送目标企微 userid（push_report 强制读）
  run_as TEXT NOT NULL,                  -- = owner_wecom_id（钉死）
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT run_as_is_owner CHECK (run_as = owner_wecom_id),
  CONSTRAINT mode_fields CHECK (
    (mode='template' AND template_key IS NOT NULL) OR
    (mode='sql' AND query_intent IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_cron_job ON scheduled_reports(cron_job_id);
-- RLS：用户只能管自己的定时应用（owner 维度）
ALTER TABLE scheduled_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_reports_owner ON scheduled_reports;
CREATE POLICY scheduled_reports_owner ON scheduled_reports
  FOR ALL TO authenticated
  USING (owner_wecom_id = current_setting('request.jwt.claims.sub', true))
  WITH CHECK (owner_wecom_id = current_setting('request.jwt.claims.sub', true));
GRANT SELECT ON scheduled_reports TO authenticated;
-- service（agent-query 反查 run_as）经 SECURITY DEFINER RPC 读，不直接 GRANT
CREATE OR REPLACE FUNCTION get_scheduled_run_as(p_cron_job_id TEXT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT run_as FROM scheduled_reports WHERE cron_job_id = $1 AND enabled LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION get_scheduled_run_as(TEXT) TO authenticated;
COMMENT ON TABLE scheduled_reports IS '定时应用绑定（spec C4；cron_job_id→run_as 反查）';
DO $$ BEGIN RAISE NOTICE 'Migration 035_scheduled_reports applied'; END $$;
```

- [ ] **Step 2: 应用 + restart postgrest + commit + push**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" < database/migrations/035_scheduled_reports.sql
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
git add database/migrations/035_scheduled_reports.sql
git commit -m "feat(report-c): C4 scheduled_reports 绑定表+RLS+get_scheduled_run_as RPC

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

---

## Task 2: plugin query_retail_data 透传 cronSessionKey

**Files:**
- Modify: `openclaw/data-query-plugin/dist/index.js`（query_retail_data 的 execute + fetch body）

- [ ] **Step 1: execute 透传 cronSessionKey（requesterSenderId 空时）**

在 `dist/index.js` 的 query_retail_data factory 的 execute 里，userId 已从 `ctx.requesterSenderId` 取。改为同时取 sessionKey 并在空时透传：
```javascript
          execute: (toolCallId, params, _signal, _onUpdate) => {
            let raw = params;
            // ...（原有 params 解析不变）
            const sql = obj.sql ?? ...;
            // C4: requesterSenderId 空时（cron turn）透传 cronSessionKey 供 agent-query 反查 run_as
            const sessionKey = ctx && ctx.sessionKey;
            return executeQuery({ sql }, userId, userId ? null : sessionKey);
          },
```

executeQuery 签名加 cronSessionKey 参数，body 在无 userId 时带 cronSessionKey：
```javascript
async function executeQuery({ sql }, userId, cronSessionKey) {
  // ...AGENT_API_KEY/userId 检查改为：userId 和 cronSessionKey 至少一个
  const body = cronSessionKey
    ? { sql, cronSessionKey, agent_api_key: agentApiKey }
    : { sql, userId, agent_api_key: agentApiKey };
  // ...fetch 不变
}
```

- [ ] **Step 2: 部署 plugin（scp + restart openclaw）+ 验证**

```bash
scp -i "/Users/Duo/WPS 云档/其他/ShanHai-OPS.pem" \
  openclaw/data-query-plugin/dist/index.js \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/data-query-plugin/dist/index.js
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker restart deploy-openclaw-1"
```

---

## Task 3: agent-query 入口 cronSessionKey 反查 run_as

**Files:**
- Modify: `functions/agent-query/index.js`（入口 ②授权 段）

- [ ] **Step 1: 入口支持 cronSessionKey（无 userId 时反查 run_as）**

在 `module.exports` 入口，认证后、授权段改为：
```javascript
  let { sql, userId } = body;
  const cronSessionKey = body.cronSessionKey;
  // cron turn：userId 空，从 cronSessionKey 反查 run_as
  if (!userId && cronSessionKey) {
    const m = cronSessionKey.match(/cron:([a-f0-9-]+)/i);
    if (m) {
      try {
        const rr = await fetch(POSTGREST_URL + "/rpc/get_scheduled_run_as", {
          method: "POST",
          headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
          body: JSON.stringify({ p_cron_job_id: m[1] }),
        });
        const runAs = await rr.json();
        if (typeof runAs === "string" && runAs) userId = runAs;
      } catch (e) { /* 反查失败，userId 仍空，下面报 missing */ }
    }
  }
  if (!sql || !userId) return json({ error: "missing sql/userId" }, 400);
```
后续 get_user_perms(userId) 不变——userId 现在是反查到的 run_as。

- [ ] **Step 2: SSH PUT agent-query + 清缓存 + 验证**

```bash
# scp + PUT（同 Plan 2 Task 3 模式）+ 清 deno 缓存
# 验证：插入测试 scheduled_reports（cron_job_id=test-x, run_as=ZhangDuo），curl 带 cronSessionKey=...cron:test-x...
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query -H "Content-Type: application/json" \
  -d '{"sql":"SELECT count(*) c FROM retail_detail","cronSessionKey":"agent:main:cron:test-x:run:abc","agent_api_key":"'$AK'"}'
```
Expected: 以 ZhangDuo（run_as）权限返回 retail_detail 行数（反查 run_as 生效）。

---

## Task 4: push_report plugin 工具（强制 delivery_to）

**Files:**
- Modify: `openclaw/data-query-plugin/dist/index.js`（加 push_report 工具）+ `openclaw.plugin.json`（contracts）

- [ ] **Step 1: 加 push_report 工具**

push_report 接收 {scheduled_report_id}，从 scheduled_reports 查 delivery_to（强制，不信 LLM 传 to）+ 渲染内容推送。复用 notify-plugin 的 send_notify 出口。
```javascript
const PUSH_TOOL_NAME = "push_report";
const PUSH_TOOL_PARAMS = { type: "object", properties: { scheduled_report_id: { type: "string" }, content: { type: "string" }, title: { type: "string" } }, required: ["scheduled_report_id","content"], additionalProperties: false };
// register(api) 里：
api.registerTool((ctx) => {
  return {
    name: PUSH_TOOL_NAME,
    description: "推送定时报表。收件人强制用 scheduled_reports.delivery_to（不信参数里的 to）。",
    parameters: PUSH_TOOL_PARAMS,
    execute: async ({ scheduled_report_id, content, title }) => {
      // 查 scheduled_reports.delivery_to（经 agent-query 或直接 PostgREST serviceJwt）
      const to = await lookupDeliveryTo(scheduled_report_id); // 可信来源
      if (!to) return { error: "scheduled_report 不存在或无 delivery_to" };
      return sendNotify({ content, title, touser: to }); // 复用 notify 出口
    },
  };
}, { name: PUSH_TOOL_NAME });
```

- [ ] **Step 2: contracts.tools 加 push_report**

`openclaw.plugin.json` 的 `contracts.tools` 加 `"push_report"`。

- [ ] **Step 3: 部署 plugin + 验证**

scp dist/index.js + openclaw.plugin.json + restart openclaw。

---

## Task 5: create_scheduled_report plugin 工具（写绑定）

**Files:**
- Modify: `dist/index.js` + `openclaw.plugin.json`

- [ ] **Step 1: 加 create_scheduled_report 工具**

```javascript
const CREATE_TOOL_NAME = "create_scheduled_report";
const CREATE_TOOL_PARAMS = {
  type: "object",
  properties: {
    cron_job_id: { type: "string", description: "刚用 cron 工具创建的 job id" },
    name: { type: "string" }, mode: { type: "string", enum: ["template","sql"] },
    template_key: { type: "string" }, query_intent: { type: "string" },
  },
  required: ["cron_job_id","name","mode"], additionalProperties: false,
};
// execute：run_as = owner = ctx.requesterSenderId（钉死，非参数）；delivery_to = owner
api.registerTool((ctx) => {
  const owner = ctx && ctx.requesterSenderId;
  return {
    name: CREATE_TOOL_NAME,
    description: "建定时应用绑定（cron_job_id→run_as=你）。先用 cron 工具 add 建 cron job 拿 job_id，再调本工具。run_as/delivery_to 钉死=你本人。",
    parameters: CREATE_TOOL_PARAMS,
    execute: async (p) => {
      if (!owner) return { error: "无法识别创建者（非会话上下文）" };
      // INSERT scheduled_reports(owner=owner, run_as=owner, delivery_to=owner, ...) 经 agent-query 或 PostgREST
      return insertScheduledReport({ ...p, owner_wecom_id: owner, run_as: owner, delivery_to: owner });
    },
  };
}, { name: CREATE_TOOL_NAME });
```

- [ ] **Step 2: contracts.tools 加 create_scheduled_report + 部署**

---

## Task 6: cron 创建 + SKILL 指引（⚠️ spike）

**Files:**
- Modify: `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

- [ ] **Step 1: spike OpenClaw cron tool add 参数**

在企微测试环境，让 bot 调 cron tool（action=add）建测试 cron，观察参数（sessionTarget=isolated, payload.kind=agentTurn, payload.message=查询+推送指令, schedule）。确认 cron 触发时 ctx.sessionKey 含 `cron:<jobid>:`。

- [ ] **Step 2: SKILL.md 加定时应用创建指引**

```markdown
## 定时推送应用（用户说"每天X点推Y"时）

1. 判断模式：标准报表（业绩/周报/品类排行）→ mode=template + template_key；个性化 → mode=sql + query_intent。
2. 调 cron 工具（action=add）：建 cron job（schedule=用户指定时间, sessionTarget=isolated, payload=agentTurn 查询+推送指令）。拿 job_id。
3. 调 create_scheduled_report（cron_job_id=上一步 job_id, name, mode, template_key/query_intent）→ 写绑定（run_as/delivery_to 自动=你）。
4. cron 触发时：按 query_intent/template 查（自动按你的权限）+ 调 push_report 推送（收件人自动=你）。
```

- [ ] **Step 3: 端到端验证（企微）**

企微对 bot 说「每天9点给我推昨天销售额」→ bot 建 cron + 绑定 → 次日9点收到推送（按你的权限裁剪）。

---

## Task 7: 内置模板（mode=template）

**Files:**
- Modify: `functions/agent-query/index.js` 或 plugin（模板查询逻辑）

- [ ] **Step 1: 定义模板（代码内置，MVP 三个）**

`daily_sales_brief`：`SELECT biz_date,total_sale FROM report_daily_sales_v WHERE biz_date=(SELECT MAX(biz_date) FROM report_daily_sales_v) ORDER BY total_sale DESC LIMIT 10`
`weekly`：周汇总；`category_rank`：品类排行。模板查询走 report_*_v（按 run_as RLS+_v 自动裁剪）。

cron turn（mode=template）执行模板 SQL（不经 LLM 写 SQL）→ 渲染 → push_report。

- [ ] **Step 2: 验证模板模式**

---

## Self-Review

- **Spec coverage**：C4 ①绑定层（Task1）②解析层（Task2/3）③模板/SQL（Task5/7）④push_report delivery_to（Task4）⑤cron 创建（Task6）。run_as 三道闸：不在参数（create_scheduled_report run_as 钉死 owner）/=创建者（CHECK）/scheduled_reports RLS。✅
- **spike 依赖**：Task6 cron tool add 确切参数 + agent 协调可靠性 = OpenClaw 闭源，实现时验证。确定性部分（表/反查/push_report）不依赖。⚠️
- **安全**：cron turn 反查 run_as 走 SECURITY DEFINER RPC（get_scheduled_run_as），不直接暴露 scheduled_reports；push_report delivery_to 强制表读。
