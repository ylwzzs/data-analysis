# 语义层 Phase A2 实现计划（视图生成器 + 对账）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建语义层视图生成器——读 registry + metric_sources + 维度，自动产出下钻视图迁移 + audit，配双轨对账验证 Phase 1 手写视图。

**Architecture:** metric_sources 数据源映射表 → view-manifest.json 清单 → generate-views.js 生成器（Node，复用 services/pg）→ 产出 081 静态迁移（视图+audit）→ reconcile 双轨验证 vs report_region_breakdown_v。

**Tech Stack:** PostgreSQL（metric_sources 迁移）、Node（生成器脚本，pg + 内置 JSON）、psql 验证

## Global Constraints

- 所有 DDL 幂等：`CREATE TABLE IF NOT EXISTS` / `ON CONFLICT` / `DROP VIEW IF EXISTS + CREATE VIEW`
- generated_*.sql 是机器产物，**勿手改**（改 view-manifest.json 后重生成）
- 视图 `security_invoker=true` + `GRANT SELECT TO authenticated, anon`
- 部署后须 `docker compose restart postgrest` 刷 schema 缓存
- derived 比率（margin）必须 `SUM(分量)/NULLIF(SUM(分量),0)` 重算，不直接 SUM
- A2 生成器**只支持单源视图**（所有 base 指标来自同一 source_table）；多源（outbound 合并 delivery+wholesale）后续扩展

## Scope（A2 范围）
**包含**：metric_sources 表 + view-manifest.json + generate-views.js（单源）+ 首个生成视图 store_sales_drill + audit + reconcile 双轨
**不含**：多源/跨表视图（outbound）、商品/客户维度（A4）、admin 页（A3）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `database/migrations/080_metric_sources.sql` | 指标→聚合表数据源映射 + 种子 |
| `scripts/view-manifest.json` | 生成清单（声明指标×维度组合） |
| `scripts/generate-views.js` | 生成器（读清单+PG，产出视图迁移） |
| `database/migrations/081_generated_store_sales_drill.sql` | 生成器产出的视图 + audit（机器生成） |
| `scripts/reconcile-phase1.sql` | 双轨对账脚本（vs report_region_breakdown_v） |

---

## Task 1: metric_sources 表 + 种子

**Files:**
- Create: `database/migrations/080_metric_sources.sql`

**Interfaces:**
- Consumes: `metric_registry`（A1，FK）
- Produces: 表 `metric_sources(metric_code, source_table, source_column, source_filter)`；9 指标种子

- [ ] **Step 1: 写期望验证查询**
```sql
SELECT metric_code, source_table, source_column FROM metric_sources ORDER BY metric_code;
```
期望 9 行：6 base 有 source_column（sale_amount→report_daily_sales/total_sale 等），3 derived（outbound_amount/outbound_profit/margin）source_column=NULL。

- [ ] **Step 2: 跑确认失败**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, source_table, source_column FROM metric_sources ORDER BY metric_code;"
```
Expected: ERROR `relation "metric_sources" does not exist`

- [ ] **Step 3: 写迁移**
创建 `database/migrations/080_metric_sources.sql`：
```sql
-- 080_metric_sources.sql
-- 指标→聚合表数据源映射（生成器实际 FROM 的表）
-- 与 metric_registry 口径声明解耦：换数据源不动口径
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；部署后重启 postgrest

CREATE TABLE IF NOT EXISTS metric_sources (
  metric_code   TEXT PRIMARY KEY REFERENCES metric_registry(metric_code) ON DELETE CASCADE,
  source_table  TEXT NOT NULL,        -- 聚合 PG 表（report_daily_sales 等）
  source_column TEXT,                 -- base: 聚合列；derived: NULL
  source_filter TEXT,                 -- 可选过滤（如 system_book_code='64188'）
  note          TEXT
);

COMMENT ON TABLE metric_sources IS '指标数据源映射：生成器读此表定位聚合 PG 表+列';

INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note) VALUES
  ('sale_amount','report_daily_sales','total_sale','system_book_code = ''64188''',NULL),
  ('sale_profit','report_daily_sales','total_profit','system_book_code = ''64188''','成本敏感'),
  ('delivery_amount','report_daily_delivery','out_money','system_book_code = ''64188''',NULL),
  ('delivery_profit','report_daily_delivery','profit_money','system_book_code = ''64188''','成本敏感'),
  ('wholesale_amount','report_daily_wholesale','wholesale_money','system_book_code = ''64188''',NULL),
  ('wholesale_profit','report_daily_wholesale','wholesale_profit','system_book_code = ''64188''','成本敏感'),
  ('outbound_amount','report_daily_delivery',NULL,NULL,'derived: source_table 为占位（NOT NULL）；生成器按 formula 合并 delivery+wholesale（多源，后续）'),
  ('outbound_profit','report_daily_delivery',NULL,NULL,'derived: 同上（多源，后续）'),
  ('margin','report_daily_sales',NULL,NULL,'derived: 生成器重算 profit/amount（同源）')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

GRANT SELECT ON metric_sources TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 080 completed: metric_sources + 9 mappings'; END $$;
```

- [ ] **Step 4: 应用 + 验证**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -f database/migrations/080_metric_sources.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT metric_code, source_table, source_column FROM metric_sources ORDER BY metric_code;"
```
Expected: 9 行，与 Step 1 一致（3 个 derived 的 source_column 为 NULL）。

- [ ] **Step 5: Commit**
```bash
git add database/migrations/080_metric_sources.sql
git commit -m "feat(db): metric_sources data-source mapping (semantic layer A2)"
```

---

## Task 2: view-manifest.json + generate-views.js 生成器

**Files:**
- Create: `scripts/view-manifest.json`
- Create: `scripts/generate-views.js`

**Interfaces:**
- Consumes: `metric_registry` + `metric_sources` + `dimension_levels` + `dimensions`（PG）、`scripts/view-manifest.json`
- Produces: 生成器脚本（读清单+PG，产出视图迁移到 database/migrations/）

- [ ] **Step 1: 确认本地 PG 可直连**
```bash
docker port deploy-postgres-1
```
Expected: 看到 `5432/tcp -> 0.0.0.0:5432`（或类似）。若端口未映射，生成器改用 `DATABASE_URL=postgresql://postgres@host.docker.internal:5432/insforge` 或在 services 容器内跑。确认能 `psql "postgresql://postgres:postgres@localhost:5432/insforge" -c "SELECT COUNT(*) FROM metric_registry"` 返回 9。

- [ ] **Step 2: 写 view-manifest.json**
创建 `scripts/view-manifest.json`：
```json
{
  "views": [
    {
      "name": "store_sales_drill",
      "metrics": ["sale_amount", "sale_profit", "margin"],
      "dimension": "branch",
      "levels": ["region", "sub_region", "store"],
      "assessed_filter": true,
      "target_scoped": true,
      "audit": true
    }
  ]
}
```

- [ ] **Step 3: 写 generate-views.js**
创建 `scripts/generate-views.js`：
```javascript
#!/usr/bin/env node
/**
 * 语义层视图生成器
 * 读 view-manifest.json + PG(metric_registry/metric_sources/dimension_levels/dimensions)
 * 产出下钻视图迁移（多层 UNION ALL）+ audit 视图（rollup 自校验）
 *
 * A2 限制：只支持单源视图（所有 base 指标来自同一 source_table）
 *
 * 用法：DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insforge node scripts/generate-views.js
 */
const fs = require("fs");
const path = require("path");
const { Client } = require(path.join(__dirname, "..", "services", "node_modules", "pg"));

const MANIFEST_PATH = path.join(__dirname, "view-manifest.json");
const MIGRATIONS_DIR = path.join(__dirname, "..", "database", "migrations");

function nextMigrationNum() {
  const nums = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => parseInt(f.slice(0, 3), 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

async function readModel(client) {
  const [metrics, sources, levels, dims] = await Promise.all([
    client.query(
      "SELECT metric_code, measure_type, formula, depends_on, additive, cost_sensitive FROM metric_registry WHERE enabled"
    ),
    client.query("SELECT metric_code, source_table, source_column, source_filter FROM metric_sources"),
    client.query(
      "SELECT dim_code, level_code, depth, key_column, name_column, parent_level FROM dimension_levels ORDER BY dim_code, depth"
    ),
    client.query("SELECT dim_code, join_table, join_key, is_assessed_filter FROM dimensions WHERE enabled"),
  ]);
  return { metrics: metrics.rows, sources: sources.rows, levels: levels.rows, dims: dims.rows };
}

// 校验：所有 base 指标必须同源（A2 单源限制）
function validateView(view, model) {
  const baseMetrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  if (baseMetrics.length === 0) throw new Error(`视图 ${view.name}: 无 base 指标，无法定位 source_table`);
  const tables = [...new Set(
    baseMetrics.map((m) => {
      const s = model.sources.find((x) => x.metric_code === m.metric_code);
      if (!s) throw new Error(`指标 ${m.metric_code} 无 metric_sources 映射`);
      return s.source_table;
    })
  )];
  if (tables.length > 1)
    throw new Error(`视图 ${view.name}: 多源（${tables.join(",")}）A2 暂不支持，需单源`);
  return { sourceTable: tables[0], baseMetrics };
}

// 生成单层 UNION 分支
function genLevelBranch(view, level, parentLevel, baseMetrics, model, dim) {
  const src = (code) => model.sources.find((s) => s.metric_code === code);
  const cols = [];
  cols.push(`'${level.level_code}' AS level`);
  cols.push(parentLevel ? `dim.${parentLevel.key_column} AS parent_code` : `NULL::text AS parent_code`);
  if (view.target_scoped) cols.push("t.id AS target_id");
  cols.push(`dim.${level.key_column} AS code`);
  cols.push(`dim.${level.name_column} AS name`);

  for (const m of baseMetrics) {
    cols.push(`SUM(s.${src(m.metric_code).source_column}) AS ${m.metric_code}`);
  }

  // 同源 derived 比率：margin = profit/amount（重算，不直接 SUM）
  const profitSrc = src("sale_profit") || src("delivery_profit") || src("wholesale_profit");
  const amountSrc = src("sale_amount") || src("delivery_amount") || src("wholesale_amount");
  if (view.metrics.includes("margin") && profitSrc && amountSrc) {
    cols.push(`SUM(s.${profitSrc.source_column}) / NULLIF(SUM(s.${amountSrc.source_column}), 0) AS margin`);
  }

  const sourceFilter = baseMetrics[0] && src(baseMetrics[0].metric_code).source_filter;
  let from = `FROM ${src(baseMetrics[0].metric_code).source_table} s`;
  from += `\n  JOIN ${dim.join_table} dim ON s.branch_num = dim.${dim.join_key}`;
  const where = [];
  if (view.target_scoped) {
    from += `\n  JOIN targets t ON s.system_book_code = t.system_book_code\n    AND s.biz_date BETWEEN t.start_date AND t.end_date`;
    where.push("t.status = 'active'");
  }
  if (sourceFilter) where.push(sourceFilter);
  if (view.assessed_filter) where.push("is_assessed_war_zone(dim.first_level_region)");

  const groupCols = [];
  if (view.target_scoped) groupCols.push("t.id");
  if (parentLevel) groupCols.push(`dim.${parentLevel.key_column}`);
  groupCols.push(`dim.${level.key_column}`);
  groupCols.push(`dim.${level.name_column}`);

  return `  SELECT\n    ${cols.join(",\n    ")}\n  ${from}\n  ${where.length ? "WHERE " + where.join(" AND ") : ""}\n  GROUP BY ${groupCols.join(", ")}`;
}

// 生成 audit 视图（各层加总一致性）
function genAuditSql(viewName, view, levels) {
  const auditName = viewName + "_audit";
  const codes = levels.map((l) => l.level_code);
  const metric = view.metrics[0];
  const pivots = codes.map((c) => `MAX(CASE WHEN level='${c}' THEN ${metric} END) AS ${c}_total`).join(",\n      ");
  const diffs = [];
  for (let i = 1; i < codes.length; i++) {
    diffs.push(`ABS(${codes[0]}_total - ${codes[i]}_total) AS ${codes[0]}_vs_${codes[i]}_diff`);
  }
  const tgt = view.target_scoped;
  return `DROP VIEW IF EXISTS ${auditName};
CREATE VIEW ${auditName} AS
  SELECT${tgt ? " target_id," : ""}
      ${pivots}${diffs.length ? ",\n      " + diffs.join(",\n      ") : ""}
  FROM (
    SELECT${tgt ? " target_id," : ""} level, SUM(${metric}) AS ${metric}
    FROM ${viewName}
    GROUP BY ${tgt ? "target_id, " : ""}level
  ) x${tgt ? " GROUP BY target_id" : ""};
ALTER VIEW ${auditName} SET (security_invoker = true);
GRANT SELECT ON ${auditName} TO authenticated, anon;`;
}

function genViewSql(view, model) {
  const dim = model.dims.find((d) => d.dim_code === view.dimension);
  if (!dim) throw new Error(`维度 ${view.dimension} 未注册`);
  const { baseMetrics } = validateView(view, model);
  const levels = model.levels
    .filter((l) => l.dim_code === view.dimension && view.levels.includes(l.level_code))
    .sort((a, b) => a.depth - b.depth);
  if (levels.length === 0) throw new Error(`维度 ${view.dimension} 无匹配层级 ${view.levels}`);

  const branches = levels.map((lvl) => {
    const parent = lvl.parent_level ? levels.find((l) => l.level_code === lvl.parent_level) : null;
    return genLevelBranch(view, lvl, parent, baseMetrics, model, dim);
  });

  const viewName = `report_${view.name}_v`;
  let sql = `-- AUTO-GENERATED by scripts/generate-views.js（勿手改；改 view-manifest.json 后重生成）\n-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；部署后重启 postgrest\n\n`;
  sql += `DROP VIEW IF EXISTS ${viewName};\nCREATE VIEW ${viewName} AS\n${branches.join("\nUNION ALL\n")};\n`;
  sql += `ALTER VIEW ${viewName} OWNER TO postgres;\nALTER VIEW ${viewName} SET (security_invoker = true);\nGRANT SELECT ON ${viewName} TO authenticated, anon;\n`;
  if (view.audit) sql += "\n" + genAuditSql(viewName, view, levels) + "\n";
  return sql;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const conn = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/insforge";
  const client = new Client({ connectionString: conn });
  await client.connect();
  const model = await readModel(client);
  await client.end();

  let num = nextMigrationNum();
  for (const view of manifest.views) {
    const sql = genViewSql(view, model);
    const fname = `${String(num).padStart(3, "0")}_generated_${view.name}.sql`;
    fs.writeFileSync(path.join(MIGRATIONS_DIR, fname), sql);
    console.log(`✓ generated database/migrations/${fname}`);
    num++;
  }
}

main().catch((e) => {
  console.error("生成失败:", e.message);
  process.exit(1);
});
```

- [ ] **Step 4: Commit（生成器本身，不跑生成）**
```bash
git add scripts/view-manifest.json scripts/generate-views.js
git commit -m "feat(scripts): view generator + manifest (semantic layer A2)"
```

---

## Task 3: 跑生成器产出视图 + 本地验证

**Files:**
- Create: `database/migrations/081_generated_store_sales_drill.sql`（机器生成）

**Interfaces:**
- Consumes: generate-views.js（Task 2）+ metric_sources（Task 1）
- Produces: `report_store_sales_drill_v`（三层销售下钻）+ `report_store_sales_drill_v_audit`

- [ ] **Step 1: 跑生成器**
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insforge node scripts/generate-views.js
```
Expected: 输出 `✓ generated database/migrations/081_generated_store_sales_drill.sql`

- [ ] **Step 2: review 生成的 SQL**
打开 `database/migrations/081_generated_store_sales_drill.sql`，确认：
- 含 3 个 UNION ALL 分支（region/sub_region/store）
- 每层有 level/parent_code/target_id/code/name/sale_amount/sale_profit/margin 列
- JOIN dim_branch + targets，WHERE 含 system_book_code + is_assessed_war_zone + t.status='active'
- 末尾有 audit 视图 + GRANT

- [ ] **Step 3: 应用 + 验证结构**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -f database/migrations/081_generated_store_sales_drill.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT level, COUNT(*) FROM report_store_sales_drill_v GROUP BY level ORDER BY level;"
```
Expected: 3 行（region/store/sub_region 各若干行）。

- [ ] **Step 4: 验证 audit（rollup 一致性）**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT MAX(region_vs_store_diff) AS max_diff FROM report_store_sales_drill_v_audit;"
```
Expected: `max_diff` 接近 0（各层加总一致）。若显著非 0，说明生成器 GROUP BY/JOIN 有 bug，回 Task 2 修。

- [ ] **Step 5: Commit**
```bash
git add database/migrations/081_generated_store_sales_drill.sql
git commit -m "feat(db): generated store_sales_drill view + audit (semantic layer A2)"
```

---

## Task 4: reconcile 双轨对账脚本

**Files:**
- Create: `scripts/reconcile-phase1.sql`

**Interfaces:**
- Consumes: `report_store_sales_drill_v`（新）、`report_region_breakdown_v`（Phase 1 手写）

- [ ] **Step 1: 写对账脚本**
创建 `scripts/reconcile-phase1.sql`：
```sql
-- reconcile-phase1.sql
-- 双轨对账：生成器新视图 report_store_sales_drill_v vs Phase 1 手写 report_region_breakdown_v
-- 同 target_id、同层级，SUM(sale) 应一致（diff < 1元容差）
-- 用法：docker exec deploy-postgres-1 psql -U postgres -d insforge -f scripts/reconcile-phase1.sql

WITH old AS (
  SELECT target_id, SUM(sale_actual) AS old_total
  FROM report_region_breakdown_v
  WHERE level = 'store' AND sale_actual IS NOT NULL
  GROUP BY target_id
),
new AS (
  SELECT target_id, SUM(sale_amount) AS new_total
  FROM report_store_sales_drill_v
  WHERE level = 'store'
  GROUP BY target_id
)
SELECT
  COALESCE(o.target_id, n.target_id) AS target_id,
  o.old_total,
  n.new_total,
  ABS(COALESCE(o.old_total, 0) - COALESCE(n.new_total, 0)) AS diff,
  CASE WHEN ABS(COALESCE(o.old_total, 0) - COALESCE(n.new_total, 0)) < 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM old o
FULL OUTER JOIN new n ON o.target_id = n.target_id
ORDER BY diff DESC;
-- 期望：所有行 verdict=PASS（diff<1元）
```

- [ ] **Step 2: 跑对账**
```bash
docker exec deploy-postgres-1 psql -U postgres -d insforge -f scripts/reconcile-phase1.sql
```
Expected: 所有 target_id 的 verdict=PASS。若有 FAIL，排查：region_breakdown_v 和生成视图的口径差异（如 system_book_code 过滤、assessed 白名单范围）。

- [ ] **Step 3: Commit**
```bash
git add scripts/reconcile-phase1.sql
git commit -m "feat(scripts): reconcile-phase1 dual-track checks (semantic layer A2)"
```

---

## Task 5: 生产部署 + 重启 postgrest + 对账

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

- [ ] **Step 3: 生产验证**
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT level, COUNT(*) FROM report_store_sales_drill_v GROUP BY level ORDER BY level; SELECT MAX(region_vs_store_diff) FROM report_store_sales_drill_v_audit;\""
```
Expected: 3 层有数据，audit max_diff≈0。

- [ ] **Step 4: 生产双轨对账**
```bash
scp -i "~/.ssh/ShanHai-OPS.pem" scripts/reconcile-phase1.sql root@data.shanhaiyiguo.com:/tmp/reconcile.sql
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker cp /tmp/reconcile.sql deploy-postgres-1:/tmp/ && docker exec deploy-postgres-1 psql -U postgres -d insforge -f /tmp/reconcile.sql"
```
Expected: 所有 verdict=PASS。PASS 后生成器可信，可规划下线旧 report_region_breakdown_v（另起任务，A2 不下线）。

---

## Self-Review

### 1. Spec Coverage（对照 A2 spec）
| spec 要求 | task |
|---|---|
| metric_sources 表 + 9 种子 | Task 1 ✅ |
| view-manifest 配置清单 | Task 2 ✅ |
| generate-views.js 生成器（单源+同源比率+多层+audit） | Task 2 ✅ |
| 产出首个视图 store_sales_drill + audit | Task 3 ✅ |
| reconcile 双轨 vs Phase 1 手写 | Task 4 ✅ |
| 部署+重启+生产对账 | Task 5 ✅ |
| 多源/跨表（outbound）/商品客户维度/admin | — | 推迟（A2 单源，YAGNI） |

### 2. Placeholder Scan
✅ 无 TBD/TODO；生成器代码完整可运行；manifest/SQL/对账脚本均含具体内容。

### 3. Type Consistency
✅ `metric_sources.metric_code` FK 对齐 `metric_registry.metric_code`（A1）
✅ manifest 的 `dimension: branch` + `levels` 对齐 A1 的 dimension_levels（region/sub_region/store）
✅ 生成器读的列名（source_table/source_column/key_column/parent_level）与 A1/A2 建表一致
✅ audit 视图名 `report_<name>_v_audit` 与 spec §7 一致

### 4. 注意点（实现时）
- 生成器连本地 dev PG（localhost:5432），Task 2 Step 1 先验端口映射
- manifest 用 JSON（非 spec 的 YAML），理由：避免新增 js-yaml 依赖（spec §5 写 YAML，plan 调整为 JSON，语义等价）
- 生成的 081 文件是机器产物，review 后提交，不手改

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-22-semantic-layer-phaseA2.md`.**
