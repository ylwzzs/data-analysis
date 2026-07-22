# 报表语义层（自建轻量 Semantic Layer）设计

**日期**：2026-07-22
**状态**：已确认，待实现
**前置决策**：经对比 Cube.dev（重，与 RLS/DuckDB 体系冲突）后选定自建轻量语义层（B 档）
**关联**：本设计是 `2026-07-21-report-center-redesign-design.md` 的架构升级，解决"报表越来越多导致视图爆炸、口径散落"的根因

---

## 1. 背景与目标

### 1.1 问题

当前报表模式是「1 报表 = 1 手写视图 + 1 聚合管道 + 1 dataset 注册」。每加一个报表：
- 视图里重写聚合、完成率、脱敏逻辑（`report_region_breakdown_v` 已是 180 行手写 UNION ALL）
- 指标口径散落在视图 SQL（`metric_definitions` 对 outbound 是 NULL 指针，真口径在 `report_achievement_v` 的 LATERAL 里）
- 前端 4+ 组件重复实现格式化/三色/outbound 双查/战区白名单
- 数据源假设易错（Phase 2 踩过 3 处：假设 report_daily_* 有 item_num/client_name，实际已聚合丢弃）

### 1.2 目标

把「指标口径」和「维度层级」从视图 SQL 抽成**声明式 registry**，由**视图生成器**自动产出下钻视图，配**只读 admin 驾驶舱**监控对账——定义一次，报表按需组合生成。

### 1.3 非目标（YAGNI）

- 不做运行时动态查询引擎（保留静态 PG 视图，兼容 security_invoker+RLS）
- 不引入 Cube / DataHub / dbt 等外部服务
- admin 页面不做运行时改口径（定义走 migration，可审计）

---

## 2. 五层架构

```
① 明细事实层 (Fact) ───── 已有，不动 ─────
   retail_detail / delivery_detail / wholesale_detail (S3 parquet)
   含 item_num / client_name / 各毛利（采集层已采，字段齐全）
                    │ /compute 聚合（配置驱动，已有）
② 维度层 (Dimension) ──── 补建 ────────
   dim_branch(已有) / dim_item(已有) / dim_customer(新建,派生)
   dimensions + dimension_levels 元数据表（层级链）
                    │
③ 指标层 (Metric Registry) ── 新建核心 ──
   base measure (fact+col+agg) + derived measure (formula+depends_on)
   additive 标记（比率须重算）+ cost_sensitive（脱敏）+ 双语命名
                    │ 指标×维度 组合
④ 视图生成器 (View Generator) ── 新建 ──
   读 registry+维度 → 自动产出下钻视图（替代手写 UNION ALL）
   产物=静态 PG 视图（100% 兼容 security_invoker+RLS）
   + 三层校验（静态 / 生成 EXPLAIN / 对账 rollup+双轨）
                    │
⑤ 消费层 (Report + Admin) ─────────────
   报表组件读生成的视图（Phase 2 的 4 个报表）
   /admin/semantic 只读驾驶舱（字典/口径/对账，定义走 migration）
```

---

## 3. 详细设计

### 3.1 指标层 —— metric_registry

替代现有 `metric_definitions`（保留旧表做兼容，逐步迁移）。声明式定义两类指标：

**base measure（基础度量）**：直接从事实表聚合
**derived measure（派生指标）**：基于其他指标运算（比率、跨表求和）

```sql
CREATE TABLE metric_registry (
  metric_code      TEXT PRIMARY KEY,        -- 程序用，英文稳定（sale_amount）
  name             TEXT NOT NULL,           -- 中文名（销售金额）★双语
  description      TEXT,                    -- 业务口径说明（中文自然语言）
  business_formula TEXT,                    -- 中文公式（各门店 sale_money 之和）

  measure_type     TEXT NOT NULL CHECK (measure_type IN ('base','derived')),

  -- base measure 字段
  fact_table       TEXT,                    -- base: retail_detail（derived: NULL）
  value_column     TEXT,                    -- base: sale_money（derived: NULL）
  agg              TEXT,                    -- base: SUM/COUNT_DISTINCT/AVG（derived: NULL）

  -- derived measure 字段
  formula          TEXT,                    -- derived: profit/amount（base: NULL）
  depends_on       JSONB,                   -- derived: ["sale_profit","sale_amount"]（base: NULL）

  -- 语义属性
  additive         BOOLEAN NOT NULL,        -- true:可按维度SUM; false:比率须重算
  cost_sensitive   BOOLEAN DEFAULT false,   -- 是否需 can_see_cost 脱敏
  unit             TEXT,                    -- 元 / % / 件

  -- 治理
  data_ready       BOOLEAN DEFAULT true,
  enabled          BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);
```

**additive 标记的作用**：解决调研雷区 #7——`sale_profit_rate` 等明细行级比率字符串不能直接 SUM。生成器对 `additive=false` 的指标强制用 `SUM(profit)/SUM(amount)` 重算，不直接 SUM 比率。

**初始指标集**（迁移种子）：

| metric_code | name | type | 口径 | additive |
|---|---|---|---|---|
| sale_amount | 销售金额 | base | retail_detail.sale_money SUM | true |
| sale_profit | 销售毛利 | base | retail_detail.profit SUM | true |
| delivery_amount | 出库金额 | base | delivery_detail.out_money SUM | true |
| delivery_profit | 出库毛利 | base | delivery_detail.profit_money SUM | true |
| wholesale_amount | 批发金额 | base | wholesale_detail.wholesale_money SUM | true |
| wholesale_profit | 批发毛利 | base | wholesale_detail.wholesale_profit SUM | true |
| outbound_amount | 总出库金额 | derived | delivery_amount + wholesale_amount | true |
| outbound_profit | 总出库毛利 | derived | delivery_profit + wholesale_profit | true |
| margin | 毛利率 | derived | profit/amount | **false** |
| achievement_rate | 达成率 | derived | actual/target | **false** |

### 3.2 维度层 —— dimensions + dimension_levels + dim_customer

#### 3.2.1 维度元数据

```sql
CREATE TABLE dimensions (
  dim_code          TEXT PRIMARY KEY,        -- 程序用（branch/item/customer/category/date）
  name              TEXT NOT NULL,           -- 中文名（门店/商品/批发客户）★双语
  description       TEXT,                    -- 业务说明（中文）
  source_type       TEXT NOT NULL CHECK (source_type IN ('static','derived')),
  join_table        TEXT NOT NULL,           -- JOIN 的维表（dim_branch/dim_customer）
  join_key          TEXT NOT NULL,           -- JOIN 键列（branch_num/client_code）
  source_fact_table TEXT,                    -- derived: 派生自哪张事实表（static: NULL）
  business_rule     TEXT,                    -- derived: 派生规则（中文自然语言）★
  is_assessed_filter BOOLEAN DEFAULT false,  -- 是否套 is_assessed_war_zone 白名单
  enabled           BOOLEAN DEFAULT true
);

CREATE TABLE dimension_levels (
  dim_code       TEXT NOT NULL REFERENCES dimensions(dim_code),
  level_code     TEXT NOT NULL,              -- region/sub_region/store
  level_name     TEXT NOT NULL,              -- 战区/小区/门店 ★双语
  depth          INT NOT NULL,               -- 0/1/2
  key_column     TEXT NOT NULL,              -- first_level_region/second_level_region/branch_num
  name_column    TEXT NOT NULL,              -- 显示名列（同 key 或 branch_name）
  parent_level   TEXT,                       -- 父级 level_code（最顶层 NULL）
  rollup_strategy TEXT DEFAULT 'sum',        -- sum/distinct_count
  PRIMARY KEY (dim_code, level_code)
);
```

#### 3.2.2 初始维度集

**branch 维度**（复用 dim_branch）：

| dim_code | level_code | level_name | depth | key_column | parent_level |
|---|---|---|---|---|---|
| branch | region | 战区 | 0 | first_level_region | NULL |
| branch | sub_region | 小区 | 1 | second_level_region | region |
| branch | store | 门店 | 2 | branch_num | sub_region |

`is_assessed_filter=true`（套 `is_assessed_war_zone()` 白名单，单一真相源）。

**item 维度**（复用 dim_item）：商品级，category_path 三段层级可后续扩展。

**customer 维度**（新建 dim_customer，派生）：
```
dim_code: customer
name: 批发客户
source_type: derived
join_table: dim_customer
join_key: client_code
source_fact_table: wholesale_detail
business_rule: "批发明细里客户名匹配不到 64188 门店的，都是外部批发客户"
is_assessed_filter: false
```

#### 3.2.3 dim_customer 物化表（派生维度固化）

```sql
CREATE TABLE dim_customer (
  client_code   TEXT,
  client_name   TEXT NOT NULL,
  first_seen    DATE,            -- 首现日期
  active_days   INT,             -- 活跃天数
  PRIMARY KEY (client_code, client_name)
);
```

**物化逻辑**（走 /compute 管道，随 wholesale 采集刷新）：
```sql
INSERT INTO dim_customer
SELECT DISTINCT
  client_code, client_name,
  MIN(biz_date), COUNT(DISTINCT biz_date)
FROM wholesale_detail
WHERE client_name NOT IN (
  SELECT branch_name FROM dim_branch WHERE system_book_code='64188'
)
GROUP BY client_code, client_name
ON CONFLICT (client_code, client_name) DO UPDATE SET ...;
```

把现在散落在 `wholesale_detail` sql_template（`066:21`）和 `report_category_summary_v` 里的"client_name→门店"匹配规则**收敛到一处**。

### 3.3 视图生成器

**形态**：一个 PG 函数 `generate_drilldown_view(metric_codes, dim_code, levels)`，读 registry + dimension_levels，输出并执行视图 DDL。

**机制**：
1. 对每个 level（如 branch 的 region/sub_region/store），按 `key_column` 聚合 base measure
2. derived measure 按 `formula + depends_on` 重算（additive=false 的比率用 SUM 分量重算）
3. 多层 UNION ALL（每层一个分支），parent_code 串联层级
4. `cost_sensitive` 指标套 `can_see_cost` CASE 脱敏
5. `is_assessed_filter` 的维度套白名单函数

**产出**：静态 PG 视图，`security_invoker=true` + GRANT，100% 兼容现有权限链路。

**替代**：`report_region_breakdown_v`（180 行手写）→ 生成器读 branch 维度 3 level + sale/delivery 指标自动产出。

### 3.4 校验机制（三层防线）

#### 第一层：定义时校验（静态）
`validate_semantic_registry()` 函数，部署时自动跑：
- base measure 的 `fact_table.value_column` 真实存在
- derived measure 的 `depends_on` 指向已定义指标（闭环）
- 维度 `join_key` 在 `join_table` 存在
- 组合合法性（某指标能否按某维度切）

#### 第二层：生成时校验
生成器产出 DDL 后立即 `EXPLAIN`——语法错、字段不存在、类型不匹配当场暴露。校验 `additive=false` 未被错误直接 SUM。

#### 第三层：结果对账（核心）

**① Rollup 不变性（自校验）**：生成器配套产出 `_audit` 视图，算各层级加总差异：
```
战区销售之和 = 全公司总额？  各小区之和 = 所属战区？  门店之和 = 所属小区？
```
diff≠0 报错。不靠外部数据，自身抓 bug。

**② 双轨对账（迁移期）**：语义层新视图 vs 旧手写视图并行：
```sql
SELECT
  (SELECT SUM(total_sale) FROM report_region_breakdown_v) AS old_total,
  (SELECT SUM(sale_amount) FROM semantic_store_sales_v)   AS new_total,
  ABS(old_total-new_total) AS diff;
```
diff=0 才允许下线旧视图。

**③ 快照对账**：关键指标存历史正确值快照，刷新后对比，漂移告警。

### 3.5 语义字典 + Admin 驾驶舱

#### semantic_dictionary_v 视图
JOIN metric_registry + dimensions，人类可读清单（中文），同时喂 `get_data_dictionary()` 升级 LLM 问数。

#### /admin/semantic 页面（只读，复用现有 web/app/admin/）
```
/admin/semantic              字典清单（指标+维度，搜索/筛选）
/admin/semantic/metric/[code] 指标详情（口径/依赖/可切维度/实时对账值）
/admin/semantic/dim/[code]    维度详情（层级树/JOIN规则/派生规则中文）
/admin/semantic/audit         对账面板（rollup差异/双轨对比/快照告警，绿✓红✗）
/admin/semantic/dag           指标依赖图（可选，react-flow）
```

**定位 A（已确认）**：只读监控 + 对账，定义变更走 migration（可审计、可 review、可回滚）。UI 可提供"编辑提案"生成 migration patch，落盘仍是代码。

---

## 4. 数据流

```
采集（已有）→ 明细 parquet → /compute 聚合 → report_daily_*（已有）

定义期（开发者）：
  migration 写 metric_registry / dimensions / dim_customer 定义
  → validate_semantic_registry() 静态校验
  → generate_drilldown_view() 产出视图 DDL + EXPLAIN 校验
  → _audit 视图 + 双轨对账
  → 绿✓ 则上线，红✗ 阻断部署

运行期（用户）：
  报表组件读生成的视图（PostgREST + security_invoker + RLS）
  admin 驾驶舱读 registry + 对账视图展示
```

---

## 5. 落地分阶段

### Phase A：语义层地基
1. `metric_registry` 表 + 种子指标
2. `dimensions` / `dimension_levels` 表 + branch/item/customer 种子
3. `dim_customer` 物化表：**依赖扩展 /compute 管道**（新增 `daily_customer` report_type，DuckDB 读 `wholesale_detail` parquet 派生 distinct client，因该明细在 S3 不在 PG）。wholesale 采集后刷新
4. `validate_semantic_registry()` 静态校验
5. 视图生成器 `generate_drilldown_view()`
6. `semantic_dictionary_v` + 对账视图
7. `/admin/semantic` 只读页面（字典 + 对账面板）
8. **双轨验证**：用 Phase 1 的 region_breakdown / category_summary 做对账（新视图 vs 旧手写，diff=0）

> Phase A 子项较多，实现计划阶段会拆成多个 plan（如：A1 元数据表+校验、A2 生成器+对账、A3 admin 页面、A4 dim_customer 管道），各自独立可验证。

### Phase B：迁移 + Phase 2 报表（首批客户）
1. 旧手写视图逐步迁移到生成器产出
2. Phase 2 的 4 个报表用语义层生成：
   - 战区门店出库报表（branch 维度 + delivery 指标，生成器产出）
   - 批发客户出库报表（customer 维度 + wholesale 指标）
   - 销售商品 TOP20（item 维度 + sale 指标，需补 daily_sales_item 商品级管道）
   - 出库商品 TOP20（item 维度 + delivery/wholesale 指标，需补商品级管道）
3. 商品级/客户级明细聚合管道（report_definitions 扩展，配置驱动）

> Phase 2 的商品级/客户级管道属于「计算数据流扩展」，Phase B 前需更新 architecture.md（补 report_daily_sales_item / report_daily_wholesale_client 等物化表）。

---

## 6. 现状约束（雷区，实现须遵守）

1. 视图必须 `DROP VIEW IF EXISTS + CREATE VIEW`，禁 `CREATE OR REPLACE`（后迁移加列重跑报 `cannot drop columns from view`）
2. `migrate.sh` 每次部署重跑全部迁移——所有 DDL 幂等
3. 加表/加列后须 `docker compose restart postgrest` 刷 schema 缓存（GHA 不保证重启）
4. 明细在 S3 parquet 不在 PG——明细级查询只能走 DuckDB `/query`，PostgREST 读不到
5. 视图脱敏用 `security_invoker=true` + 基表 GRANT，**不能用 FORCE RLS**（对 superuser owner 无效）
6. `columns_typed=FALSE` 的明细列全字符串，生成器产出的 SQL 对明细须显式 CAST
7. 比率指标（`sale_profit_rate` 等明细行级字符串）不能直接 SUM，须 `SUM(profit)/SUM(amount)` 重算——靠 `additive=false` 标记保证

---

## 7. 可复用资产（不重复造轮子）

| 资产 | 复用方式 |
|---|---|
| `metric_definitions` 表骨架 | metric_registry 参考其结构扩展 |
| `report_definitions` + /compute | 商品级/客户级管道走配置驱动扩展 |
| `datasets` / `dataset_columns` | 列级 `is_sensitive`/`join_to` 复用 |
| `dim_branch` 三级层级 + `is_assessed_war_zone()` | branch 维度单一真相源 |
| `canonical_product` 跨品牌合并 | item 维度复用 |
| `claim_match_or_star` 四维 RLS | 生成的视图继承 |
| `web/app/admin/` 基础设施 | 语义层 admin 页复用 layout |
| `get_data_dictionary()` | semantic_dictionary_v 喂给它升级问数 |

---

## 8. 附录

### 8.1 端到端价值示例

新增「出库商品 TOP20」报表：

**旧方式**：手写 sql_template → 建物化表 → 手写 180 行视图 → 注册 dataset → 前端写专用组件（重写格式化）。口径可能抄错，4 处重复。

**新方式**：
1. metric_registry 加 2 行：`delivery_item_amount` / `delivery_item_profit`（base）
2. 生成器读 [指标 × item 维度] 自动产出 `report_product_delivery_top20_v`
3. /admin/semantic/audit 自动对账（rollup + 双轨），绿✓ 才上线
4. 前端复用通用 DataTable（格式化在公共 utils）

口径单一来源、视图自动生成、对账保证、前端不重复。

### 8.2 相关文件

- 设计前提：`docs/superpowers/specs/2026-07-21-report-center-redesign-design.md`
- 现状调研：见本会话 Explore agent 报告（75 迁移 + services + web 全摸底）
- 约束来源：`CLAUDE.md`（迁移幂等 / postgrest 重启 / security_invoker）

### 8.3 关键迁移文件索引（现状）
- 明细注册：`031_data_registry.sql`、`049_transfer_detail_collect.sql`、`050_wholesale_detail_collect.sql`
- 聚合管道：`010_report_definitions.sql`、`058_outbound_achievement.sql`、`067_category_three_class.sql`
- 指标雏形：`046_report_targets.sql`（metric_definitions）
- 维度：`024_master_data.sql`（dim_item）、`029_dim_branch.sql`、`052_branch_region_columns.sql`
- 权限：`039_security_invoker.sql`、`072_permission_roles.sql`（claim_match_or_star）
- 现有视图：`066`（report_achievement_v）、`073/075`（region_breakdown）、`074`（category_summary）
