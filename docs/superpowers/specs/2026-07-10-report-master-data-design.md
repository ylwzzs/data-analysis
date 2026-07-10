# 报表体系 · 子系统 A：主数据模型 + 扩展维护（设计文档）

> **状态**：设计已批准（2026-07-10 讨论达成），待用户复审 → 转 writing-plans 出实现计划。
> **范围**：报表体系拆 4 子系统（A 主数据 / B 数据注册中心 / C 报表触发+取数 / D 目标达成率），本规格只覆盖 **A**。B/C/D 各自独立规格，后继。
> **架构约束**：本设计涉及新增主数据表、废弃 `lemeng_items`、改写采集逻辑——按 CLAUDE.md，实现前须用户同意 + 更新 `docs/architecture.md`（本规格即设计依据，架构文档更新并入实现步骤）。

---

## 1. 背景与目标

报表体系需要稳定的**商品/门店主数据**，承载三类需求：

1. **采集基础字段**（商品档案、门店信息——变动不大但要关联查询的元数据）。
2. **人工二次维护扩展字段**：如商品在不同场景下的命名映射、门店的战区/城市/区域分组——采集不覆盖。
3. **跨品牌统一视图**：两品牌（3120/64188）商品 ~60% 相同、门店分组统一，要能跨品牌汇总。

**现状问题**：`lemeng_items`（迁移 011）是**凭臆想占位**的——只采 11 个字段子集、`PK = item_num` 单列、`item_category` 存成 JSON blob。与乐檬真实数据结构严重不符，且两品牌 `item_num` 会互相覆盖。**必须废弃重建。**

---

## 2. 真实数据依据（2026-07-10 服务器实测）

设计**全部基于实测**，不以现有臆想表为准。

| 来源 | 字段 | 关键发现 |
|---|---|---|
| 商品档案 API `nhsoft.base.business.item.page.new` | **172 字段** | `item_num`（品牌内编号）、`item_code`、`bar_code`（按规格）、`system_book_code`（=品牌）、类别为**嵌套对象**（`full_category_path`/`top_category`）、部门对象、多级价、供应商、`item_tag_strs`、`scope_list`、扩展属性 |
| 销售明细 `findposorderdetail`→parquet（46 列） | 见下 | 路径 `lemeng/retail_detail/{company}/{date}/{all\|branch_num_*}.parquet`；含 `branch_num/code/name`、`item_num/code/name/category/spec`、供应商、各级价/成本/毛利；**无 bar_code、无战区** |
| 两品牌重叠 | — | 售出商品 `item_code` 公共 **1025** 个（3120 有 2214、64188 有 2597）；门店 3120=144、64188=73 |

**两个实证结论（决定整个设计）：**

1. **关联键**：明细 `item_num` = 商品档案 `item_num`（同一商品两 API 完全一致，`item_code` 亦一致）。明细按 item 级记录、不区分规格。
2. **跨品牌合并键**：`item_code`。1025 个公共 `item_code` 里两品牌 `item_name` **1025 个完全一致**，仅 8 行近乎同名漂移（如「半边红脆李-A级」vs「半边红脆李」）。→ 同 `item_code` = 同商品，跨品牌自动可靠。**无需条码**（条码明细里反而没有）。

`item_num` / `branch_num` 均为**品牌内编号**（有裸号 1/3207，也有带前缀 312005582），跨品牌必撞 → 主数据 PK 必须 `(system_book_code, *)`。

---

## 3. 设计

### 3.1 `dim_item`（商品主数据 · 采集权威）

采集写入、重采**覆盖**基础字段；扩展字段不在此表（见 3.3），杜绝误覆盖。

```sql
CREATE TABLE IF NOT EXISTS dim_item (
    system_book_code  TEXT NOT NULL,        -- 品牌（3120/64188），源自 API
    item_num          TEXT NOT NULL,        -- 商品编号（品牌内）
    item_code         TEXT,                 -- 业务编码 = 跨品牌合并键
    bar_code          TEXT,                 -- 条码（主规格）
    item_name         TEXT,
    -- 类别拆结构化（不再存 JSON blob）
    category_code     TEXT,
    category_name     TEXT,
    category_path     TEXT,                 -- full_category_path，如「生鲜->水果生鲜->菠萝凤梨类」
    top_category      TEXT,                 -- 如「SX|生鲜」
    item_brand        TEXT,
    department        TEXT,                 -- 部门名
    item_unit         TEXT,
    item_regular_price TEXT,
    item_cost_price   TEXT,
    supplier_name     TEXT,                 -- 主供应商
    item_tags         TEXT,                 -- item_tag_strs
    raw               JSONB,                -- 其余 ~150 字段备查
    updated_at        TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, item_num)
);
```
- 采集 upsert 仅写上面列出的列 + raw；**不写** ext 表的列。
- `item_code` 上建索引（合并/JOIN 用）。

### 3.2 `canonical_product`（跨品牌合并层 · 视图，自动）

**无需人工映射表**——按 `item_code` 自动聚合，60% 同码自动并、40% 各异天然分：

```sql
CREATE OR REPLACE VIEW canonical_product AS
SELECT item_code,
       MIN(item_name) AS display_name,
       MIN(category_name) AS category_name,
       MIN(top_category) AS top_category,
       COUNT(DISTINCT system_book_code) AS brand_count,
       ARRAY_AGG(DISTINCT system_book_code) AS brands
FROM dim_item
WHERE item_code IS NOT NULL
GROUP BY item_code;
```
- 报表/OpenClaw 跨品牌商品汇总 = 按 `item_code`（或此视图）GROUP BY。
- `display_name` 取 `MIN` 为 MVP；后续可换成"场景命名"（见 3.4）。

### 3.3 `dim_item_ext`（商品扩展 · 人工维护，采集永不碰）

独立表、同 PK。**分表理由**：采集全量覆盖 `dim_item` 时绝不会触碰扩展，物理隔离防误覆盖。

```sql
CREATE TABLE IF NOT EXISTS dim_item_ext (
    system_book_code TEXT NOT NULL,
    item_num         TEXT NOT NULL,
    -- 人工维护的扩展字段，按需加列（示例）
    custom_group     TEXT,                  -- 自定义分组
    note             TEXT,
    updated_at       TIMESTAMP DEFAULT NOW(),
    updated_by       TEXT,
    PRIMARY KEY (system_book_code, item_num),
    FOREIGN KEY (system_book_code, item_num) REFERENCES dim_item(system_book_code, item_num)
);
```
- 报表取数 = `dim_item JOIN dim_item_ext USING(system_book_code,item_num)`。

### 3.4 `item_scenario_names`（场景命名映射 · 人工）

挂在 **canonical（item_code）** 上（同商品跨品牌共享场景名）：

```sql
CREATE TABLE IF NOT EXISTS item_scenario_names (
    item_code    TEXT NOT NULL,
    scenario     TEXT NOT NULL,             -- 场景，如「节日礼盒」「日常」
    display_name TEXT NOT NULL,
    PRIMARY KEY (item_code, scenario)
);
```

### 3.5 `dim_branch`（门店主数据 · 单独采集 + ext 人工战区）【延后：商品档案之后单独做】

与 `dim_item` **同模式**：base 字段单独采（乐檬门店/分支 API），采集覆盖 base；战区/城市/区域人工维护、采集不覆盖。

- **PK `(system_book_code, branch_num)`** 已定（branch_num 品牌内编号，实测 3120=144 / 64188=73 店）。
- **base 列不臆想**：门店 API 真实返回结构未知（endpoint 待找，如 `nhsoft.base.business.branch.list` 类），须**先采一页看真实字段再定 base 列**（同 dim_item 流程，不以臆想建表）。
- **战区/城市/区域**：ext 列，人工维护，采集只写 base 列不覆盖。
- 层级固定三级（战区 > 城市 > 区域 > 门店）。
- **整体延后**：商品档案（dim_item）落地后，单独走"找 branch API → 看真实结构 → 建 dim_branch → 采集任务"。本轮不建 dim_branch。

---

## 4. 数据流

```
商品档案 API ──采集(覆盖 base)──► dim_item
                                   │
                                   └─视图─► canonical_product（按 item_code 自动合并）

人工维护 ───────────────────────► dim_item_ext / item_scenario_names / dim_branch(战区层)

销售明细 parquet ──distinct 定期 upsert base──► dim_branch(branch_code/name)
```

- 采集只写各自 base，**永不碰**人工 ext 列 → 字段归属清晰、无覆盖风险。

---

## 5. 如何喂报表（与 C 子系统接口）

`dim_item`(~16k) / `dim_branch`(~217) / `canonical_product` 都是小表 → 按 architecture §4.2「小表搬运」注入 DuckDB 临时表，与明细 parquet JOIN：

- 战区/城市汇总 = 明细 JOIN dim_branch（按 system_book_code+branch_num）。
- 跨品牌商品汇总 = 明细 JOIN canonical_product（按 item_code）。
- 场景命名 = 再 JOIN item_scenario_names。
- `/compute`（标准报表）与 OpenClaw（个性化）共用此搬运通道（C 子系统统一接线）。

---

## 6. 废弃

- `lemeng_items`（迁移 011）→ 数据迁入 `dim_item` 后删除（或保留只读到迁移完成）。
- 采集逻辑 `web/lib/collect-items.ts` 重写：采全字段 + 结构化类别 + brand-scoped + 只写 `dim_item`。

---

## 7. 实现任务（转 writing-plans 展开）

1. **解决 64188 center branch_id**：64188 `auth_config` 为空、无商品档案任务。解码 64188 token JWT 找线索 / 试 `branch_id` 是否品牌无关 / 调乐檬门店 API。解决后建 64188 商品档案采集任务。
2. **建表迁移**（幂等）：`dim_item` / `dim_item_ext` / `item_scenario_names` / `dim_branch` / `canonical_product` 视图 + 权限（GRANT 给 authenticated/anon 按 RLS 策略）+ RLS（如需按部门隔离，复用 §6.2）。
3. **重写 collect-items**：拉全字段 → 结构化类别（从嵌套对象取 category_code/name/path/top）→ upsert `dim_item`（base 列 + raw JSONB），brand-scoped PK。
4. **建 64188 商品档案采集任务**（collect_tasks + 调度）。
5. **dim_branch base 自动发现**：调度任务从明细 distinct upsert（仅 base 列）。
6. **数据迁移**：现有 `lemeng_items`（3120）重采入 `dim_item`；采集 64188。
7. **小表搬运接线**：DuckDB 侧建临时表装载 dim_*（与 C 子系统协调，最小可用先支撑战区/品类汇总）。
8. **管理界面**（最小）：`dim_item_ext` / `dim_branch` 战区 / `item_scenario_names` 的维护入口（可后置，先 SQL 维护）。

---

## 8. 已定 / 延后

| 项 | 决定 |
|---|---|
| 跨品牌合并键 | `item_code`（实测可靠，不用条码） |
| 合并实现 | `canonical_product` 视图自动聚合，无人工映射表 |
| 商品-规格两层 | MVP 不建独立规格表；规格入 `dim_item.raw` JSONB（明细按 item 级，够用） |
| 门店 base 来源 | 单独采集（门店/分支 API，同 dim_item 模式）；endpoint + base 列待看真实结构定，整体延后到商品档案之后 |
| 战区层级 | 固定 战区/城市/区域 三级 |
| 主数据可见性 | dim_item/dim_branch 为参考维表，authenticated 只读即可，不另设行级 RLS。**成本敏感列**（`dim_item.item_cost_price`）搬进 DuckDB 时按 §4.2 `can_see_cost` 脱敏，或搬运投影直接剔除该列 |

---

## 9. 风险与注意

- **64188 branch_id 未知**：实现任务 1 的前置，可能需要试错或问业务方。
- **采集覆盖 vs 人工维护**：必须保证采集 upsert 的列集合**严格限定**在 base 列，否则会冲掉人工 ext。迁移 SQL 和 collect 代码都要守住这条边界。
- **类别结构化**：依赖 API 嵌套对象字段稳定；若字段名漂移需在采集层做兼容映射。
- **明细 item_num 与档案 item_num 一致性**：已实测一致；后续若乐檬改 API 需复测。
- **成本列二次暴露**：`dim_item` 含 `item_cost_price`；OpenClaw 经小表搬运读 `dim_item` 时，须按 §4.2 `can_see_cost` 对该列脱敏（或搬运时即剔除），否则会绕过明细侧列脱敏。
