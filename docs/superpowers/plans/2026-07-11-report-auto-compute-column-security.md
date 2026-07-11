# Plan 1: 报表自动算 + 列级闭环 + 取数路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 采集后自动算 report_*（持续新鲜）+ 补齐汇总表列级成本脱敏（report_*_v）+ 模型优先汇总路由。覆盖 spec 的 C0+C1+C2。

**Architecture:** scheduler retail 分支 `verified` 后以 service 身份调 duckdb-service `/compute`（daily/category 用采集日期，weekly 滚动 8 周）；PG 建 `report_*_v` 安全视图按 `can_see_cost` claim 列级脱敏、原表收回 SELECT；SKILL.md 加汇总优先规则。

**Tech Stack:** PostgreSQL 迁移 / node-cron scheduler（web/lib/scheduler.ts）/ DuckDB /compute（services/server.js）/ agent-query function / OpenClaw skill。

> **测试约定**：本项目无单测框架，验证靠 psql/curl/企微（CLAUDE.md 验证流程）。每个任务用"验证步骤"代替 failing test：先确认现状/写预期 → 实现 → 验证 → commit。

---

## 文件结构

- **Create** `database/migrations/032_report_security_views.sql` — C0 列级脱敏视图 + datasets 注册
- **Create** `database/migrations/033_compute_logs.sql` — C1 计算日志表
- **Modify** `web/lib/scheduler.ts` — C1 retail 分支后触发 /compute + 记日志
- **Verify** `functions/agent-query/index.js` — C0 确认路由到 _v（loadRegistry 自动取 exposed pg_table，预期无需改码）
- **Modify** `openclaw/data-query-plugin/skills/retail-query/SKILL.md` — C2 汇总优先规则

---

## Task 1: C0 列级脱敏视图迁移

**Files:**
- Create: `database/migrations/032_report_security_views.sql`

- [ ] **Step 1: 写迁移文件**

```sql
-- 032_report_security_views.sql
-- C0: report_* 列级成本脱敏（spec §3.2）。daily_sales/category 有 total_profit → 建 _v 按 can_see_cost 脱敏；
--     weekly_trend 无成本列，不建 _v（保持原表）。原表收回 SELECT，查询走 _v（DB 层权威，防绕过）。
-- 幂等：视图用 DROP+CREATE（CLAUDE.md 坑：CREATE OR REPLACE 给视图加列后重跑报 cannot drop columns）。

DROP VIEW IF EXISTS report_daily_sales_v;
DROP VIEW IF EXISTS report_daily_category_v;

CREATE VIEW report_daily_sales_v AS
SELECT biz_date, branch_num, branch_name, total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_sales;

CREATE VIEW report_daily_category_v AS
SELECT biz_date, branch_num, branch_name, category, total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_category;

COMMENT ON VIEW report_daily_sales_v IS '每日门店销售汇总（成本列按 can_see_cost 脱敏；spec C0）';
COMMENT ON VIEW report_daily_category_v IS '每日品类汇总（成本列按 can_see_cost 脱敏；spec C0）';

-- 原表收回 SELECT（service 写账号仍可写， authenticated 改查 _v）
REVOKE SELECT ON report_daily_sales FROM anon, authenticated;
REVOKE SELECT ON report_daily_category FROM anon, authenticated;
GRANT SELECT ON report_daily_sales_v TO authenticated;
GRANT SELECT ON report_daily_category_v TO authenticated;
-- weekly_trend 无敏感列，009 已 GRANT SELECT 给 authenticated，保持

-- datasets 注册：_v 暴露，原表移出 exposed
UPDATE datasets SET exposed = false WHERE name IN ('report_daily_sales', 'report_daily_category');

INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
  ('report_daily_sales_v',  '每日门店销售汇总(脱敏)', 'pg_table', 'report_daily_sales_v',  'summary', FALSE, TRUE, 'biz_date', 'YYYY-MM-DD', FALSE, TRUE, '成本列 total_profit 按 can_see_cost 脱敏（spec C0）'),
  ('report_daily_category_v','每日品类汇总(脱敏)',    'pg_table', 'report_daily_category_v','summary', FALSE, TRUE, 'biz_date', 'YYYY-MM-DD', FALSE, TRUE, '成本列 total_profit 按 can_see_cost 脱敏（spec C0）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, exposed=EXCLUDED.exposed, description=EXCLUDED.description;

-- dataset_columns: _v 的 total_profit 标 is_sensitive（成本组）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
  ('report_daily_sales_v',  'total_profit', 'DECIMAL', '金额', TRUE, NULL, '利润（can_see_cost=false→NULL）', 7),
  ('report_daily_category_v','total_profit','DECIMAL', '金额', TRUE, NULL, '利润（can_see_cost=false→NULL）', 8)
ON CONFLICT (dataset_name, name) DO UPDATE SET is_sensitive=EXCLUDED.is_sensitive, description=EXCLUDED.description;

DO $$ BEGIN RAISE NOTICE 'Migration 032_report_security_views applied'; END $$;
```

- [ ] **Step 2: 应用迁移到生产**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" \
  < database/migrations/032_report_security_views.sql
```
Expected: 多个 `CREATE VIEW`/`GRANT`/`INSERT 0 1`，末尾 `Migration 032 applied`。

- [ ] **Step 3: 重启 postgrest 刷 schema 缓存（CLAUDE.md 坑）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 4: 验证 _v 脱敏（无 claim → total_profit=NULL）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT biz_date, branch_num, total_sale, total_profit FROM report_daily_sales_v LIMIT 3;\""
```
Expected: `total_profit` 列全为空（无 claim 时 `current_setting(...,true)` 返回 NULL → COALESCE false → NULL）。`total_sale` 有值。

- [ ] **Step 5: 验证原表已收回 SELECT（authenticated 直查原表应被拒）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SET ROLE authenticated; SELECT count(*) FROM report_daily_sales;\""
```
Expected: `permission denied`（原表 SELECT 已收回）。

- [ ] **Step 6: Commit**

```bash
git add database/migrations/032_report_security_views.sql
git commit -m "feat(report-c): C0 report_*_v 列级成本脱敏视图 + 原表收回 SELECT

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: C0 验证 agent-query 路由到 _v

**Files:**
- Verify: `functions/agent-query/index.js`（loadRegistry 第 36-48 行）

- [ ] **Step 1: 确认 loadRegistry 自动取 _v**

读 `functions/agent-query/index.js` 第 36-48 行：`pgTables = ds.filter(d => d.exposed && d.engine === 'pg_table').map(d => d.name)`。Task 1 把原表 exposed=false、_v exposed=true，故 pgTables 自动变为 `[report_daily_sales_v, report_daily_category_v, report_weekly_trend, dim_item, ...]`。**预期无需改 agent-query 代码**——`isPgQuery` 检测到 SQL 含这些表名走 PG 路径，execute_sql_rls 执行时 _v 在 DB 层自动脱敏。

- [ ] **Step 2: 部署 agent-query（若 codebase 无改动则跳过；保险起见清缓存）**

```bash
# agent-query 未改代码，无需 PUT。仅确认 dictionary 现在返回 _v
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H "Content-Type: application/json" \
  -d '{"mode":"dictionary","agent_api_key":"'$AGENT_API_KEY'"}' | python3 -c "import sys,json;d=json.load(sys.stdin)['dictionary'];print([x['name'] for x in d['datasets']])"
```
Expected: 列表含 `report_daily_sales_v` / `report_daily_category_v`，**不含** `report_daily_sales` / `report_daily_category`（已移出 exposed）。

- [ ] **Step 3: 端到端验证脱敏（用 can_see_cost=false 用户查 _v）**

用 YangWei（can_see_cost=false）经企微 bot 问「昨天各店销售额和利润」，或直接 curl agent-query：
```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT branch_num,total_sale,total_profit FROM report_daily_sales_v LIMIT 3","userId":"YangWei","agent_api_key":"'$AGENT_API_KEY'"}'
```
Expected: `total_profit` 为 null（_v DB 层脱敏生效）；`total_sale` 有值。

- [ ] **Step 4: （无需 commit，本任务无代码改动；若 Step 2 改了缓存则记录）**

跳过 commit（验证型任务）。

---

## Task 3: C1 compute_logs 迁移

**Files:**
- Create: `database/migrations/033_compute_logs.sql`

- [ ] **Step 1: 写迁移文件**

```sql
-- 033_compute_logs.sql
-- C1: /compute 执行日志（采集自动触发 / 手动 / cron）。失败 → status=failed → 接 collect_fail 告警（完整性规则第5点）。
CREATE TABLE IF NOT EXISTS compute_logs (
  id BIGSERIAL PRIMARY KEY,
  report_type TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL,              -- success | failed
  rows_written INTEGER,
  duration_ms INTEGER,
  error TEXT,
  triggered_by TEXT,                 -- 'collect:<task_id>' | 'manual' | 'cron:<job_id>'
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
GRANT SELECT ON compute_logs TO authenticated;
CREATE INDEX IF NOT EXISTS idx_compute_logs_started ON compute_logs(started_at DESC);
COMMENT ON TABLE compute_logs IS '报表计算日志（spec C1）';
DO $$ BEGIN RAISE NOTICE 'Migration 033_compute_logs applied'; END $$;
```

- [ ] **Step 2: 应用迁移**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" \
  < database/migrations/033_compute_logs.sql
```
Expected: `CREATE TABLE` / `GRANT` / `Migration 033 applied`。

- [ ] **Step 3: Commit**

```bash
git add database/migrations/033_compute_logs.sql
git commit -m "feat(report-c): C1 compute_logs 表（采集自动算日志+失败告警基础）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: C1 scheduler 采集后自动 /compute

**Files:**
- Modify: `web/lib/scheduler.ts`（retail 分支 verified 后插入触发；文件顶部加 DUCKDB_URL；新增 triggerCompute 函数）

- [ ] **Step 1: 文件顶部加 DUCKDB_URL 常量**

在 `web/lib/scheduler.ts` 顶部常量区（`INSFORGE_API_BASE` 附近）加：
```ts
const DUCKDB_URL = process.env.DUCKDB_URL || "http://duckdb:9000";
```

- [ ] **Step 2: 新增 triggerCompute 函数（放在 executeTask 之前的辅助函数区）**

```ts
// C1: 采集 verified 后触发报表计算（service 身份，无 perms；算全量写 report_*，查询时裁剪）。
// daily/category 用采集日期；weekly 滚动 8 周（upsert 幂等）。失败记 compute_logs + 企微告警，不阻塞采集。
function subtractDays(yyyymmdd: string, days: number): string {
  const y = +yyyymmdd.slice(0, 4), m = +yyyymmdd.slice(4, 6) - 1, d = +yyyymmdd.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d) - days * 86400000);
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}

async function triggerCompute(client: any, dates: string[], taskId: string) {
  // dates 形如 ['20260710','20260710']（YYYYMMDD）；/compute 要 YYYY-MM-DD
  const fmt = (s: string) => `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  const reports = [
    { type: "daily_sales",    dateFrom: fmt(dates[0]), dateTo: fmt(dates[1]) },
    { type: "daily_category", dateFrom: fmt(dates[0]), dateTo: fmt(dates[1]) },
    { type: "weekly_trend",   dateFrom: fmt(subtractDays(dates[0], 56)), dateTo: fmt(dates[1]) },
  ];
  for (const r of reports) {
    const startedAt = new Date();
    let status = "failed", rowsWritten: number | null = null, durationMs: number | null = null, error: string | null = null;
    try {
      const resp = await fetch(`${DUCKDB_URL}/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-key": INSFORGE_API_KEY },
        body: JSON.stringify({ report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo }),
      });
      const data = await resp.json().catch(() => ({} as any));
      if (resp.ok && data.success) {
        status = "success"; rowsWritten = data.rows_written ?? 0; durationMs = data.duration_ms ?? 0;
      } else {
        error = data.error || `HTTP ${resp.status}`;
      }
    } catch (e: any) {
      error = e.message || String(e);
    }
    await client.database.from("compute_logs").insert([{
      report_type: r.type, date_from: r.dateFrom, date_to: r.dateTo, status,
      rows_written: rowsWritten, duration_ms: durationMs, error,
      triggered_by: `collect:${taskId}`,
      started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
    }]);
    if (status === "failed") {
      await notifyWecom("⚠️ 报表计算失败", `**报表**: ${r.type}\n**范围**: ${r.dateFrom} ~ ${r.dateTo}\n**错误**: ${error}\n**触发**: collect:${taskId}`);
    } else {
      console.log(`[scheduler] /compute ${r.type} ${r.dateFrom}~${r.dateTo}: ${rowsWritten} rows`);
    }
  }
}
```

- [ ] **Step 3: retail 分支 verified 后调用 triggerCompute**

在 `web/lib/scheduler.ts` retail 分支（incremental 分支的 `verified = true` 之后、以及 full 分支对账循环结束之后），在 `writeLog(...)` 调用**之前**插入：
```ts
    // C1: 采集成功后自动算报表（service 身份，失败不阻塞采集）
    if (verified && dates && dates.length === 2) {
      await triggerCompute(client, dates, task.id);
    }
```
> 注意：retail 分支有两处会走到 writeLog（incremental 早返回、full 循环结束）。两处 writeLog 之前都加这个 `if (verified ...)` 块（DRY：可把 retail 末尾收拢成一个出口，但最小改动是两处各加）。

- [ ] **Step 4: TypeScript 编译检查**

```bash
cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i scheduler | head
```
Expected: 无 scheduler.ts 报错（若有 `DUCKDB_URL`/`subtractDays` 未定义等，按 Step 1-2 修正）。

- [ ] **Step 5: 部署 web（GHA）+ 验证采集触发 /compute**

```bash
git push origin main   # 触发 GHA（web 改动需 GHA，见 CLAUDE.md 部署决策表）
gh run watch           # 等 GHA 绿
```
部署后手动触发一次 retail 采集（或等 cron），然后查 compute_logs + report 新鲜度：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT report_type,status,rows_written,triggered_by,started_at FROM compute_logs ORDER BY started_at DESC LIMIT 6;\""
```
Expected: 3 条记录（daily_sales/daily_category/weekly_trend），status=success，triggered_by=`collect:<task_id>`；`report_daily_sales` 最新 biz_date 推进到今天/昨天。

- [ ] **Step 6: Commit**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(report-c): C1 采集 verified 后自动 /compute（service 身份，记 compute_logs+告警）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: C2 SKILL.md 汇总优先路由

**Files:**
- Modify: `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

- [ ] **Step 1: 在 SKILL.md「选明细还是汇总」段加汇总优先规则**

把 SKILL.md 的「## 选明细还是汇总」段替换为：
```markdown
## 选明细还是汇总（汇总优先）

**优先命中汇总表**：问历史日的总额/排名/占比/趋势 → 用 `report_daily_sales_v` / `report_daily_category_v` / `report_weekly_trend`（类型干净、快、列级脱敏）。只有下列情况才扫 `retail_detail` 明细：
- 问**今天/最近**（汇总表可能滞后约 1 天）。
- 要**单笔订单、具体商品行**等明细。
- 汇总表没有的维度。

维表（dim_item/dim_branch/dim_region）可直接查做 lookup。按战区/品类聚合历史 → 用汇总表 JOIN 维表；明细级 × 维度归类待 carry（C3）。
```

- [ ] **Step 2: 部署 plugin（SSH scp + restart，CLAUDE.md 不走 GHA）**

```bash
scp -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" \
  openclaw/data-query-plugin/skills/retail-query/SKILL.md \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/data-query-plugin/skills/retail-query/SKILL.md
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker restart deploy-openclaw-1"
```

- [ ] **Step 3: 验证（企微 bot 实测）**

企微里问 bot「上周各店销售额排名」——预期它查 `report_daily_sales_v`（而非扫 retail_detail），回答带日期+单位，不编造。

- [ ] **Step 4: Commit**

```bash
git add openclaw/data-query-plugin/skills/retail-query/SKILL.md
git commit -m "feat(report-c): C2 SKILL.md 汇总优先路由规则

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 端到端验证

- [ ] **Step 1: 列级闭环**

企微用 YangWei（can_see_cost=false）问「昨天各店销售额和利润」→ 利润列如实说"无权限/NULL"（不编数字）；用 ZhangDuo（can_see_cost=true）→ 利润有值。

- [ ] **Step 2: 自动算表新鲜度**

等一轮采集 cron（或手动触发）后，`SELECT MAX(biz_date) FROM report_daily_sales_v` 应推进到今天/昨天（不再卡 7-05）。

- [ ] **Step 3: 路由**

企微问历史排名 → bot 走 report_*_v（audit 表 `agent_query_logs` 的 `data_source=pg`）；问今天 → retail_detail（`data_source=duckdb`）。

- [ ] **Step 4: 更新 memory**

更新 `report-system-overview.md`：C0/C1/C2 标 ✅。

---

## Self-Review（已做）

- **Spec coverage**：spec C0（report_*_v 脱敏 + 原表收回）→ Task 1；C0 agent-query 路由 _v → Task 2；C1 compute_logs → Task 3；C1 scheduler 自动 /compute → Task 4；C2 路由 → Task 5；验证 → Task 6。weekly_trend 无成本列，不建 _v（已确认 009）。✅
- **Placeholder scan**：无 TBD/TODO；所有 SQL/TS/命令完整。✅
- **Type consistency**：`triggerCompute(client, dates, taskId)` 签名一致；`compute_logs` 字段（status/triggered_by）跨 Task 3/4 一致；report_type 名（daily_sales/daily_category/weekly_trend）跨 Task 1/4 一致。✅
