# Plan 2: carry 维表物化（C3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 维表（dim_branch/dim_item/dim_region）从 PG 物化到 S3 parquet，让 DuckDB 明细能 JOIN 维表（按战区/品类归类），定时 + 变更回调双触发同步。DuckDB 全程不连 PG（零 attach，无绕过风险）。

**Architecture:** duckdb-service 加 `/carry-dims` 端点（pgPool 读 dim_* → DuckDB COPY parquet S3）；agent-query view builder 暴露 dim_* TEMP VIEW；scheduler 定时兜底 + 采集维表后回调触发；datasets 登记 dim_* 为 duckdb_view。

**Tech Stack:** duckdb-service（services/server.js，pg + duckdb）/ S3 parquet / agent-query function / node-cron scheduler / Next.js routes。

> **测试约定**：无单测，靠 psql/curl/企微验证。每任务：实现 → 验证 → commit。
> **安全**：dim_item.item_cost_price 是成本敏感列——carry 导出为 NULL（维表 parquet 不含成本价）。

---

## 文件结构

- **Modify** `services/server.js` — 加 `/carry-dims` 端点（pgPool 读 → COPY parquet）
- **Create** `database/migrations/034_dim_carry_datasets.sql` — dim_* 改 duckdb_view + carry_enabled
- **Modify** `functions/agent-query/index.js` — loadRegistry 取 carry 维表 + runDuckdb 建 dim_* 视图
- **Modify** `web/lib/scheduler.ts` — registerCarryDimsJob 定时兜底
- **Modify** `web/app/api/admin/collect-branches/route.ts` + `collect-items/route.ts` — verified 后回调 carry-dims

---

## Task 1: duckdb-service /carry-dims 端点

**Files:**
- Modify: `services/server.js`（在 `/compute` 端点后追加 `/carry-dims`）

- [ ] **Step 1: 在 services/server.js 的 /compute 端点（约 line 561 `});` 后）追加**

```javascript
// C3 carry: PG 维表 → S3 parquet（pgPool 读 → DuckDB COPY；不 attach、DuckDB 不连 PG）。
// dim_item.item_cost_price 成本敏感 → 导出 NULL（维表 parquet 不含成本价）。
app.post("/carry-dims", async (req, res) => {
  const key = req.headers["x-agent-key"];
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) return res.status(401).json({ error: "unauthorized" });
  if (!pgPool) return res.status(500).json({ error: "PostgreSQL not configured" });
  const startedAt = Date.now();
  const dims = [
    { name: "dim_branch", sql: "SELECT system_book_code, branch_num, branch_id, branch_code, branch_name, region_name, province, city, district, address, phone, longitude, latitude FROM dim_branch WHERE is_active" },
    { name: "dim_item",   sql: "SELECT system_book_code, item_num, item_code, bar_code, item_name, category_code, category_name, category_path, top_category, item_brand, department, item_unit, item_regular_price, NULL::text AS item_cost_price, supplier_name, item_tags FROM dim_item WHERE is_active" },
    { name: "dim_region", sql: "SELECT region_name, war_zone, sub_region, display_name FROM dim_region" },
  ];
  const results = [];
  try {
    for (const d of dims) {
      const { rows } = await pgPool.query(d.sql);
      if (!rows.length) { results.push({ name: d.name, records: 0 }); continue; }
      const schema = Object.keys(rows[0]);
      const colsDef = schema.map(c => `"${c}" VARCHAR`).join(", ");
      await runQuery(`CREATE OR REPLACE TABLE carry_temp (${colsDef})`);
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        const values = batch.map(r => "(" + schema.map(c => escapeSQL(r[c] == null ? null : String(r[c]))).join(", ") + ")").join(", ");
        await runQuery(`INSERT INTO carry_temp VALUES ${values}`);
      }
      const s3Path = `s3://${S3_BUCKET}/dims/${d.name}.parquet`;
      await runQuery(`COPY carry_temp TO '${s3Path}' (FORMAT PARQUET)`);
      const cnt = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) c FROM carry_temp");
      results.push({ name: d.name, records: cnt[0]?.c || rows.length, path: s3Path });
      console.log(`[carry-dims] ${d.name}: ${cnt[0]?.c || rows.length} rows → ${s3Path}`);
    }
    res.json({ success: true, duration_ms: Date.now() - startedAt, results });
  } catch (err) {
    console.error("[carry-dims] Error:", err.message);
    res.status(500).json({ error: err.message, results });
  }
});
```

- [ ] **Step 2: Commit + push GHA 部署 duckdb-service**

```bash
git add services/server.js
git commit -m "feat(report-c): C3 /carry-dims 端点（pgPool 读 dim_*→COPY parquet S3，不 attach）

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
gh run watch     # 等 GHA 绿
```

- [ ] **Step 3: 手动调 /carry-dims 验证 parquet 生成（初始化 + 冒烟）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   curl -sf -X POST http://duckdb:9000/carry-dims -H "x-agent-key: $INSFORGE_API_KEY"'
```
Expected: `{ success: true, results: [{name:"dim_branch", records:385, ...}, {name:"dim_item", records:40963, ...}, {name:"dim_region", records:19, ...}] }`。

- [ ] **Step 4: 验证 S3 parquet 存在 + dim_item 无成本价**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   curl -sf -X POST http://duckdb:9000/query -H "Content-Type: application/json" -H "x-agent-key: $INSFORGE_API_KEY" \
     -d "{\"sql\":\"SELECT count(*) c, count(item_cost_price) cost_nonnull FROM read_parquet('"'"'s3://lemeng-datasource/dims/dim_item.parquet'"'"')\"}"'
```
Expected: dim_item 行数 ~40963，**cost_nonnull=0**（item_cost_price 全 NULL，敏感列已脱敏）。

---

## Task 2: datasets 登记 dim_* 为 duckdb_view（迁移 034）

**Files:**
- Create: `database/migrations/034_dim_carry_datasets.sql`

- [ ] **Step 1: 写迁移**

```sql
-- 034_dim_carry_datasets.sql
-- C3: dim_* 改 duckdb_view（source=carry 出的 parquet），carry_enabled=true。
-- 明细 JOIN dim_* 走 DuckDB（parquet）；dim_* 单独查也走 DuckDB parquet（维表慢变，carry 对齐）。
UPDATE datasets SET engine='duckdb_view', carry_enabled=true, kind='dim', description='维表(carry物化)；JOIN 进明细 OK，直接查也走 parquet'
WHERE name IN ('dim_branch','dim_item','dim_region');
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_branch.parquet' WHERE name='dim_branch';
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_item.parquet'   WHERE name='dim_item';
UPDATE datasets SET source='s3://lemeng-datasource/dims/dim_region.parquet' WHERE name='dim_region';
DO $$ BEGIN RAISE NOTICE 'Migration 034_dim_carry_datasets applied'; END $$;
```

- [ ] **Step 2: 应用迁移 + restart postgrest**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" \
  < database/migrations/034_dim_carry_datasets.sql
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: Commit + push（迁移随 GHA 重跑幂等）**

```bash
git add database/migrations/034_dim_carry_datasets.sql
git commit -m "feat(report-c): C3 datasets dim_* 改 duckdb_view + carry_enabled

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

---

## Task 3: agent-query view builder 建 dim_* TEMP VIEW

**Files:**
- Modify: `functions/agent-query/index.js`（loadRegistry 取 carry 维表；runDuckdb 建多视图）

- [ ] **Step 1: loadRegistry 增加 dimCarry（维表 parquet glob 列表）**

在 `loadRegistry()`（约 line 28-55）的 `REG_CACHE = { retailGlob, costColumns, pgTables }` 改为加 `dimCarry`：
```javascript
  let dimCarry = []; // [{name, glob}] carry 物化的维表（duckdb_view + carry_enabled）
  // ...在 fetch datasets 后：
  const retailRow = ds.find((d) => d.name === "retail_detail");
  if (retailRow && retailRow.source) retailGlob = retailRow.source;
  const dimRows = ds.filter((d) => d.engine === "duckdb_view" && d.kind === "dim");
  if (dimRows.length) dimCarry = dimRows.map((d) => ({ name: d.name, glob: d.source }));
  // ...
  REG_CACHE = { retailGlob, costColumns, pgTables, dimCarry };
```

- [ ] **Step 2: runDuckdb 建 dim_* TEMP VIEW（read_parquet 维表 parquet）**

在 `runDuckdb()`（约 line 120-141）的 viewSql 拼接里，retail_detail 视图后追加 dim_* 视图：
```javascript
async function runDuckdb(userSelect, perms, reg) {
  const allBranches = !Array.isArray(perms.branch_nums) || perms.branch_nums.length === 0 || perms.branch_nums.includes("*");
  const branchFilter = allBranches ? "" : "WHERE branch_num IN (" + perms.branch_nums.map(sqlLit).join(", ") + ")";
  const canSee = perms.can_see_cost ? "TRUE" : "FALSE";
  const replaceList = reg.costColumns.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  // retail_detail 视图（行过滤 + 成本脱敏）
  let viewSql =
    "CREATE OR REPLACE TEMP VIEW retail_detail AS " +
    "SELECT * REPLACE (" + replaceList + ") " +
    "FROM read_parquet('" + reg.retailGlob + "') " + branchFilter + ";\n";
  // dim_* carry 视图（字典，无过滤；维表 parquet 已不含成本价）
  for (const d of (reg.dimCarry || [])) {
    viewSql += "CREATE OR REPLACE TEMP VIEW " + d.name + " AS SELECT * FROM read_parquet('" + d.glob + "');\n";
  }
  const combined = viewSql + "\n" + userSelect;
  // ...（fetch /query 不变）
```

- [ ] **Step 3: SSH PUT 部署 agent-query function（CLAUDE.md 只改 function 走 SSH）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
   body=$(jq -n --arg slug agent-query --arg name agent-query --arg desc agent-query --rawfile code "$PWD/../functions/agent-query/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
   curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/agent-query'
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 4: 验证 dim_* 可查 + 明细 JOIN dim_***

```bash
# dim_branch 单独查（走 DuckDB parquet）
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query -H "Content-Type: application/json" \
  -d '{"sql":"SELECT count(*) c FROM dim_branch","userId":"ZhangDuo","agent_api_key":"'$AGENT_API_KEY'"}'
# 明细 JOIN dim_branch（跨引擎已解决）
curl -s -X POST https://data.shanhaiyiguo.com/functions/agent-query -H "Content-Type: application/json" \
  -d '{"sql":"SELECT b.region_name, count(*) orders FROM retail_detail d JOIN dim_branch b ON d.branch_num=b.branch_num GROUP BY 1 ORDER BY 2 DESC LIMIT 5","userId":"ZhangDuo","agent_api_key":"'$AGENT_API_KEY'"}'
```
Expected: dim_branch count=385；JOIN 返回各 region 订单数（不再报"跨引擎"错）。

- [ ] **Step 5: Commit + push**

```bash
git add functions/agent-query/index.js
git commit -m "feat(report-c): C3 agent-query 建 dim_* TEMP VIEW（明细 JOIN 维表，carry parquet）

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
```

---

## Task 4: scheduler registerCarryDimsJob 定时兜底

**Files:**
- Modify: `web/lib/scheduler.ts`（加 registerCarryDimsJob + 在 ensureSchedulerInitialized 调用）

- [ ] **Step 1: 加 registerCarryDimsJob（对齐 registerContactSyncJob 模式）**

在 `registerContactSyncJob()` 函数后追加：
```typescript
// C3: 维表 carry 定时兜底（每天 04:33，避开通讯录 03:17；对齐 registerContactSyncJob 模式）
function registerCarryDimsJob() {
  const JOB_KEY = "__carry_dims";
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate("33 4 * * *")) return;
  const job = cron.schedule("33 4 * * *", async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 维表 carry 定时兜底触发");
      const resp = await fetch(`${DUCKDB_URL}/carry-dims`, {
        method: "POST", headers: { "x-agent-key": INSFORGE_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log("[scheduler] carry-dims 结果:", resp.status, data);
    } catch (e: any) {
      console.error("[scheduler] carry-dims 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册维表 carry 兜底 (33 4 * * *, Asia/Shanghai)");
}
```

- [ ] **Step 2: 在 ensureSchedulerInitialized 里调用（registerContactSyncJob() 附近）**

找到 `ensureSchedulerInitialized` 里调用 `registerContactSyncJob()` 的地方，其后加：
```typescript
  registerCarryDimsJob();
```

- [ ] **Step 3: Commit + push GHA**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(report-c): C3 scheduler registerCarryDimsJob 定时兜底（每天04:33）

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main && gh run watch
```

---

## Task 5: collect-branches/items verified 后回调 carry-dims

**Files:**
- Modify: `web/app/api/admin/collect-branches/route.ts`、`collect-items/route.ts`

- [ ] **Step 1: collect-branches route 在 verified 后触发 carry（line 61 finalStatus 后、return 前）**

在 `collect-branches/route.ts` 的 `const finalStatus = ...` 之后、`return NextResponse.json(...)` 之前插入：
```typescript
    // C3: 门店档案采集后回调 carry-dims（fire-and-forget，维表刷新）
    if (!result.error && result.verified) {
      fetch(`${process.env.DUCKDB_URL || "http://duckdb:9000"}/carry-dims`, {
        method: "POST", headers: { "x-agent-key": process.env.INSFORGE_API_KEY! },
      }).catch(() => {});
    }
```

- [ ] **Step 2: collect-items route 同理（line 77 writeLog 附近，verified 后）**

在 `collect-items/route.ts` 的 writeLog 之后、return 之前插入同样的 carry-dims 回调块（商品档案采集后刷新 dim_item parquet）。

- [ ] **Step 3: Commit + push GHA**

```bash
git add web/app/api/admin/collect-branches/route.ts web/app/api/admin/collect-items/route.ts
git commit -m "feat(report-c): C3 采集维表后回调 carry-dims（变更触发维表刷新）

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main && gh run watch
```

---

## Task 6: 端到端验证

- [ ] **Step 1: 明细 JOIN 维表（企微 bot）**

企微问 bot「昨天各战区订单数排名」→ 应走 `retail_detail JOIN dim_branch`（DuckDB），返回战区聚合（不再说"暂不能 JOIN"）。

- [ ] **Step 2: 维表单独查**

问「有哪些战区」→ 走 dim_region parquet。

- [ ] **Step 3: 变更回调**

手动触发一次 collect-branches（后台采集门店），之后查 dim_branch parquet 时间戳更新（S3 文件覆盖）。

- [ ] **Step 4: 更新 memory**

`report-system-overview.md`：C3 标 ✅。

---

## Self-Review（已做）

- **Spec coverage**：spec C3 ①导出（Task 1）/ ②触发定时+回调（Task 4/5）/ ③查询 view builder（Task 3）/ ④新鲜度（回调+定时覆盖）/ ⑤datasets（Task 2）。✅
- **安全**：dim_item.item_cost_price carry 导出 NULL（Task 1 SQL + Task 1 Step 4 验证 cost_nonnull=0）。✅
- **绕过风险**：DuckDB 查询路径只 read_parquet 维表 parquet，不连 PG（无 attach）。✅
- **Placeholder scan**：无 TBD；端点/迁移/view builder/回调代码完整。✅
- **类型一致**：`REG_CACHE.dimCarry`（Task 3 Step 1）↔ `reg.dimCarry`（Step 2）；`/carry-dims` 端点名跨 Task 一致。✅
