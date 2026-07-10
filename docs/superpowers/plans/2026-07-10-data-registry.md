# 子系统 B · 数据注册中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OpenClaw 取数的「数据知识」（可查数据集/列/敏感度/路由）从两处硬编码（`SKILL.md` + `agent-query/index.js`）收口到 PG 注册表，运行时双侧实时消费——LLM 拿活字典、引擎拿配置建视图/脱敏/路由。新增维表/报表=插一行自动感知。

**Architecture:** 新增 2 张表 `datasets`/`dataset_columns` + RPC `get_data_dictionary()`；改写 `functions/agent-query/index.js` 三处常量（`RETAIL_GLOB`/`COST_COLUMNS`/`REPORT_TABLES`）改读注册表 + 新增 dictionary 模式；OpenClaw 插件加 `list_datasets` 工具 + `SKILL.md` 瘦身为纯规则。退役臆想的 `data_sources_meta`。

**Tech Stack:** PostgreSQL + PostgREST（注册表/RPC）；Deno edge function（`agent-query` 网关，CommonJS）；OpenClaw native plugin（ESM `definePluginEntry`）。部署：迁移走 SSH psql 直应用 + postgrest 重启；function 走 SSH PUT + 清 Deno 缓存；插件走 scp + `install -l` + restart。

**Spec:** `docs/superpowers/specs/2026-07-10-data-registry-design.md`

**项目现实（影响测试策略）：** 本地无完整 InsForge+PostgREST+DuckDB+OpenClaw 栈，无法本地端到端测试（CLAUDE.md 明示）。故采用 **改完→部署→服务器验证** 节奏，不强行 TDD；可单测的纯函数（如脱敏列表构造）仍写 vitest。

---

## File Structure

- **Create:** `database/migrations/031_data_registry.sql` — 注册表 schema + 种真实数据 + RPC + grants + 退役 data_sources_meta。
- **Modify:** `functions/agent-query/index.js` — 三常量改读注册表 + 路由按 engine + dictionary 模式。
- **Modify:** `openclaw/data-query-plugin/dist/index.js` — 加 `list_datasets` 工具。
- **Modify:** `openclaw/data-query-plugin/skills/retail-query/SKILL.md` — 删硬编码字典，留规则 + 引导调 `list_datasets`。
- **Update:** `docs/architecture.md` — §4.x 记注册表为取数知识单一事实源（并入实现，收尾步骤）。

---

## Task 1: 迁移 031 — 注册表 + 种数据 + RPC + 退役

**Files:**
- Create: `database/migrations/031_data_registry.sql`

- [ ] **Step 1: 写迁移文件（schema + RPC + grants）**

`database/migrations/031_data_registry.sql`：

```sql
-- 031_data_registry.sql
-- 子系统B 数据注册中心：datasets + dataset_columns + get_data_dictionary() RPC
-- 取代 SKILL.md / agent-query 两处硬编码的数据知识。幂等（IF NOT EXISTS / ON CONFLICT）。

-- ===== 1. datasets：可查数据集注册表 =====
CREATE TABLE IF NOT EXISTS datasets (
    name            TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    engine          TEXT NOT NULL,             -- 'duckdb_view' | 'pg_table'
    source          TEXT NOT NULL,             -- duckdb_view: parquet glob；pg_table: PG 表名/视图名
    kind            TEXT NOT NULL,             -- 'fact' | 'summary' | 'dim' | 'view'
    is_realtime     BOOLEAN NOT NULL DEFAULT FALSE,
    columns_typed   BOOLEAN NOT NULL DEFAULT FALSE,
    date_column     TEXT,
    date_format     TEXT,
    carry_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    exposed         BOOLEAN NOT NULL DEFAULT TRUE,
    description     TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by      TEXT
);
COMMENT ON TABLE datasets IS '数据注册中心：可查数据集（LLM 字典 + agent-query 路由/脱敏单一事实源）';

DROP TRIGGER IF EXISTS update_datasets_updated_at ON datasets;
CREATE TRIGGER update_datasets_updated_at BEFORE UPDATE ON datasets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== 2. dataset_columns：列注册表 =====
CREATE TABLE IF NOT EXISTS dataset_columns (
    dataset_name    TEXT NOT NULL REFERENCES datasets(name) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    data_type       TEXT,
    semantic_group  TEXT,
    is_sensitive    BOOLEAN NOT NULL DEFAULT FALSE,
    join_to         TEXT,
    description     TEXT,
    ordinal         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dataset_name, name)
);
CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset ON dataset_columns(dataset_name);
COMMENT ON TABLE dataset_columns IS '数据集列注册表；is_sensitive 整组按 can_see_cost 脱敏';

-- ===== 3. get_data_dictionary() RPC =====
CREATE OR REPLACE FUNCTION get_data_dictionary()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE ds JSONB; cols JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.kind, d.name), '[]'::jsonb)
      INTO ds
      FROM (SELECT name, display_name, engine, kind, is_realtime, columns_typed,
                   date_column, date_format, carry_enabled, description
              FROM datasets WHERE exposed) d;
    SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.dataset_name, c.ordinal), '[]'::jsonb)
      INTO cols
      FROM (SELECT col.dataset_name, col.name, col.data_type, col.semantic_group,
                   col.is_sensitive, col.join_to, col.description, col.ordinal
              FROM dataset_columns col JOIN datasets ds ON ds.name = col.dataset_name
             WHERE ds.exposed) c;
    RETURN jsonb_build_object('datasets', ds, 'columns', cols);
END;
$$;
COMMENT ON FUNCTION get_data_dictionary IS '返回塑形数据字典（LLM 注入 + 引擎读取共用）';

-- ===== 4. 权限 =====
GRANT SELECT ON datasets, dataset_columns TO authenticated;
GRANT EXECUTE ON FUNCTION get_data_dictionary() TO authenticated;

-- ===== 5. 退役臆想的 data_sources_meta（同 lemeng_items 教训：只读保留备查）=====
REVOKE INSERT, UPDATE, DELETE ON data_sources_meta FROM anon, authenticated;
```

- [ ] **Step 2: 追加种数据（datasets 行）— 同文件追加**

```sql
-- ===== 6. 种真实数据集 =====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
 ('retail_detail','销售明细(乐檬POS明细)','duckdb_view',
  's3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet','fact',TRUE,FALSE,
  'order_detail_bizday','YYYYMMDD',FALSE,TRUE,'实时增量明细（当天有）；全字符串列，数学运算须 CAST'),
 ('report_daily_sales','每日门店销售汇总','pg_table','report_daily_sales','summary',FALSE,TRUE,
  'biz_date','DATE',FALSE,TRUE,'按日+门店汇总（/compute 写入，滞后约1天）'),
 ('report_daily_category','每日门店品类汇总','pg_table','report_daily_category','summary',FALSE,TRUE,
  'biz_date','DATE',FALSE,TRUE,'按日+门店+品类汇总'),
 ('report_weekly_trend','周销售趋势','pg_table','report_weekly_trend','summary',FALSE,TRUE,
  'week_start','DATE',FALSE,TRUE,'按周+门店，含环比'),
 ('dim_item','商品档案','pg_table','dim_item','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'商品维表；直接查询 OK，JOIN 进明细待 C(carry_enabled)'),
 ('canonical_product','跨品牌商品合并视图','pg_table','canonical_product','view',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'按 item_code 跨品牌合并'),
 ('dim_branch','门店档案','pg_table','dim_branch','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'门店维表；直接查询 OK，JOIN 进明细待 C'),
 ('dim_region','战区字典','pg_table','dim_region','dim',FALSE,TRUE,
  NULL,NULL,FALSE,TRUE,'区域→战区映射（统一管理）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  columns_typed=EXCLUDED.columns_typed, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, description=EXCLUDED.description;
```

- [ ] **Step 3: 追加种列（retail_detail 全量列）— 同文件追加**

```sql
-- ===== 7. retail_detail 列（成本组 is_sensitive=TRUE，整组脱敏）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('retail_detail','order_no','VARCHAR','订单',FALSE,NULL,'订单号',1),
 ('retail_detail','order_detail_num','VARCHAR','订单',FALSE,NULL,'明细号',2),
 ('retail_detail','order_time','VARCHAR','订单',FALSE,NULL,'下单时间 YYYY-MM-DD HH:MM:SS',3),
 ('retail_detail','order_detail_bizday','VARCHAR','订单',FALSE,NULL,'业务日 YYYYMMDD（按日过滤用）',4),
 ('retail_detail','order_sale_channel','VARCHAR','订单',FALSE,NULL,'销售渠道',5),
 ('retail_detail','order_sale_type','VARCHAR','订单',FALSE,NULL,'销售类型',6),
 ('retail_detail','state','VARCHAR','订单',FALSE,NULL,'状态',7),
 ('retail_detail','branch_num','VARCHAR','门店',FALSE,'dim_branch(system_book_code,branch_num)','门店号（JOIN 键）',8),
 ('retail_detail','branch_code','VARCHAR','门店',FALSE,NULL,'门店编码',9),
 ('retail_detail','branch_name','VARCHAR','门店',FALSE,NULL,'门店名',10),
 ('retail_detail','item_num','VARCHAR','商品',FALSE,'dim_item(system_book_code,item_num)','商品号（JOIN 键）',11),
 ('retail_detail','item_code','VARCHAR','商品',FALSE,'canonical_product(item_code)','商品业务码（跨品牌合并键）',12),
 ('retail_detail','item_name','VARCHAR','商品',FALSE,NULL,'商品名',13),
 ('retail_detail','item_category','VARCHAR','商品',FALSE,NULL,'品类',14),
 ('retail_detail','item_spec','VARCHAR','商品',FALSE,NULL,'规格',15),
 ('retail_detail','item_unit','VARCHAR','商品',FALSE,NULL,'单位',16),
 ('retail_detail','department','VARCHAR','商品',FALSE,NULL,'部门',17),
 ('retail_detail','item_regular_price','VARCHAR','商品',FALSE,NULL,'正常售价',18),
 ('retail_detail','supplier_num','VARCHAR','供应商',FALSE,NULL,'供应商号',19),
 ('retail_detail','supplier_name','VARCHAR','供应商',FALSE,NULL,'供应商名',20),
 ('retail_detail','supplier_code','VARCHAR','供应商',FALSE,NULL,'供应商码',21),
 ('retail_detail','sale_money','VARCHAR','金额',FALSE,NULL,'销售金额',22),
 ('retail_detail','discount_money','VARCHAR','金额',FALSE,NULL,'折扣金额',23),
 ('retail_detail','payment_receipt_money','VARCHAR','金额',FALSE,NULL,'收款金额',24),
 ('retail_detail','order_detail_price','VARCHAR','金额',FALSE,NULL,'明细单价',25),
 ('retail_detail','total_amount','VARCHAR','金额',FALSE,NULL,'总金额',26),
 ('retail_detail','tax_money','VARCHAR','金额',FALSE,NULL,'税额',27),
 ('retail_detail','discount_rate','VARCHAR','折扣率',FALSE,NULL,'折扣率',28),
 ('retail_detail','overall_discount_rate','VARCHAR','折扣率',FALSE,NULL,'整体折扣率',29),
 ('retail_detail','management_style_type','VARCHAR','经营',FALSE,NULL,'经营方式',30),
 ('retail_detail','order_payee','VARCHAR','经营',FALSE,NULL,'收款人',31),
 ('retail_detail','order_sold_by','VARCHAR','经营',FALSE,NULL,'销售员',32),
 ('retail_detail','item_cost_price','VARCHAR','成本',TRUE,NULL,'成本价（无权限=NULL）',33),
 ('retail_detail','order_detail_cost','VARCHAR','成本',TRUE,NULL,'明细成本（无权限=NULL）',34),
 ('retail_detail','order_detail_grade_cost','VARCHAR','成本',TRUE,NULL,'分级成本（无权限=NULL）',35),
 ('retail_detail','cost','VARCHAR','成本',TRUE,NULL,'成本（无权限=NULL）',36),
 ('retail_detail','profit','VARCHAR','成本',TRUE,NULL,'利润（无权限=NULL）',37),
 ('retail_detail','sale_profit_rate','VARCHAR','成本',TRUE,NULL,'利润率（无权限=NULL）',38)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type,
  semantic_group=EXCLUDED.semantic_group, is_sensitive=EXCLUDED.is_sensitive,
  join_to=EXCLUDED.join_to, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;
```

- [ ] **Step 4: 追加汇总表 + 维表关键列 — 同文件追加**

```sql
-- ===== 8. 汇总表列（已 typed，直接算无需 CAST）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, description, ordinal) VALUES
 ('report_daily_sales','biz_date','DATE','日期',FALSE,'业务日',1),
 ('report_daily_sales','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_daily_sales','branch_name','VARCHAR','门店',FALSE,'门店名',3),
 ('report_daily_sales','total_orders','INTEGER','订单',FALSE,'订单数',4),
 ('report_daily_sales','total_items','INTEGER','销量',FALSE,'商品件数',5),
 ('report_daily_sales','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',6),
 ('report_daily_sales','total_profit','DECIMAL(12,2)','成本',FALSE,'利润',7),
 ('report_daily_category','biz_date','DATE','日期',FALSE,'业务日',1),
 ('report_daily_category','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_daily_category','category','VARCHAR','商品',FALSE,'品类',3),
 ('report_daily_category','total_items','INTEGER','销量',FALSE,'商品件数',4),
 ('report_daily_category','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',5),
 ('report_daily_category','total_profit','DECIMAL(12,2)','成本',FALSE,'利润',6),
 ('report_weekly_trend','week_start','DATE','日期',FALSE,'周起始日',1),
 ('report_weekly_trend','branch_num','VARCHAR','门店',FALSE,'门店号',2),
 ('report_weekly_trend','branch_name','VARCHAR','门店',FALSE,'门店名',3),
 ('report_weekly_trend','total_sale','DECIMAL(12,2)','金额',FALSE,'销售额',4),
 ('report_weekly_trend','prev_week_sale','DECIMAL(12,2)','金额',FALSE,'上周销售额',5),
 ('report_weekly_trend','growth_rate','DECIMAL(5,2)','金额',FALSE,'环比增长率',6)
ON CONFLICT (dataset_name, name) DO NOTHING;

-- ===== 9. 维表关键列（直接查询用；JOIN 提示标 carry_enabled 状态）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('dim_item','system_book_code','TEXT','品牌',FALSE,NULL,'品牌(3120/64188)',1),
 ('dim_item','item_num','TEXT','商品',FALSE,'retail_detail(item_num)','商品号（品牌内）',2),
 ('dim_item','item_code','TEXT','商品',FALSE,'canonical_product(item_code)','跨品牌合并键',3),
 ('dim_item','item_name','TEXT','商品',FALSE,NULL,'商品名',4),
 ('dim_item','top_category','TEXT','商品',FALSE,NULL,'顶级品类',5),
 ('dim_item','category_path','TEXT','商品',FALSE,NULL,'品类全路径',6),
 ('canonical_product','item_code','TEXT','商品',FALSE,'retail_detail(item_code)','跨品牌合并键',1),
 ('canonical_product','display_name','TEXT','商品',FALSE,NULL,'展示名',2),
 ('canonical_product','top_category','TEXT','商品',FALSE,NULL,'顶级品类',3),
 ('canonical_product','brand_count','INTEGER','品牌',FALSE,NULL,'覆盖品牌数',4),
 ('dim_branch','system_book_code','TEXT','品牌',FALSE,NULL,'品牌',1),
 ('dim_branch','branch_num','TEXT','门店',FALSE,'retail_detail(branch_num)','门店号（JOIN 键）',2),
 ('dim_branch','branch_name','TEXT','门店',FALSE,NULL,'门店名',3),
 ('dim_branch','region_name','TEXT','门店',FALSE,NULL,'区域名',4),
 ('dim_branch','province','TEXT','门店',FALSE,NULL,'省',5),
 ('dim_branch','city','TEXT','门店',FALSE,NULL,'市',6),
 ('dim_branch','is_active','BOOLEAN','门店',FALSE,NULL,'是否启用',7),
 ('dim_region','region_name','TEXT','门店',FALSE,NULL,'区域名',1),
 ('dim_region','war_zone','TEXT','门店',FALSE,NULL,'战区（统一管理）',2)
ON CONFLICT (dataset_name, name) DO NOTHING;
```

- [ ] **Step 5: 应用迁移到生产（SSH psql 直应用）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" < database/migrations/031_data_registry.sql
```
Expected: 一串 `CREATE TABLE`/`CREATE FUNCTION`/`INSERT 0 n`/`GRANT`/`REVOKE`，无 ERROR。

- [ ] **Step 6: 重启 postgrest 刷 schema 缓存（CLAUDE.md 坑：加表/加 RPC 后必做）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 7: 验证表 + RPC 可读**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT name, engine, kind FROM datasets ORDER BY kind, name;\" && \
   docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) FROM dataset_columns WHERE dataset_name='retail_detail';\" && \
   docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) AS sensitive FROM dataset_columns WHERE is_sensitive;\""
```
Expected: 8 个 datasets；retail_detail 38 列；sensitive=6（成本组）。

- [ ] **Step 8: 提交迁移**

```bash
git add database/migrations/031_data_registry.sql
git commit -m "feat(report-B): 数据注册中心表+RPC+种数据(031)

datasets + dataset_columns + get_data_dictionary()，取代 SKILL.md/agent-query
两处硬编码。退役臆想 data_sources_meta 写权限。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 改写 agent-query 网关 — 读注册表 + dictionary 模式

**Files:**
- Modify: `functions/agent-query/index.js`
- Test: 服务器端验证（无本地 Deno+DuckDB 栈）

- [ ] **Step 1: 三常量改可回退 + 加 loadRegistry()**

把 `RETAIL_GLOB`/`COST_COLUMNS`/`REPORT_TABLES` 三个常量保留为**回退值**（注册表读失败时兜底，保证不线下），新增 `loadRegistry()`：

替换 `functions/agent-query/index.js` 第 16-28 行（三个常量块）为：

```js
// 注册表读失败时的回退值（保证不线下；正常走注册表）
const RETAIL_GLOB_FALLBACK = "s3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet";
const COST_COLUMNS_FALLBACK = ["item_cost_price","order_detail_cost","order_detail_grade_cost","cost","profit","sale_profit_rate"];
const REPORT_TABLES_FALLBACK = ["report_daily_sales","report_daily_category","report_weekly_trend"];
const MAX_ROWS = 1000;
const SHORT_JWT_TTL = 300;

// 注册表缓存（60s TTL，避免每查打 PG）
let REG_CACHE = null;
let REG_CACHE_TS = 0;
const REG_TTL_MS = 60000;

async function loadRegistry() {
  const now = Date.now();
  if (REG_CACHE && now - REG_CACHE_TS < REG_TTL_MS) return REG_CACHE;
  const headers = { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" };
  let retailGlob = RETAIL_GLOB_FALLBACK;
  let costColumns = COST_COLUMNS_FALLBACK.slice();
  let pgTables = REPORT_TABLES_FALLBACK.slice();
  try {
    const dsRes = await fetch(POSTGREST_URL + "/datasets?select=name,engine,source,exposed", { headers });
    if (dsRes.ok) {
      const ds = await dsRes.json();
      const retailRow = ds.find((d) => d.name === "retail_detail");
      if (retailRow && retailRow.source) retailGlob = retailRow.source;
      const pg = ds.filter((d) => d.exposed && d.engine === "pg_table").map((d) => d.name);
      if (pg.length) pgTables = pg;
    }
    const colRes = await fetch(POSTGREST_URL + "/dataset_columns?select=name&is_sensitive=eq.true", { headers });
    if (colRes.ok) {
      const cols = await colRes.json();
      if (Array.isArray(cols) && cols.length) costColumns = cols.map((c) => c.name);
    }
  } catch (e) {
    console.error("[agent-query] loadRegistry failed, using fallback:", String(e));
  }
  REG_CACHE = { retailGlob, costColumns, pgTables };
  REG_CACHE_TS = now;
  return REG_CACHE;
}
```
> 注意：`serviceJwt` 定义在下方（第 56 行）。`loadRegistry` 引用它——JS 函数提升不适用于 `async function` 赋值表达式？这里 `serviceJwt` 是 `async function` 声明（提升），可前向引用。OK。

- [ ] **Step 2: isReportQuery 改用注册表 pgTables**

替换第 76 行 `const isReportQuery = ...` 为：

```js
const isPgQuery = (sql, pgTables) => pgTables.some((t) => new RegExp("\\b" + t + "\\b", "i").test(sql));
```

- [ ] **Step 3: runDuckdb 用注册表 glob/成本列**

替换 `runDuckdb` 签名与 replaceList/viewSql（第 95-105 行）：

```js
async function runDuckdb(userSelect, perms, reg) {
  const allBranches = !Array.isArray(perms.branch_nums) || perms.branch_nums.length === 0 || perms.branch_nums.includes("*");
  const branchFilter = allBranches
    ? ""
    : "WHERE branch_num IN (" + perms.branch_nums.map(sqlLit).join(", ") + ")";
  const canSee = perms.can_see_cost ? "TRUE" : "FALSE";
  const replaceList = reg.costColumns.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  const viewSql =
    "CREATE OR REPLACE TEMP VIEW retail_detail AS " +
    "SELECT * REPLACE (" + replaceList + ") " +
    "FROM read_parquet('" + reg.retailGlob + "') " + branchFilter + ";";
  const combined = viewSql + "\n" + userSelect;
  const res = await fetch(DUCKDB_URL + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
    body: JSON.stringify({ sql: combined, user_id: perms.user_id }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error("duckdb:" + (body.error || res.status));
  return body.data;
}
```

- [ ] **Step 4: 入口加 dictionary 模式 + 路由用注册表**

替换入口 `module.exports = async function (req) {...}` 中 ① 认证之后、② 授权之前，插入 dictionary 分支；并把 ④/⑤ 路由改用 `reg`。即修改第 182-214 行区段：

```js
  // ① 认证
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) return json({ error: "unauthorized" }, 401);

  // ①.5 dictionary 模式（LLM list_datasets 工具拉字典；只需认证，不需 per-user 权限）
  if (body.mode === "dictionary") {
    try {
      const r = await fetch(POSTGREST_URL + "/rpc/get_data_dictionary", {
        method: "POST",
        headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
        body: "{}",
      });
      const dictionary = await r.json();
      return json({ success: true, dictionary });
    } catch (e) {
      return json({ error: "dictionary_failed", detail: String(e) }, 502);
    }
  }

  if (!sql || !userId) return json({ error: "missing sql/userId" }, 400);
```

并把路由段（原第 211 行 `const engine = isReportQuery(sql) ? "pg" : "duckdb";` 与 214 行调用）改为：

```js
  // ④/⑤ 引擎路由（pg_table 数据集→PG，否则→DuckDB；来源注册表）
  const reg = await loadRegistry();
  const engine = isPgQuery(sql, reg.pgTables) ? "pg" : "duckdb";
  let data, err;
  try {
    data = engine === "pg" ? await runPg(finalSql, userId, perms) : await runDuckdb(finalSql, perms, reg);
  } catch (e) {
    err = String(e.message || e);
  }
```

- [ ] **Step 5: 部署 function（SSH PUT + 清 Deno 缓存）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
body=$(jq -n --arg slug agent-query --arg name agent-query --arg desc "智能问数网关" --rawfile code "$PWD/../functions/agent-query/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/agent-query'
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```
Expected: PUT 返回该 function JSON（含新 code）；缓存清理+重启无报错。

- [ ] **Step 6: 验证 dictionary 模式 + 路由等价**

取 `AGENT_API_KEY`（服务器 `deploy/.env`）后：
```bash
# dictionary 模式应返回 8 个数据集 + 38 个 retail_detail 列 + 6 敏感列
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
  curl -s -X POST http://localhost:7130/functions/agent-query \
   -H "Content-Type: application/json" \
   -d "{\"mode\":\"dictionary\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq "{ds:(.dictionary.datasets|length), retail_cols:([.dictionary.columns[]|select(.dataset_name==\"retail_detail\")]|length), sensitive:([.dictionary.columns[]|select(.is_sensitive)]|length)}"'
```
Expected: `{"ds":8,"retail_cols":38,"sensitive":6}`。

再用一个真实门店权限用户跑两条 SQL 比对路由（明细→duckdb，汇总→pg）：
```bash
# 明细走 duckdb
... -d "{\"sql\":\"SELECT count(*) FROM retail_detail WHERE order_detail_bizday='20260709'\",\"userId\":\"<有权限wecom_id>\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq .engine
# 汇总走 pg
... -d "{\"sql\":\"SELECT sum(total_sale) FROM report_daily_sales WHERE biz_date=DATE '\''2026-07-09'\''\",\"userId\":\"<同上>\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq .engine
```
Expected: 分别 `"duckdb"`、`"pg"`；与改写前行为一致。

- [ ] **Step 7: 提交 function 改动**

```bash
git add functions/agent-query/index.js
git commit -m "feat(report-B): agent-query 网关读注册表(glob/成本列/路由)+dictionary模式

三处硬编码常量改读 datasets/dataset_columns(60s 缓存,回退值兜底);
新增 mode=dictionary 返回 get_data_dictionary 给 list_datasets 工具。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 插件加 list_datasets 工具 + SKILL.md 瘦身

**Files:**
- Modify: `openclaw/data-query-plugin/dist/index.js`
- Modify: `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

- [ ] **Step 1: dist/index.js 加 list_datasets 工具**

在 `openclaw/data-query-plugin/dist/index.js` 的 `TOOL_PARAMS` 定义后（第 34 行后）加：

```js
const LIST_TOOL_NAME = "list_datasets";
const LIST_TOOL_DESC =
  "列出当前可查的数据集（明细/汇总/维表）及其列、成本敏感标记、JOIN 提示、日期列与格式。" +
  "会话首次查询前调一次，了解能用哪些表/列、哪些列成本敏感（无权限会返回 NULL）。";
const LIST_TOOL_PARAMS = { type: "object", properties: {}, additionalProperties: false };

async function fetchDictionary(userId) {
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!agentApiKey) return { error: "网关密钥未配置（openclaw 容器缺 AGENT_API_KEY env）。" };
  let resp;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "dictionary", userId, agent_api_key: agentApiKey }),
    });
  } catch (e) {
    return { error: "查询网关不可达：" + ((e && e.message) || String(e)) };
  }
  let body = {};
  try { body = await resp.json(); } catch { body = {}; }
  if (!resp.ok || body.success !== true) return { error: body.error || "网关返回 HTTP " + resp.status };
  return body.dictionary;
}
```

在 `register(api)` 内现有 `api.registerTool(...)` 之后（第 168 行 `);` 之后、`},` 之前）追加第二个工具注册：

```js
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: LIST_TOOL_NAME,
          description: LIST_TOOL_DESC,
          parameters: LIST_TOOL_PARAMS,
          execute: () => fetchDictionary(userId),
        };
      },
      { name: LIST_TOOL_NAME },
    );
```

- [ ] **Step 2: 重写 SKILL.md（删硬编码字典，留规则 + 引导 list_datasets）**

整文件替换为：

```markdown
---
name: retail-query
description: 零售销售数据查询。用户问销售额/销量/订单/商品/门店/品类/利润/趋势等业务数据时激活，先用 list_datasets 看可用数据集，再用 query_retail_data 查。
metadata:
  openclaw:
    emoji: "📊"
---

# 零售数据查询 Skill

用户问**零售销售数据**（销售额、销量、订单数、商品排行、门店对比、品类占比、利润、环比趋势等）时使用。

## 工具

- **list_datasets()**：会话首查前调一次。返回可用数据集（明细/汇总/维表）+ 各列 + 成本敏感标记 + JOIN 提示 + 日期列/格式。**可用表/列以它返回为准，勿凭记忆。**
- **query_retail_data({ sql })**：单条 SELECT。自动按权限过滤门店、脱敏成本列——**不要**在 SQL 写权限条件。只允许 SELECT；禁 read_parquet/DDL/DML。无 LIMIT 时网关自动补 LIMIT 1000。结果超 50 行只回传前 50 + truncated。

## 五条原则

**0. 绝不编造数据（最高铁律）**：数据**只能**来自 query_retail_data 返回。工具没调/返回 error/返回空/拿不准时，如实说"我没能查到/当前无权限/该日无数据"，**绝对禁止**自编门店名、数字、排名、金额。宁可说查不到，绝不瞎编。

**1. 忠于用户原话**：说"前 N/Top N"→加 LIMIT N；说"排名/所有/全部"→不写 LIMIT（网关兜底），呈现时如实告知总数与是否截断。点名某店/品类→LIKE '%关键字%'；没点名→全量（权限自动过滤）。

**2. 日期忠于原话 + 必须显式标注**：明细日期列 `order_detail_bizday`（YYYYMMDD 字符串）；汇总日期列 `biz_date`/`week_start`（DATE）。"今天/最近/最新"用一条 SQL：`WHERE 日期列=(SELECT MAX(日期列) FROM 表)` 并带出 `data_date`；若 data_date≠今天就说"今天暂无，以下为最新 data_date 的数据"。回答里始终写明数据属于哪一天，绝不拿旧日冒充今天。按北京时间（容器 Asia/Shanghai）。

**3. 成本列无权限 = NULL，别当 0**：成本/利润为 NULL（无权限）→ 如实说"成本列无权限"，**别把 NULL 当 0 算进总额**（list_datasets 里 is_sensitive=true 的列即为成本组）。

**4. 一问一查**：能一条 SQL 搞定别拆多条。总额/计数/排名/占比用 SUM/COUNT 聚合，别把明细拉回来自己算。

## 选明细还是汇总

- 问**今天/最近**→优先明细 `retail_detail`（实时，当天有）；汇总表可能滞后约 1 天。
- 问**历史**日的总额/排名/占比/趋势→用汇总表（类型干净、快）。
- 要单笔订单、具体商品行、汇总表没有的维度→用 `retail_detail`。
- 维表（dim_item/dim_branch/dim_region）**可直接查询**做 lookup（如"有哪些门店/战区"）；但**暂不能 JOIN 进 retail_detail 聚合**（跨引擎）——需要按战区/品类聚合时，先查明细按 branch_num 聚合，或等标准报表。

## 呈现

中文回答，关键数字带单位 + 日期。**直接给结果**，不要"查询成功/我来查一下"等铺垫。truncated 时改用聚合/加 LIMIT 重查，或说明"共 N 条，此处列前 50"。
```

- [ ] **Step 3: 部署插件（scp + install -l + restart openclaw）**

插件目录在服务器为 `openclaw/state/plugins/` 下（架构 §5）。先确认实际路径，再 scp 覆盖 `dist/index.js` 与 `skills/retail-query/SKILL.md`，重装+重启：

```bash
# 1) scp 两个文件到服务器插件目录（路径按实际 install -l 的位置；先 ssh 查 openclaw.json 里 load.paths）
scp -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" \
  openclaw/data-query-plugin/dist/index.js \
  openclaw/data-query-plugin/skills/retail-query/SKILL.md \
  root@data.shanhaiyiguo.com:<插件实际路径>/

# 2) 容器内重装 + 重启（让新 SKILL.md/index.js 生效）
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-openclaw-1 openclaw plugins uninstall --force openclaw-plugin-data-query; \
   docker exec deploy-openclaw-1 openclaw plugins install -l <插件实际路径>; \
   cd /opt/data-analytics-platform/deploy && docker compose restart openclaw"
```
> ⚠️ 架构坑（§5）：`uninstall --force` 会残留 `load.paths` 指向已删目录 → gateway 崩溃循环。卸后必须 `openclaw doctor --fix` 或手清 `openclaw.json` 的 `load.paths`。若不确定，优先用覆盖文件 + restart（不 uninstall），仅当工具未刷新才走 install -l。

- [ ] **Step 4: 验证 list_datasets 工具对模型可用**

在 OpenClaw 对话里让 bot 调 `list_datasets`（或观察日志）：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker logs deploy-openclaw-1 --tail 50 2>&1 | grep -i 'list_datasets\|data-query'"
```
并在企微问 bot："现在能查哪些数据表？" → 期望它调 `list_datasets` 后如实列出 retail_detail / 3 汇总 / dim_*（不编造）。

- [ ] **Step 5: 提交插件改动**

```bash
git add openclaw/data-query-plugin/dist/index.js openclaw/data-query-plugin/skills/retail-query/SKILL.md
git commit -m "feat(report-B): OpenClaw 插件加 list_datasets 工具 + SKILL.md 瘦身

list_datasets 转发 agent-query dictionary 模式拿活字典；
SKILL.md 删硬编码列/成本组/报表清单，改引导 list_datasets，留五条规则。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 端到端验证 — 自动感知 + 脱敏 + 路由

- [ ] **Step 1: 插一行假维表 → LLM 下一轮自动可见（不重部署）**

直接插一行（不碰插件/function）：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"INSERT INTO datasets (name, display_name, engine, source, kind, exposed, description) VALUES ('dim_test_probe','测试探针','pg_table','dim_test_probe','dim',TRUE,'自动感知探针') ON CONFLICT(name) DO NOTHING;\""
```
再调 dictionary：
```bash
... -d "{\"mode\":\"dictionary\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq '[.dictionary.datasets[].name] | index("dim_test_probe")'
```
Expected: 返回索引（非 null）——**无重部署即生效**（60s 缓存过期后；可重启 deno 立即生效）。验证后清理：
```bash
... -c "DELETE FROM datasets WHERE name='dim_test_probe';"
```

- [ ] **Step 2: 成本脱敏仍正确（无 can_see_cost 用户查成本列全 NULL）**

取一个 `can_see_cost=false` 的用户，查含成本列的聚合：
```bash
... -d "{\"sql\":\"SELECT sum(CAST(profit AS DOUBLE)) AS p FROM retail_detail WHERE order_detail_bizday='20260709'\",\"userId\":\"<can_see_cost=false的用户>\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq .data
```
Expected: `p` 为 null（成本组被整组脱敏），不是数字。再用 `can_see_cost=true` 用户比对得非 null。

- [ ] **Step 3: 路由正确（明细→duckdb、汇总→pg、维表 lookup→pg）**

```bash
# 维表直接查询应走 pg
... -d "{\"sql\":\"SELECT branch_name FROM dim_branch LIMIT 5\",\"userId\":\"<用户>\",\"agent_api_key\":\"$AGENT_API_KEY\"}" | jq .engine
```
Expected: `"pg"`（dim_branch 是 pg_table）。明细→`"duckdb"`、汇总→`"pg"`（Task2 Step6 已验）。

- [ ] **Step 4: 更新架构文档 docs/architecture.md**

在 §4（取数/OpenClaw）相关段补一条：数据知识单一事实源 = `datasets`/`dataset_columns`（迁移 031）+ `get_data_dictionary()`；`agent-query` 与 OpenClaw `list_datasets` 运行时实时消费；退役 `data_sources_meta`。提交：
```bash
git add docs/architecture.md
git commit -m "docs(report-B): 架构文档记数据注册中心为取数知识单一事实源

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 5: push 触发 GHA（让 031 迁移进线上迁移序列 + 归档）**

> 注：031 已在 Step5 直应用，GHA 重跑 migrate.sh 幂等无副作用；function/插件已 SSH 部署，GHA Step4 会重 PUT function（容错）。
```bash
git push origin main && gh run watch --exit-status
```

---

## Self-Review（plan 自检，实现前确认无漏）

- **Spec 覆盖**：datasets/dataset_columns ✓（T1）、get_data_dictionary ✓（T1）、双侧实时 ✓（T2 引擎/T3 LLM）、退役 data_sources_meta ✓（T1）、复用 report_definitions（不重建，仅曝光 summary 行）✓、B/C 时序（维表 carry_enabled=false）✓。
- **占位扫描**：无 TBD/TODO；所有 SQL/JS 代码完整可执行；命令含真实路径与占位符（`<用户>`/`<插件实际路径>`）已在步骤中标注「先 ssh 查实际值」。
- **类型/命名一致**：`loadRegistry()` 返回 `{retailGlob,costColumns,pgTables}`；`runDuckdb(userSelect,perms,reg)` 第三参 `reg`；`isPgQuery(sql,pgTables)`；插件 `fetchDictionary(userId)` ↔ 网关 `mode:"dictionary"`。RPC 名 `get_data_dictionary` / 路由 `/rpc/get_data_dictionary` 三处一致。
- **幂等**：迁移全 `IF NOT EXISTS`/`ON CONFLICT`；视图无（本迁移不建视图）。加表+加 RPC 后重启 postgrest（T1 Step6）。
- **风险守**：回退值兜底（注册表读失败不线下）；成本组整组脱敏（`WHERE is_sensitive` 一次性取全部）；路由解析用 `\b表名\b` 正则（退化等价原 `isReportQuery`）。
