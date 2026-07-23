# 语义层 A4 dim_customer 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建批发客户维度 dim_customer——从 wholesale_detail parquet 派生物化（DuckDB DISTINCT），注册到语义层维度模型 + 日 cron 调度。

**Architecture:** 仿 dim_branch（029）建 dim_customer/dim_customer_ext/customer_full；仿 /compute 的 DuckDB 读 parquet 模式建 /derive-dim-customer endpoint（派生+软删除+upsert PG）；dim_customer 注册 datasets(kind=dim,carry_enabled) 让 carry-dims 自动 COPY parquet；仿 registerCarryDimsJob 建日 cron 04:20（carry 04:33 前）。

**Tech Stack:** PostgreSQL（migration）、Node（services/server.js DuckDB+pg）、node-cron（web/lib/scheduler.ts）

## Global Constraints

- 建表仿 029_dim_branch（base + ext FK CASCADE + is_active 软删除 + _full 视图 + GRANT）；视图 `DROP+CREATE` 禁 `CREATE OR REPLACE`
- endpoint 仿 /compute（共享 runQuery 读 parquet）+ upsertRow（634，自动 updated_at=NOW()）；鉴权 `x-agent-key == AGENT_API_KEY`
- 所有 DDL 幂等（CREATE TABLE IF NOT EXISTS + ON CONFLICT）；部署后须 `docker compose restart postgrest`（新表+维度注册刷 schema 缓存）
- wholesale_detail parquet：路径 `s3://lemeng-datasource/lemeng/wholesale_detail/*/*/all.parquet`，列 `client_code`/`client_name`/`audit_time`(VARCHAR 日期)；批发只 3120 采集（parquet 无 system_book_code 列）→ 派生硬编码 `'3120'`
- duckdb 共享 conn runQuery（仿 /compute，只读派生）；04:20 无其他 duckdb 任务，安全
- derived 维度（customer）validate_semantic_registry 跳过 join_key 物化校验（078:34-35）

## Scope
**包含**：082 建表 + datasets 注册、083 维度注册、/derive-dim-customer endpoint、registerDimCustomerJob cron、部署验证
**不含**：客户维度视图（A2 生成器扩展，后续）、客户报表页（Phase 2）、client_name→门店匹配收敛（后续）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `database/migrations/082_dim_customer.sql` | dim_customer + dim_customer_ext + customer_full + datasets 注册 + GRANT |
| `database/migrations/083_register_customer_dimension.sql` | dimensions + dimension_levels 注册 customer 单层 derived |
| `services/server.js` | 新增 `/derive-dim-customer` endpoint（插 carry-dims 后） |
| `web/lib/scheduler.ts` | 新增 `registerDimCustomerJob()`（cron 04:20）+ 注册点 |

---

## Task 1: 082 建表 + datasets 注册

**Files:**
- Create: `database/migrations/082_dim_customer.sql`

**Interfaces:**
- Consumes: 无（首个 task）
- Produces: PG 表 `dim_customer`/`dim_customer_ext`、视图 `customer_full`、datasets 行 `dim_customer`(kind=dim,carry_enabled=true)

- [ ] **Step 1: 写期望验证查询**
```sql
SELECT COUNT(*) FROM dim_customer;  -- 0（建表后未派生）
SELECT kind, carry_enabled FROM datasets WHERE name='dim_customer';  -- dim / true
```

- [ ] **Step 2: 跑确认失败**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT COUNT(*) FROM dim_customer;"
```
Expected: ERROR `relation "dim_customer" does not exist`

- [ ] **Step 3: 写迁移**
创建 `database/migrations/082_dim_customer.sql`：
```sql
-- 082_dim_customer.sql
-- 批发客户维度（从 wholesale_detail parquet 派生物化，仿 dim_branch 029）
-- base 派生覆盖 + ext 人工维护(FK CASCADE) + is_active 软删除 + customer_full 视图
-- 注册 datasets(kind=dim,carry_enabled) → carry-dims 自动 COPY parquet
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT + DROP/CREATE VIEW；部署后重启 postgrest

CREATE TABLE IF NOT EXISTS dim_customer (
    system_book_code  TEXT NOT NULL,
    client_code       TEXT NOT NULL,          -- 批发客户号（品牌内编号）
    client_name       TEXT,                    -- 最近客户名（派生 arg_max by audit_time）
    first_order_date   DATE,                   -- 首单
    last_order_date    DATE,                   -- 末单（活跃/流失判断）
    active_days        INT,                    -- 活跃天数
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,  -- 软删除：派生未见→false
    raw                JSONB,
    updated_at         TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, client_code)
);
COMMENT ON TABLE dim_customer IS '批发客户维度（wholesale_detail 派生；PK 品牌隔离；is_active 软删除）';

CREATE TABLE IF NOT EXISTS dim_customer_ext (
    system_book_code  TEXT NOT NULL,
    client_code       TEXT NOT NULL,
    custom_group      TEXT,                    -- 客户分组（人工）
    note              TEXT,                    -- 备注（人工）
    updated_at        TIMESTAMP DEFAULT NOW(),
    updated_by        TEXT,
    PRIMARY KEY (system_book_code, client_code),
    FOREIGN KEY (system_book_code, client_code)
      REFERENCES dim_customer(system_book_code, client_code) ON DELETE CASCADE
);
COMMENT ON TABLE dim_customer_ext IS '批发客户扩展（人工维护，派生绝不写；软删除 is_active=false 不触发 CASCADE，ext 保留）';

DROP VIEW IF EXISTS customer_full;
CREATE VIEW customer_full AS
SELECT c.system_book_code, c.client_code, c.client_name,
       c.first_order_date, c.last_order_date, c.active_days, c.is_active,
       e.custom_group, e.note
FROM dim_customer c
LEFT JOIN dim_customer_ext e
  ON c.system_book_code = e.system_book_code AND c.client_code = e.client_code;
ALTER VIEW customer_full SET (security_invoker = true);
COMMENT ON VIEW customer_full IS '客户+扩展视图（base JOIN ext）';

-- datasets 注册（carry-dims 读 kind=dim AND carry_enabled=true 自动 COPY parquet）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, carry_enabled, exposed, description) VALUES
 ('dim_customer','批发客户维度(派生)','pg_table','dim_customer','dim',FALSE,FALSE,NULL,TRUE,FALSE,
  '批发客户维度（从 wholesale_detail 派生；carry-dims 自动 COPY 到 s3://dims/dim_customer.parquet）')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, carry_enabled=EXCLUDED.carry_enabled,
  exposed=EXCLUDED.exposed, description=EXCLUDED.description;

GRANT SELECT ON dim_customer, customer_full TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON dim_customer_ext TO authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 082_dim_customer completed'; END $$;
```

- [ ] **Step 4: 应用 + 验证**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -f database/migrations/082_dim_customer.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT kind, carry_enabled FROM datasets WHERE name='dim_customer';"
```
Expected: 082 跑通无错；datasets 查询返回 `dim / t`。

- [ ] **Step 5: Commit**
```bash
git add database/migrations/082_dim_customer.sql
git commit -m "feat(db): dim_customer table + datasets registration (semantic layer A4)"
```

---

## Task 2: 083 注册 customer 维度

**Files:**
- Create: `database/migrations/083_register_customer_dimension.sql`

**Interfaces:**
- Consumes: `dim_customer` 表（Task 1）、A1 的 `dimensions`/`dimension_levels`
- Produces: dimensions 行 `customer`(derived) + dimension_levels 行 `customer`(单层 depth 0)；validate_semantic_registry 对 derived 跳过 join_key 校验

- [ ] **Step 1: 写迁移**
创建 `database/migrations/083_register_customer_dimension.sql`：
```sql
-- 083_register_customer_dimension.sql
-- 注册 customer 维度（单层 derived），仿 077 branch/item
-- derived 维度：validate_semantic_registry 跳过 join_key 物化校验（物化由 082 + /derive 保证）
-- 幂等：ON CONFLICT；部署后重启 postgrest

INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter) VALUES
 ('customer','客户','批发客户维度（从 wholesale_detail 派生）','derived','dim_customer','client_code','wholesale_detail',
  '从批发明细 DISTINCT client_code 派生（乐檬无客户档案 API）', false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, source_type=EXCLUDED.source_type,
  join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key,
  source_fact_table=EXCLUDED.source_fact_table, business_rule=EXCLUDED.business_rule,
  is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level, rollup_strategy) VALUES
 ('customer','customer','客户',0,'client_code','client_name', NULL, 'sum')
ON CONFLICT (dim_code, level_code) DO UPDATE SET
  level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column,
  name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level, rollup_strategy=EXCLUDED.rollup_strategy;

DO $$ BEGIN RAISE NOTICE 'Migration 083: registered customer dimension (single level, derived)'; END $$;
```

- [ ] **Step 2: 应用 + 验证（含 validate）**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -f database/migrations/083_register_customer_dimension.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT dim_code, level_code, depth FROM dimension_levels WHERE dim_code='customer';"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT * FROM validate_semantic_registry();"
```
Expected: dimension_levels 返回 1 行（customer/customer/0）；validate 返回 0 行（derived 维度跳过 join_key 校验，配置健康）。

- [ ] **Step 3: Commit**
```bash
git add database/migrations/083_register_customer_dimension.sql
git commit -m "feat(db): register customer dimension single-level (semantic layer A4)"
```

---

## Task 3: /derive-dim-customer endpoint

**Files:**
- Modify: `services/server.js`（carry-dims endpoint 结束后，约 615 行 `});` 之后插入新 endpoint）

**Interfaces:**
- Consumes: `dim_customer` 表（Task 1）、共享 `runQuery`/`pgPool`/`upsertRow`/`AGENT_API_KEY`/`configureS3`（server.js 既有）
- Produces: `POST /derive-dim-customer` → `{ derived, active }`；软删除+upsert dim_customer

- [ ] **Step 1: 写 endpoint**

在 `services/server.js` 的 `/carry-dims` endpoint 结束（`});` 约 615 行）之后、`function transformRow`（617）之前，插入：
```js
// A4 derive: wholesale_detail parquet → dim_customer（派生物化）
// DuckDB 读 parquet 全历史 DISTINCT → 软删除(is_active=false) → upsert(标回 true)
// COPY parquet 由 carry-dims 自动（dim_customer 注册 datasets kind=dim carry_enabled）
app.post("/derive-dim-customer", async (req, res) => {
  const reqKey = req.headers["x-agent-key"]
    || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!pgPool) return res.status(500).json({ error: "PostgreSQL not configured" });
  const startedAt = Date.now();
  try {
    // 1. DuckDB 派生（共享 conn；批发只 3120，parquet 无 system_book_code 列→硬编码）
    const deriveSql = `
      SELECT '3120' AS system_book_code, client_code,
             arg_max(client_name, audit_time) AS client_name,
             MIN(CAST(audit_time AS DATE)) AS first_order_date,
             MAX(CAST(audit_time AS DATE)) AS last_order_date,
             COUNT(DISTINCT CAST(audit_time AS DATE)) AS active_days
      FROM read_parquet('s3://${S3_BUCKET}/lemeng/wholesale_detail/*/*/all.parquet')
      WHERE client_code IS NOT NULL AND client_code <> ''
      GROUP BY client_code`;
    const rows = await runQuery(deriveSql);
    console.log(`[derive-dim-customer] derived ${rows.length} customers`);

    // 2. 软删除：全量标非活跃（upsert 见到的会标回 true）
    await pgPool.query("UPDATE dim_customer SET is_active = false, updated_at = NOW()");

    // 3. upsert（is_active=true；updated_at 由 upsertRow 自动 NOW()）
    for (const r of rows) {
      await upsertRow('dim_customer', {
        system_book_code: r.system_book_code,
        client_code: r.client_code,
        client_name: r.client_name,
        first_order_date: r.first_order_date,
        last_order_date: r.last_order_date,
        active_days: r.active_days,
        is_active: true,
      }, ['system_book_code', 'client_code']);
    }

    // 4. 统计
    const cnt = await pgPool.query("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS a FROM dim_customer");
    res.json({
      success: true,
      derived: rows.length,
      total: cnt.rows[0].n,
      active: cnt.rows[0].a,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[derive-dim-customer] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: node 语法检查**
```bash
cd /Users/duo/Documents/mytechcode/data-analysis/services && node -c server.js && echo "syntax OK"
```
Expected: `syntax OK`（无语法错误）。

- [ ] **Step 3: Commit（真实派生验证留 Task 5 生产，本地 dev 无 S3 parquet 全量）**
```bash
cd /Users/duo/Documents/mytechcode/data-analysis && git add services/server.js
git commit -m "feat(services): /derive-dim-customer endpoint (wholesale_detail parquet → dim_customer) (A4)"
```

---

## Task 4: registerDimCustomerJob cron

**Files:**
- Modify: `web/lib/scheduler.ts`（registerCarryDimsJob 函数后约 695 行加新函数；init 注册点约 64 行加调用）

**Interfaces:**
- Consumes: `DUCKDB_URL`/`AGENT_API_KEY`/`cron`/`scheduledJobs`/`runningTasks`（scheduler.ts 既有）、`/derive-dim-customer`（Task 3）
- Produces: `registerDimCustomerJob()`（cron `20 4 * * *` Asia/Shanghai）

- [ ] **Step 1: 加 registerDimCustomerJob 函数**

在 `web/lib/scheduler.ts` 的 `registerCarryDimsJob` 函数结束（约 695 行 `}`）之后插入（仿其结构）：
```ts
// A4: dim_customer 派生定时（每天 04:20，carry-dims 04:33 前→carry 自动 COPY 当日新客户）
function registerDimCustomerJob() {
  const JOB_KEY = "__dim_customer";
  if (scheduledJobs.has(JOB_KEY)) return;
  if (!cron.validate("20 4 * * *")) return;
  const job = cron.schedule("20 4 * * *", async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ dim_customer 派生定时触发");
      const resp = await fetch(`${DUCKDB_URL}/derive-dim-customer`, {
        method: "POST", headers: { "x-agent-key": AGENT_API_KEY },
      });
      const data = await resp.json().catch(() => ({}));
      console.log("[scheduler] derive-dim-customer 结果:", resp.status, data);
    } catch (e: any) {
      console.error("[scheduler] derive-dim-customer 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册 dim_customer 派生 (20 4 * * *, Asia/Shanghai)");
}
```

- [ ] **Step 2: 注册点加调用**

在 `web/lib/scheduler.ts` 的初始化处（约 64 行 `registerCarryDimsJob();` 下一行）加：
```ts
  registerDimCustomerJob();
```

- [ ] **Step 3: build 验证**
```bash
cd /Users/duo/Documents/mytechcode/data-analysis/web && npm run build
```
Expected: build 通过（TS 编译，无类型错误）。

- [ ] **Step 4: Commit**
```bash
cd /Users/duo/Documents/mytechcode/data-analysis && git add web/lib/scheduler.ts
git commit -m "feat(web): registerDimCustomerJob cron 04:20 (semantic layer A4)"
```

---

## Task 5: 生产部署 + 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 推送触发 GHA**
```bash
git push origin main
```

- [ ] **Step 2: 等 GHA + 重启 postgrest**
```bash
gh run watch --exit-status
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```
Expected: GHA 全绿；postgrest 重启（刷 dim_customer + dimensions schema 缓存）。

- [ ] **Step 3: 手动触发首次派生**
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
curl -sf -X POST -H "x-agent-key: $AGENT_API_KEY" http://localhost:7131/derive-dim-customer'
```
Expected: `{ success: true, derived: N, total: N, active: N, duration_ms: ... }`（N = 3120 批发客户数，可能几百到几千）。注意：services duckdb server 端口确认（7131 或其它，看 deploy 配置；若非 7131 用实际端口）。

- [ ] **Step 4: 验证数据 + 维度健康**
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT COUNT(*) total, COUNT(*) FILTER (WHERE is_active) active FROM dim_customer; SELECT * FROM validate_semantic_registry();\""
```
Expected: dim_customer 有 N 行（total=active，首次派生全部 active）；validate 0 行。

- [ ] **Step 5: 验证 A3 admin 可见 customer + carry-dims COPY**
```bash
# A3 admin 字典/层级树出 customer（前端打开 /admin/semantic 核对）
# carry-dims 次日 04:33 自动 COPY（验证 parquet 生成）
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT dim_code, level_code FROM dimension_levels WHERE dim_code='customer';\""
```
Expected: dimension_levels 返回 customer/customer（A3 admin 字典+层级树自动显示 customer 维度）。

---

## Self-Review

### 1. Spec Coverage（对照 A4 spec）
| spec 要求 | task |
|---|---|
| dim_customer + ext + customer_full 建表（仿 029） | Task 1 ✅ |
| datasets 注册（carry-dims 自动 COPY） | Task 1 ✅ |
| customer 维度注册（单层 derived） | Task 2 ✅ |
| /derive-dim-customer endpoint（派生+软删除+upsert） | Task 3 ✅ |
| registerDimCustomerJob 日 cron | Task 4 ✅ |
| 部署 + 重启 postgrest + 首次派生 + 验证 | Task 5 ✅ |
| 成功标准（建表/派生/维度/validate/cron/admin 可见） | Task 5 ✅ |

### 2. Placeholder Scan
✅ 无 TBD/TODO；migration/endpoint/cron 代码 verbatim 完整；endpoint 端口标注"确认实际"（deploy 配置）。

### 3. Type Consistency
✅ dim_customer 列（system_book_code/client_code/client_name/first_order_date/last_order_date/active_days/is_active）跨 Task 1（建表）/Task 3（upsert row）一致
✅ upsertRow 签名 `(tableName, row, conflictKeys)` 与 server.js:634 一致；row 含 is_active:true
✅ dimensions/dimension_levels 列名与 077（A1）一致（dim_code/level_code/depth/key_column/name_column/parent_level）
✅ 派生 SQL 列名（client_code/client_name/audit_time）与 050 dataset_columns 一致；路径与 datasets.source 一致

### 4. spec 偏差（计划已优化）
- spec §8 cron 04:47 → 计划 **04:20**（carry-dims 04:33 前，让 carry 自动 COPY 当日新数据；04:47 在 carry 后会致 parquet 滞后一天）
- spec §1/§6 endpoint 内 COPY parquet → 计划由 **carry-dims 自动 COPY**（dim_customer 注册 datasets kind=dim carry_enabled，注册表驱动，零额外代码）
- 派生硬编码 `'3120'`（spec 假设 parquet 有 system_book_code 列；实测批发只 3120 采集，parquet 无该列）

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-23-semantic-layer-a4-dim-customer.md`.**
