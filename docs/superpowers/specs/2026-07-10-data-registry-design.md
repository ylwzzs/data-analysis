# 报表体系 · 子系统 B：数据注册中心（设计文档）

> **状态**：设计已批准（2026-07-10，范围 = Full：LLM 侧 + 引擎侧双侧实时消费），待用户复审 → 转 writing-plans。
> **范围**：报表体系拆 4 子系统（A 主数据 / B 数据注册中心 / C 报表触发+取数 / D 目标达成率），本规格只覆盖 **B**。
> **前置**：A（`dim_item`/`dim_branch`/`dim_region`/`canonical_product`）已落地并全链路测试通过。
> **架构约束**：本设计新增 2 张注册表 + 退役 `data_sources_meta` + 改写 OpenClaw 插件 + 改写 `functions/agent-query`——按 CLAUDE.md，实现前须用户同意（已）+ 更新 `docs/architecture.md`（并入实现步骤）。

---

## 1. 背景与目标

OpenClaw 取数要知道「有哪些可查数据集、各有哪些列、哪些列成本敏感要脱敏、明细和汇总怎么选、怎么 JOIN」。**今天这些知识硬编码在两处，靠人手同步**：

| 位置 | 硬编码内容 |
|---|---|
| `openclaw/data-query-plugin/skills/retail-query/SKILL.md` | 给 LLM 看的：`retail_detail` 列（按 订单/门店/商品/金额/**成本组** 分组）、3 张汇总表列、日期语义、明细vs汇总选择、四条铁律 |
| `functions/agent-query/index.js` | 给引擎看的：`RETAIL_GLOB`（parquet glob）、`COST_COLUMNS`（成本列整组脱敏）、`REPORT_TABLES`（PG/DuckDB 路由）、临时视图构建、branch 过滤、成本脱敏 |

**病根**：同一个事实（「哪些列成本敏感」「哪些表走 PG」）在两处各存一份，改一处忘另一处就脱节——典型如字典说某列敏感、引擎却没脱敏 → **泄露**；或 A 新建的维表（`dim_item`/`dim_branch`/`dim_region`）根本没进字典 → OpenClaw 不知道它们存在、不知道能按战区/品类汇总。

**B 的目标**：PG 注册表作为**唯一事实源**，运行时**双侧实时消费**——
- **LLM 侧**：拿活的数据字典（数据集 + 分组列 + 敏感度 + 日期/JOIN/CAST 提示），`SKILL.md` 瘦身为纯规则。
- **引擎侧**：`agent-query` 从注册表读 glob/成本列/路由，替代三处硬编码常量。

新增维表/报表 = **插一行 → 两侧自动感知**，永不改 markdown、内容变更永不重部署（插件/function 各只改**一次**）。

---

## 2. 现状依据（Explore 实测，2026-07-10）

| 事实 | 位置 | 说明 |
|---|---|---|
| `retail_detail` 是**每请求临时视图** | `functions/agent-query/index.js` `runDuckdb` (94-116) | `CREATE OR REPLACE TEMP VIEW retail_detail AS SELECT * REPLACE(...) FROM read_parquet('<glob>') <branchFilter>`；非持久化 |
| glob 硬编码 | 同上 line 17 | `RETAIL_GLOB = "s3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet"` |
| 成本列硬编码（**整组**脱敏） | 同上 19-26 | `COST_COLUMNS = ["item_cost_price","order_detail_cost","order_detail_grade_cost","cost","profit","sale_profit_rate"]`；整组脱敏防 `sale_money×sale_profit_rate` 反算 profit |
| 路由硬编码 | 同上 28、76 | `REPORT_TABLES = ["report_daily_sales","report_daily_category","report_weekly_trend"]`；SQL 命中任一→走 PG，否则走 DuckDB |
| 权限来自 016 | `get_user_perms(wecom_id)` | 返回 `branch_nums`（门店过滤）+ `can_see_cost`（成本脱敏开关）。引擎据此建 branchFilter + 成本 CASE |
| `/compute` 已配置驱动 | `services/server.js` 485-561 | 读 `report_definitions` → 占位符替换 → DuckDB 聚合 → field_mapping → upsert `target_table` |
| `report_definitions`（010） | 迁移 | report_type/name/target_table/source_pattern/sql_template/field_mapping/conflict_keys；3 张报表已配。**这是已工作的配置驱动报表目录，B 复用不重建** |
| `data_sources_meta`（006） | 迁移 | 本意是表结构目录，但**唯一种子是臆想的** `销售明细/sales/s3://data/sales/*.parquet`（id/date/region…），与真实 `retail_detail` 不符，**从未接进 agent 路径** → 退役（同 `lemeng_items` 教训） |
| 两处硬编码重复 | SKILL.md + agent-query | `retail_detail` 列清单、成本组、报表清单各存一份，靠人手同步 |

**结论**：B 不是「再建一个目录」，是**把已有的两处硬编码统一收口到 PG**，并把死的 `data_sources_meta` 换成真实注册表。

---

## 3. 设计

### 3.1 `datasets`（可查数据集注册表）

每条 = LLM 能 SELECT 的一个逻辑表（`retail_detail` / `report_daily_sales` / `dim_branch` …）。

```sql
CREATE TABLE IF NOT EXISTS datasets (
    name            TEXT PRIMARY KEY,          -- 逻辑名，LLM SQL 用（retail_detail / report_daily_sales / dim_item）
    display_name    TEXT NOT NULL,             -- 中文标签（销售明细）
    engine          TEXT NOT NULL,             -- 'duckdb_view'（DuckDB 临时视图/parquet）| 'pg_table'（PostgREST）
    source          TEXT NOT NULL,             -- duckdb_view: parquet glob；pg_table: PG 表名/视图名
    kind            TEXT NOT NULL,             -- 'fact'(明细) | 'summary'(汇总) | 'dim'(维表) | 'view'(合并视图)
    is_realtime     BOOLEAN NOT NULL DEFAULT FALSE,  -- fact=TRUE(明细实时当天有)；summary=FALSE(汇总滞后)→驱动明细vs汇总路由
    columns_typed   BOOLEAN NOT NULL DEFAULT FALSE,  -- FALSE=全字符串需 CAST(明细)；TRUE=数值/DATE 直接算(汇总/dim)
    date_column     TEXT,                      -- 日期过滤列（明细 order_detail_bizday / 汇总 biz_date）
    date_format     TEXT,                      -- 'YYYYMMDD' | 'DATE' | NULL
    carry_enabled   BOOLEAN NOT NULL DEFAULT FALSE,  -- 维表：C 是否已接小表搬运（可 JOIN 进 DuckDB）；FALSE=仅直接查询
    exposed         BOOLEAN NOT NULL DEFAULT TRUE,   -- 进 LLM 字典 + 引擎可路由；FALSE=登记但不暴露（如维表待 C 接入前）
    description     TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by      TEXT
);
```

- **engine 决定路由**（替代硬编码 `REPORT_TABLES`）：`pg_table`→PostgREST，`duckdb_view`→DuckDB。
- **carry_enabled**：维表能否跨引擎 JOIN 进明细查询。C 接入搬运前为 FALSE（LLM 可直接查维表做 lookup，但不能 JOIN 进 `retail_detail` 聚合）。
- **exposed**：统一开关。字典 + 引擎路由都过滤 `WHERE exposed`。

### 3.2 `dataset_columns`（列注册表，子表）

**不用 JSONB blob**（避免 `data_sources_meta` 那种臆想 blob 的坑），用可查子表：

```sql
CREATE TABLE IF NOT EXISTS dataset_columns (
    dataset_name    TEXT NOT NULL REFERENCES datasets(name) ON DELETE CASCADE,
    name            TEXT NOT NULL,             -- 列名
    data_type       TEXT,                      -- 语义提示（明细多为 VARCHAR；汇总 INTEGER/DECIMAL/DATE）
    semantic_group  TEXT,                      -- 订单/门店/商品/金额/成本/供应商/经营/折扣（字典分组展示用）
    is_sensitive    BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE → 按 can_see_cost 整组脱敏（替代硬编码 COST_COLUMNS）
    join_to         TEXT,                      -- JOIN 提示，如 'dim_branch(system_book_code,branch_num)'
    description     TEXT,
    ordinal         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dataset_name, name)
);
CREATE INDEX IF NOT EXISTS idx_dataset_columns_dataset ON dataset_columns(dataset_name);
```

- **is_sensitive 是组语义**：所有 `is_sensitive=TRUE` 的列**整组**按 `can_see_cost` 一起 NULL 化（实测：必须整组，否则 `sale_money×sale_profit_rate` 反算 profit）。来源从硬编码 `COST_COLUMNS` 改成 `WHERE is_sensitive`。
- **join_to**：关联提示（给 LLM + C 用）。明细 `branch_num`→`dim_branch`、`item_num`→`dim_item`、`item_code`→`canonical_product`。仅当对端 `carry_enabled=TRUE` 时该 JOIN 才真正可用。

### 3.3 读口 `get_data_dictionary()` RPC

单一调用返回塑形好的紧凑字典（LLM 注入 + 引擎读取共用）：

```sql
CREATE OR REPLACE FUNCTION get_data_dictionary()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    ds   JSONB;
    cols JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.kind, d.name), '[]'::jsonb)
      INTO ds
      FROM (SELECT name, display_name, engine, kind, is_realtime, columns_typed,
                   date_column, date_format, carry_enabled, description
              FROM datasets WHERE exposed) d;

    SELECT COALESCE(jsonb_agg(row_to_json(c) ORDER BY c.dataset_name, c.ordinal), '[]'::jsonb)
      INTO cols
      FROM (SELECT dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description
              FROM dataset_columns c JOIN datasets d ON d.name = c.dataset_name
             WHERE d.exposed) c;

    RETURN jsonb_build_object('datasets', ds, 'columns', cols);
END;
$$;
GRANT EXECUTE ON FUNCTION get_data_dictionary() TO authenticated;
```

> 消费方也可直接打 PostgREST（`/datasets?select=...`、`/dataset_columns`），RPC 只是把两表聚成一次调用。引擎侧需精确字段时走 PostgREST 直查更省。

### 3.4 LLM 侧交付（OpenClaw）

- **`SKILL.md` 瘦身为纯规则**（极少变）：四条铁律（绝不编造/忠于原话/日期标注/一问一查）、日期处理、明细vs汇总决策逻辑、呈现规范。**删除**硬编码的列清单/成本组/报表清单（改活字典）。
- **活字典注入（已定）**：插件加 `list_datasets()` 工具 → POST PostgREST `/rpc/get_data_dictionary` 拉字典，LLM 会话首查前调一次（之后按需）。备选「`agent-query` 每次返回附带精简字典」不取（每响应多 token、且混淆查询结果与元数据）。
- **一次性插件改动**（scp + `install -l` + restart，GHA 不管 `openclaw/`）；之后**内容变更零部署**。

### 3.5 引擎侧交付（`functions/agent-query/index.js`）

一次性改写，三处硬编码常量改成查注册表：

| 硬编码 | 改读注册表 |
|---|---|
| `RETAIL_GLOB` | `SELECT source FROM datasets WHERE name='retail_detail'` |
| `COST_COLUMNS` | `SELECT name FROM dataset_columns WHERE is_sensitive AND dataset_name='retail_detail'` |
| `REPORT_TABLES`（路由） | `SELECT name FROM datasets WHERE engine='pg_table' AND exposed` |

- 路由逻辑：解析 LLM SQL 的 FROM 表名 → 查 `datasets.engine` → `pg_table` 走 PostgREST、`duckdb_view` 走 DuckDB（等价今天的 `isReportQuery`，但来源是注册表）。
- 临时视图构建（glob + branchFilter + 成本 CASE）逻辑不变，只是 glob/成本列来源改注册表。
- **一次性 function 改动**（SSH PUT + 清 Deno 缓存）；之后加成本列/报表表 = 插行，网关自动适配。

---

## 4. 数据流

```
PG datasets + dataset_columns  ◄── 人工/采集后登记（INSERT 一行）+ C 接入时翻 carry_enabled/exposed
        │
        ├──► get_data_dictionary() ──► OpenClaw 活字典（LLM 知道有啥/怎么 JOIN/哪些敏感）
        │
        └──► agent-query 读取 ──► 建 retail_detail 视图(glob + 成本脱敏) + PG/DuckDB 路由
```

---

## 5. 与其他子系统接口

- **A（主数据）**：A 建的 `dim_item`/`dim_branch`/`dim_region`/`canonical_product` 在 B 登记（kind=dim/view，engine=pg_table）。`carry_enabled` 初值 FALSE——C 接小表搬运后翻 TRUE，届时 LLM 才能把维表 JOIN 进明细聚合。
- **C（报表触发+取数）**：① C 接小表搬运时，把对应维表 `carry_enabled` 翻 TRUE；② 报表聚合定义仍归 `report_definitions`（已配置驱动、`/compute` 已读），**B 不重建**，只在字典里把 summary 类数据集曝光；③ C 的「OpenClaw 先命中标准报表、不中再下沉 DuckDB」策略读 B 的字典判断 kind/is_realtime。
- **权限**：B **不改权限模型**（仍 016 的 branch_nums/can_see_cost），只**消费** `can_see_cost` 决定脱敏哪组（`is_sensitive`）。

---

## 6. 退役

- **`data_sources_meta`（006）**：REVOKE 写权限（只读保留，备查）或直接 DROP。同 `lemeng_items` 教训——臆想占位、从未接线。
- `SKILL.md` 的列清单/成本组/报表清单段落删除（迁入注册表）。
- `agent-query/index.js` 的 `RETAIL_GLOB`/`COST_COLUMNS`/`REPORT_TABLES` 常量删除（改读注册表）。

---

## 7. 实现任务（→ writing-plans 展开）

1. **迁移（幂等）**：建 `datasets` + `dataset_columns` + `get_data_dictionary()` RPC + GRANT；`DROP VIEW IF EXISTS` 无关；退役 `data_sources_meta` 写权限。
2. **种真实数据**：
   - `retail_detail`（duckdb_view / fact / realtime / columns_typed=false / date=order_detail_bizday YYYYMMDD）+ 全量列（按 订单/门店/商品/供应商/金额/折扣/经营/成本 分组，成本组 is_sensitive=TRUE）。
   - `report_daily_sales` / `report_daily_category` / `report_weekly_trend`（pg_table / summary / columns_typed=true / date=biz_date 或 week_start）。
   - `dim_item` / `canonical_product` / `dim_branch` / `dim_region`（pg_table / dim / carry_enabled=false / exposed=true 可直接 lookup）。
3. **RPC 验证**：`SELECT get_data_dictionary();` 返回结构正确。
4. **改 `agent-query/index.js`**：三常量改读注册表；路由按 engine；SSH PUT + 清 Deno 缓存部署。
5. **改 `SKILL.md`**：删硬编码列清单，留规则；加活字典注入；SSH 部署插件（一次性）。
6. **端到端验证**：
   - ① 插一行假维表（exposed=true）→ LLM 下一轮字典可见、**无需重部署**；
   - ② 成本脱敏仍正确（无 can_see_cost 用户查到成本列全 NULL）；
   - ③ 路由仍正确（查 retail_detail 走 DuckDB、查 report_* 走 PG）。

---

## 8. 已定 / 延后

| 项 | 决定 |
|---|---|
| 交付方式 | 运行时实时（双侧），用户已选 |
| 范围 | Full（LLM + 引擎双侧） |
| 报表聚合定义 | 复用 `report_definitions`，不重建 |
| 列存储 | 子表 `dataset_columns`，不用 JSONB blob |
| 敏感度 | 组语义，`is_sensitive` 整组按 can_see_cost 脱敏 |
| 维表 JOIN | `carry_enabled` 初 FALSE，C 接入后翻 TRUE |
| `data_sources_meta` | 退役（臆想占位） |
| 活字典注入实现 | 插件 `list_datasets` 工具 → `/rpc/get_data_dictionary`（已定） |
| 插件/function 部署 | 各一次性 SSH 部署；之后内容变更零部署 |

---

## 9. 风险与注意

- **引擎侧改写是承重改动**：`agent-query` 是所有 OpenClaw 取数的网关，改错会全线下线。须保留行为等价（脱敏、路由、branch 过滤），用当前硬编码值作为注册表种子的 ground truth，改完先比对同一 SQL 旧/新结果一致再上线。
- **成本组整组脱敏不可破**：注册表种子里成本 6 列 `is_sensitive` 必须**全 TRUE**，漏一个就泄露；且整组同进同出（引擎实现须对 `is_sensitive` 集合统一 CASE，不能逐列独立判断）。
- **路由解析 SQL 表名**：从 LLM SQL 解析 FROM 表名做 engine 查表，需稳健（子查询/别名/大小写）。MVP 可退化为「命中任一 pg_table 名→PG，否则 DuckDB」（等价今天），后续再精细化。
- **维表暴露 vs JOIN**：维表 exposed=true（可直接 lookup）但 carry_enabled=false（不能 JOIN 进明细聚合）须在字典里对 LLM 讲清，否则 LLM 尝试 `retail_detail JOIN dim_branch` 会因跨引擎失败 → 触发编造风险。字典条目要显式标注「直接查询 OK；JOIN 进明细待 C」。
- **B/C 时序**：维表完整可用（JOIN 进明细）依赖 C 的小表搬运。B 先把字典/引擎收口到注册表（明细+汇总全通），维表先做直接 lookup；JOIN 能力随 C 落地翻 `carry_enabled`。
- **插件部署是手动 SSH**：`openclaw/` 不走 GHA，SKILL.md/插件改动须 scp + `install -l` + restart（见架构 §5 OpenClaw 部署坑）。一次性付出，之后内容活。
