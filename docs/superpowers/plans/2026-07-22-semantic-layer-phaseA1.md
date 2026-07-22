# 语义层 Phase A1 实现计划（metric registry + 维度建模 + 校验 + 字典）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立语义层地基的元数据层：指标注册表 + 维度/层级模型 + 静态校验 + 人类可读字典视图

**Architecture:** 4 个幂等 DB 迁移（076-079），声明式定义指标（base/derived）和维度层级，配校验函数防 Phase 2 那种"假设表有某列但实际没有"的错误。纯 PG 元数据，不涉及生成器（A2）/admin 页（A3）/dim_customer 物化（A4）。

**Tech Stack:** PostgreSQL（迁移 + 函数 + 视图），psql 验证

## Global Constraints

- 所有 DDL 幂等：`CREATE TABLE IF NOT EXISTS` / `ON CONFLICT DO UPDATE` / `DROP VIEW IF EXISTS + CREATE VIEW` / `CREATE OR REPLACE FUNCTION`
- 视图禁用 `CREATE OR REPLACE`（后迁移加列重跑报 `cannot drop columns from view`），用 `DROP VIEW IF EXISTS + CREATE VIEW`
- 部署后须 `docker compose restart postgrest` 刷 schema 缓存（GHA 不保证重启）
- 视图设 `security_invoker=true` + `GRANT SELECT TO authenticated, anon`
- 保留旧 `metric_definitions` 表（`report_achievement_v` 仍引用），不删不改
- 数据源真相：明细（retail_detail/delivery_detail/wholesale_detail）在 S3 parquet，`fact_table` 字段存 datasets 注册名

## Scope（A1 范围）

**包含**：metric_registry（9 指标）+ dimensions/dimension_levels（branch 3 级 + item 1 级）+ validate 函数 + 字典视图
**不含（后续 plan）**：
- `achievement_rate` 指标 → 推迟到目标整合阶段（其 actual/target 跨 registry 与 targets 表，需单独设计）
- `customer` 维度 → A4（需先物化 dim_customer）
- `category`/`date` 维度 → 后续（需设计品类层级 / 日期是内置维度）
- 视图生成器 → A2；admin 页 → A3

---

## File Structure

| 文件 | 职责 |
|---|---|
| `database/migrations/076_metric_registry.sql` | 指标注册表 + 9 指标种子 |
| `database/migrations/077_dimensions.sql` | 维度 + 层级表 + branch/item 种子 |
| `database/migrations/078_validate_semantic_registry.sql` | 静态校验函数 |
| `database/migrations/079_semantic_dictionary_v.sql` | 人类可读字典视图 |

---

## Task 1: metric_registry 表 + 指标种子

**Files:**
- Create: `database/migrations/076_metric_registry.sql`

**Interfaces:**
- Consumes: `datasets` 表（校验 fact_table 是否注册，Task 3 用）
- Produces: 表 `metric_registry`，字段见下；9 个指标种子

- [ ] **Step 1: 写期望验证查询**

期望 `metric_registry` 有 9 行，base/derived/additive 正确。验证查询（先记下，对象不存在时 Step 2 会报错）：
```sql
SELECT metric_code, measure_type, additive, cost_sensitive
FROM metric_registry ORDER BY metric_code;
```
期望 9 行：sale_amount/base/t/f、sale_profit/base/t/t、delivery_amount/base/t/f、delivery_profit/base/t/t、wholesale_amount/base/t/f、wholesale_profit/base/t/t、outbound_amount/derived/t/f、outbound_profit/derived/t/t、margin/derived/f/t。

- [ ] **Step 2: 跑验证查询确认失败**

Run:
```bash
psql -U postgres -d insforge -c "SELECT metric_code, measure_type, additive, cost_sensitive FROM metric_registry ORDER BY metric_code;"
```
Expected: ERROR `relation "metric_registry" does not exist`

- [ ] **Step 3: 写迁移文件**

创建 `database/migrations/076_metric_registry.sql`：

```sql
-- 076_metric_registry.sql
-- 语义层指标注册表：声明式指标定义（base 事实表聚合 / derived 基于他指标运算）
-- 替代 metric_definitions 的 NULL 指针问题（outbound 口径不再散落视图 SQL）
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；保留旧 metric_definitions 兼容
-- 部署后需重启 postgrest: docker compose restart postgrest

CREATE TABLE IF NOT EXISTS metric_registry (
  metric_code      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,           -- 中文显示名
  description      TEXT,                    -- 业务口径说明（中文）
  business_formula TEXT,                    -- 中文自然语言公式
  measure_type     TEXT NOT NULL CHECK (measure_type IN ('base','derived')),
  fact_table       TEXT,                    -- base: datasets 注册名（retail_detail 等）；derived: NULL
  value_column     TEXT,                    -- base: 聚合列；derived: NULL
  agg              TEXT CHECK (agg IS NULL OR agg IN ('SUM','COUNT_DISTINCT','AVG','MAX','MIN')),
  formula          TEXT,                    -- derived: 运算公式；base: NULL
  depends_on       JSONB DEFAULT '[]'::jsonb, -- derived: 依赖的 metric_code 数组；base: []
  additive         BOOLEAN NOT NULL,        -- true: 可按维度 SUM；false: 比率须重算
  cost_sensitive   BOOLEAN DEFAULT false,   -- 是否需 can_see_cost 脱敏
  unit             TEXT,                    -- 元 / % / 件
  data_ready       BOOLEAN DEFAULT true,
  enabled          BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_measure_base CHECK (
    (measure_type <> 'base') OR (fact_table IS NOT NULL AND value_column IS NOT NULL AND agg IS NOT NULL)
  ),
  CONSTRAINT chk_measure_derived CHECK (
    (measure_type <> 'derived') OR (formula IS NOT NULL)
  )
);

COMMENT ON TABLE metric_registry IS '语义层指标注册表：base=事实表聚合，derived=基于他指标运算。单一口径来源';

INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, formula, depends_on, additive, cost_sensitive, unit) VALUES
  ('sale_amount','销售金额','所有门店零售金额合计，不含批发','各门店 sale_money 之和','base','retail_detail','sale_money','SUM',NULL,'[]',true,false,'元'),
  ('sale_profit','销售毛利','零售毛利合计','各门店 profit 之和（成本敏感）','base','retail_detail','profit','SUM',NULL,'[]',true,true,'元'),
  ('delivery_amount','出库金额','配送调出金额合计','out_money 之和','base','delivery_detail','out_money','SUM',NULL,'[]',true,false,'元'),
  ('delivery_profit','出库毛利','配送毛利合计','profit_money 之和（成本敏感）','base','delivery_detail','profit_money','SUM',NULL,'[]',true,true,'元'),
  ('wholesale_amount','批发金额','批发销售金额合计','wholesale_money 之和','base','wholesale_detail','wholesale_money','SUM',NULL,'[]',true,false,'元'),
  ('wholesale_profit','批发毛利','批发毛利合计','wholesale_profit 之和（成本敏感）','base','wholesale_detail','wholesale_profit','SUM',NULL,'[]',true,true,'元'),
  ('outbound_amount','总出库金额','配送+批发出库金额','delivery_amount + wholesale_amount','derived',NULL,NULL,NULL,'delivery_amount + wholesale_amount','["delivery_amount","wholesale_amount"]',true,false,'元'),
  ('outbound_profit','总出库毛利','配送+批发出库毛利','delivery_profit + wholesale_profit','derived',NULL,NULL,NULL,'delivery_profit + wholesale_profit','["delivery_profit","wholesale_profit"]',true,true,'元'),
  ('margin','毛利率','毛利占金额比','profit / amount（不可直接 SUM，须重算）','derived',NULL,NULL,NULL,'profit / amount','["sale_profit","sale_amount"]',false,true,'%')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column,
  agg=EXCLUDED.agg, formula=EXCLUDED.formula, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

GRANT SELECT ON metric_registry TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 076 completed: metric_registry + 9 metrics'; END $$;
```

- [ ] **Step 4: 应用迁移 + 跑验证查询**

应用迁移（本地 dev）：
```bash
psql -U postgres -d insforge -f database/migrations/076_metric_registry.sql
```
验证：
```bash
psql -U postgres -d insforge -c "SELECT metric_code, measure_type, additive, cost_sensitive FROM metric_registry ORDER BY metric_code;"
```
Expected: 9 行，与 Step 1 期望一致。

额外验证约束生效（derived 缺 formula 应被拦）：
```bash
psql -U postgres -d insforge -c "INSERT INTO metric_registry (metric_code, name, measure_type, additive) VALUES ('test_bad','测试','derived',true);"
```
Expected: ERROR 违反 `chk_measure_derived`（rollback 后该行不入库）。
清理（若上条因事务 rollback 无残留，此步可跳过）：
```bash
psql -U postgres -d insforge -c "DELETE FROM metric_registry WHERE metric_code='test_bad';"
```

- [ ] **Step 5: Commit**

```bash
git add database/migrations/076_metric_registry.sql
git commit -m "feat(db): metric_registry + 9 seed metrics (semantic layer A1)"
```

---

## Task 2: dimensions + dimension_levels 表 + 种子

**Files:**
- Create: `database/migrations/077_dimensions.sql`

**Interfaces:**
- Consumes: `dim_branch`（first_level_region/second_level_region/branch_num/branch_name）、`dim_item`（item_num/item_name）
- Produces: 表 `dimensions`（维度定义）、`dimension_levels`（层级链）；branch 3 级 + item 1 级种子

- [ ] **Step 1: 写期望验证查询**

```sql
SELECT dim_code, level_code, depth, key_column, parent_level
FROM dimension_levels ORDER BY dim_code, depth;
```
期望 4 行：branch/region/0/first_level_region/NULL、branch/sub_region/1/second_level_region/region、branch/store/2/branch_num/sub_region、item/item/0/item_num/NULL。

- [ ] **Step 2: 跑验证查询确认失败**

```bash
psql -U postgres -d insforge -c "SELECT dim_code, level_code, depth, key_column, parent_level FROM dimension_levels ORDER BY dim_code, depth;"
```
Expected: ERROR `relation "dimension_levels" does not exist`

- [ ] **Step 3: 写迁移文件**

创建 `database/migrations/077_dimensions.sql`：

```sql
-- 077_dimensions.sql
-- 语义层维度模型：dimensions（维度定义）+ dimension_levels（层级链）
-- branch 复用 dim_branch（三级），item 复用 dim_item（单品级）
-- customer（A4 派生物化）/category（品类层级）/date（内置）后续
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT
-- 部署后需重启 postgrest: docker compose restart postgrest

CREATE TABLE IF NOT EXISTS dimensions (
  dim_code           TEXT PRIMARY KEY,
  name               TEXT NOT NULL,         -- 中文
  description        TEXT,
  source_type        TEXT NOT NULL CHECK (source_type IN ('static','derived')),
  join_table         TEXT NOT NULL,         -- JOIN 的维表（dim_branch/dim_item/dim_customer）
  join_key           TEXT NOT NULL,         -- JOIN 键列
  source_fact_table  TEXT,                  -- derived: 派生自哪张事实表；static: NULL
  business_rule      TEXT,                  -- derived: 派生规则（中文自然语言）
  is_assessed_filter BOOLEAN DEFAULT false, -- 是否套 is_assessed_war_zone 白名单
  enabled            BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS dimension_levels (
  dim_code        TEXT NOT NULL REFERENCES dimensions(dim_code) ON DELETE CASCADE,
  level_code      TEXT NOT NULL,
  level_name      TEXT NOT NULL,            -- 中文
  depth           INT NOT NULL,
  key_column      TEXT NOT NULL,            -- 该级聚合键列
  name_column     TEXT NOT NULL,            -- 该级显示名列
  parent_level    TEXT,                     -- 父级 level_code（最顶层 NULL）
  rollup_strategy TEXT DEFAULT 'sum',       -- sum/distinct_count
  PRIMARY KEY (dim_code, level_code)
);

COMMENT ON TABLE dimensions IS '语义层维度定义：static=独立维表，derived=从事实表派生';
COMMENT ON TABLE dimension_levels IS '维度层级链：每级声明聚合键列+显示名列+父级';

INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter) VALUES
  ('branch','门店','门店组织维度（战区/小区/门店三级）','static','dim_branch','branch_num',NULL,NULL,true),
  ('item','商品','商品维度（单品级，品类层级后续扩展）','static','dim_item','item_num',NULL,NULL,false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, source_type=EXCLUDED.source_type,
  join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key, is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level, rollup_strategy) VALUES
  ('branch','region','战区',0,'first_level_region','first_level_region',NULL,'sum'),
  ('branch','sub_region','小区',1,'second_level_region','second_level_region','region','sum'),
  ('branch','store','门店',2,'branch_num','branch_name','sub_region','sum'),
  ('item','item','商品',0,'item_num','item_name',NULL,'sum')
ON CONFLICT (dim_code, level_code) DO UPDATE SET
  level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column,
  name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level, rollup_strategy=EXCLUDED.rollup_strategy;

GRANT SELECT ON dimensions, dimension_levels TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 077 completed: dimensions + levels (branch x3, item x1)'; END $$;
```

- [ ] **Step 4: 应用迁移 + 跑验证查询**

```bash
psql -U postgres -d insforge -f database/migrations/077_dimensions.sql
psql -U postgres -d insforge -c "SELECT dim_code, level_code, depth, key_column, parent_level FROM dimension_levels ORDER BY dim_code, depth;"
```
Expected: 4 行，与 Step 1 期望一致。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/077_dimensions.sql
git commit -m "feat(db): dimensions + dimension_levels (semantic layer A1)"
```

---

## Task 3: validate_semantic_registry() 静态校验函数

**Files:**
- Create: `database/migrations/078_validate_semantic_registry.sql`

**Interfaces:**
- Consumes: `metric_registry`（Task 1）、`dimensions`/`dimension_levels`（Task 2）、`datasets`（fact_table 注册检查）、`information_schema`（列存在性）
- Produces: 函数 `validate_semantic_registry() RETURNS TABLE(issue TEXT)`，返回问题列表（空=全通过）

- [ ] **Step 1: 写期望验证查询**

```sql
SELECT * FROM validate_semantic_registry();
```
期望：0 行（A1 种子全合法：base fact_table 都注册在 datasets，derived 依赖闭环，维度 join_key 都在维表）。

- [ ] **Step 2: 跑验证查询确认失败**

```bash
psql -U postgres -d insforge -c "SELECT * FROM validate_semantic_registry();"
```
Expected: ERROR `function validate_semantic_registry() does not exist`

- [ ] **Step 3: 写迁移文件**

创建 `database/migrations/078_validate_semantic_registry.sql`：

```sql
-- 078_validate_semantic_registry.sql
-- 语义层静态校验：base 事实表存在、derived 依赖闭环、维度 join_key 存在
-- 返回问题列表（空=全通过）。防 Phase 2 那种"假设表有某列实际没有"的错误
-- 幂等：CREATE OR REPLACE FUNCTION
-- 部署后需重启 postgrest: docker compose restart postgrest

CREATE OR REPLACE FUNCTION validate_semantic_registry() RETURNS TABLE(issue TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) base measure 的 fact_table 必须注册在 datasets（明细 parquet）或为 PG 表
  RETURN QUERY
    SELECT format('base 指标 %s 的 fact_table %s 未注册 datasets 且非 PG 表',
      m.metric_code, m.fact_table)
    FROM metric_registry m
    WHERE m.measure_type = 'base' AND m.enabled
      AND m.fact_table NOT IN (SELECT name FROM datasets)
      AND m.fact_table NOT IN (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      );

  -- 2) derived measure 的 depends_on 必须全部存在于 registry（闭环）
  RETURN QUERY
    SELECT format('derived 指标 %s 依赖未定义指标 %s', m.metric_code, dep)
    FROM metric_registry m
    CROSS JOIN LATERAL jsonb_array_elements_text(m.depends_on) AS dep
    WHERE m.measure_type = 'derived' AND m.enabled
      AND dep NOT IN (SELECT metric_code FROM metric_registry WHERE enabled);

  -- 3) static 维度的 join_key 必须存在于 join_table
  --    （derived 维度的物化表可能尚未建，跳过——由物化任务自行保证）
  RETURN QUERY
    SELECT format('维度 %s 的 join_key %s 不在表 %s', d.dim_code, d.join_key, d.join_table)
    FROM dimensions d
    WHERE d.source_type = 'static' AND d.enabled
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = d.join_table AND c.column_name = d.join_key
      );

  -- 4) static 维度的层级 key_column 必须存在于 join_table
  RETURN QUERY
    SELECT format('维度 %s 层级 %s 的 key_column %s 不在表 %s',
      dl.dim_code, dl.level_code, dl.key_column, d.join_table)
    FROM dimension_levels dl
    JOIN dimensions d ON d.dim_code = dl.dim_code
    WHERE d.source_type = 'static' AND d.enabled
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = d.join_table AND c.column_name = dl.key_column
      );

  RETURN;
END;
$$;

COMMENT ON FUNCTION validate_semantic_registry() IS '语义层静态校验：返回问题列表，空=全通过。部署后应跑';
GRANT EXECUTE ON FUNCTION validate_semantic_registry() TO postgres, authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 078 completed: validate_semantic_registry()'; END $$;
```

- [ ] **Step 4: 应用迁移 + 跑验证查询**

```bash
psql -U postgres -d insforge -f database/migrations/078_validate_semantic_registry.sql
psql -U postgres -d insforge -c "SELECT * FROM validate_semantic_registry();"
```
Expected: 0 行（空集，全通过）。

负向验证（临时插一个坏 derived 指标，确认校验抓到，再删）：
```bash
psql -U postgres -d insforge -c "INSERT INTO metric_registry (metric_code, name, measure_type, formula, depends_on, additive) VALUES ('test_bad','坏指标','derived','x','[\"nonexistent\"]',true); SELECT * FROM validate_semantic_registry(); DELETE FROM metric_registry WHERE metric_code='test_bad';"
```
Expected: 校验输出含 `derived 指标 test_bad 依赖未定义指标 nonexistent`。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/078_validate_semantic_registry.sql
git commit -m "feat(db): validate_semantic_registry() static checks (semantic layer A1)"
```

---

## Task 4: semantic_dictionary_v 字典视图

**Files:**
- Create: `database/migrations/079_semantic_dictionary_v.sql`

**Interfaces:**
- Consumes: `metric_registry`（Task 1）、`dimensions`（Task 2）
- Produces: 视图 `semantic_dictionary_v`（人类可读指标+维度清单，可喂 `get_data_dictionary()`）

- [ ] **Step 1: 写期望验证查询**

```sql
SELECT kind, code, name FROM semantic_dictionary_v ORDER BY kind, code;
```
期望 11 行：9 行 kind=metric（sale_amount...margin）+ 2 行 kind=dimension（branch、item）。

- [ ] **Step 2: 跑验证查询确认失败**

```bash
psql -U postgres -d insforge -c "SELECT kind, code, name FROM semantic_dictionary_v ORDER BY kind, code;"
```
Expected: ERROR `relation "semantic_dictionary_v" does not exist`

- [ ] **Step 3: 写迁移文件**

创建 `database/migrations/079_semantic_dictionary_v.sql`：

```sql
-- 079_semantic_dictionary_v.sql
-- 人类可读语义字典视图：JOIN 指标 + 维度，中文展示
-- 可喂 get_data_dictionary() 升级 LLM 问数；也可直接 psql 查阅
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（禁 CREATE OR REPLACE，防后迁移加列报错）
-- 部署后需重启 postgrest: docker compose restart postgrest

DROP VIEW IF EXISTS semantic_dictionary_v;

CREATE VIEW semantic_dictionary_v AS
SELECT
  'metric'::text               AS kind,
  metric_code                  AS code,
  name,
  description,
  business_formula             AS formula,
  measure_type,
  additive,
  cost_sensitive,
  unit
FROM metric_registry
WHERE enabled
UNION ALL
SELECT
  'dimension'::text            AS kind,
  dim_code                     AS code,
  name,
  description,
  business_rule                AS formula,
  source_type                  AS measure_type,
  is_assessed_filter           AS additive,
  NULL::boolean                AS cost_sensitive,
  NULL::text                   AS unit
FROM dimensions
WHERE enabled;

ALTER VIEW semantic_dictionary_v OWNER TO postgres;
ALTER VIEW semantic_dictionary_v SET (security_invoker = true);
GRANT SELECT ON semantic_dictionary_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 079 completed: semantic_dictionary_v'; END $$;
```

- [ ] **Step 4: 应用迁移 + 跑验证查询**

```bash
psql -U postgres -d insforge -f database/migrations/079_semantic_dictionary_v.sql
psql -U postgres -d insforge -c "SELECT kind, code, name FROM semantic_dictionary_v ORDER BY kind, code;"
```
Expected: 11 行（9 metric + 2 dimension）。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/079_semantic_dictionary_v.sql
git commit -m "feat(db): semantic_dictionary_v human-readable dictionary (semantic layer A1)"
```

---

## Task 5: 生产部署 + 重启 postgrest + 验证

**Files:** 无新文件

- [ ] **Step 1: 推送触发 GHA**

```bash
git push origin main
```

- [ ] **Step 2: 等 GHA 完成，重启 postgrest 刷 schema 缓存**

```bash
gh run watch --exit-status
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: 生产验证 4 个对象**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT COUNT(*) AS metrics FROM metric_registry; SELECT COUNT(*) AS levels FROM dimension_levels; SELECT * FROM validate_semantic_registry(); SELECT COUNT(*) AS dict_rows FROM semantic_dictionary_v;'"
```
Expected: metrics=9, levels=4, 校验 0 行, dict_rows=11。

---

## Self-Review

### 1. Spec Coverage（对照 semantic-layer spec §3）

| spec 要求 | A1 task | 说明 |
|---|---|---|
| metric_registry 表（base/derived + additive + cost_sensitive + 双语） | Task 1 | ✅ |
| 9 指标种子（sale/profit×3源 + outbound derived×2 + margin） | Task 1 | ✅ |
| dimensions + dimension_levels 表 | Task 2 | ✅ |
| branch 三级层级种子 | Task 2 | ✅ |
| 静态校验（fact 存在/依赖闭环/join_key） | Task 3 | ✅ |
| semantic_dictionary_v 字典视图 | Task 4 | ✅ |
| achievement_rate 指标 | — | 推迟（依赖 targets 体系，scope 注明） |
| customer 维度 + dim_customer | A4 | 推迟（需物化管道） |
| category/date 维度 | 后续 | 推迟（品类层级/内置维度设计） |
| 视图生成器 | A2 | 不在 A1 |
| admin 页 | A3 | 不在 A1 |

A1 scope 内的 spec 要求全覆盖。推迟项均有理由，非遗漏。

### 2. Placeholder Scan
✅ 无 TBD/TODO，所有 SQL 完整，验证查询带期望输出。

### 3. Type Consistency
✅ `metric_registry.metric_code` / `dimensions.dim_code` / `dimension_levels.dim_code` 跨 Task 一致
✅ Task 3 校验引用的列名（fact_table/value_column/depends_on/join_key/key_column）与 Task 1/2 建表一致
✅ Task 4 视图引用的列名（business_formula/business_rule/measure_type/source_type）与 Task 1/2 一致

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-22-semantic-layer-phaseA1.md`.**
