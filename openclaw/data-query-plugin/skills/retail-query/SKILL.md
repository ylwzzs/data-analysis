---
name: retail-query
description: 零售销售数据查询。用户问销售额/销量/订单/商品/门店/品类/利润/趋势等业务数据时激活，用 query_retail_data 工具查明细视图 retail_detail 或汇总表。
metadata:
  openclaw:
    emoji: "📊"
---

# 零售数据查询 Skill

用户问**零售销售数据**（销售额、销量、订单数、商品排行、门店对比、品类占比、利润、环比趋势等）时使用。

## 工具：query_retail_data

```
query_retail_data({ sql: "<单条 SELECT>" })
```

- 自动携带可信企微身份，按权限过滤门店、脱敏成本列 —— **不要**在 SQL 里写权限条件。
- 只允许 SELECT；禁 `read_parquet / INSERT / UPDATE / DELETE / DROP / COPY / PRAGMA`。无 LIMIT 时网关自动补 LIMIT 1000。
- 结果超 50 行时只回传前 50 行 + `truncated:true`（见"呈现"）。

## 四条原则

**0. 绝不编造数据（最高铁律）**
- 数据**只能**来自 `query_retail_data` 工具的返回。**工具没被调用、返回 error、返回空、或你拿不准时，必须如实告诉用户**（"我没能查到 / 当前无权限 / 该日无数据"），**绝对禁止**自己编造任何门店名、数字、排名、金额。
- 编出来的"像真的"的结果比查不到恶劣一百倍——用户会拿假数字做经营决策。宁可说"查不到"，**绝不**瞎编。
- 即使用户追问、即使你"觉得"该有数据，只要工具没返回，就是没有。

**1. 忠于用户原话，不要替用户拍板**
- **数量**：用户说"前 N / Top N"→SQL 加 `LIMIT N`；说"排名 / 所有 / 全部"→不写 LIMIT（让网关兜底），呈现时**如实告知总数和是否截断**。绝不自定一个固定行数。
- **范围**：用户点名某店/品类 → `LIKE '%关键字%'`；没点名 → 全量（门店权限会自动过滤）。

**2. 日期忠于原话 + 必须显式标注**
- **"今天 / 最近 / 最新"用一条 SQL 搞定**：`WHERE 日期列 = (SELECT MAX(日期列) FROM 表)`，并在 SELECT 里带出 `(SELECT MAX(日期列) FROM 表) AS data_date`。一次拿到数据 + 实际日期。若 `data_date` = 今天 → 说"今天的数据"；否则 → 说"今天（X 日）暂无数据，以下为最新 `data_date` 的数据"。今天有数据时 MAX 自然 = 今天，没有时 MAX = 最近一日，始终诚实，**且只查一次**。
  - 明细日期列 `order_detail_bizday`（YYYYMMDD 字符串）；汇总日期列 `biz_date`（DATE）。
- "昨天 / 具体日期"→ 直接该日期，不必用 MAX。
- "今天"按当前**北京时间**日期（容器时区 Asia/Shanghai）。
- **回答里始终写明数据属于哪一天**；**绝不**拿旧日数据冒充今天。

**3. 错误如实转述，不要编**
- 工具返回 `error` 时按原文告诉用户：`no_permission`=你无查询权限；`forbidden_statement:X`=SQL 含禁用词 X；`only_select_allowed`=只允许 SELECT；网关不可达=网络问题。**不要自己臆测原因**。

**4. 一问一查**
- 能一条 SQL 搞定的不要拆成多条。要总额/计数/排名/占比 → 用 `SUM/COUNT` 聚合，不要把明细拉回来自己算。

## 数据字典

### retail_detail（DuckDB 明细视图，列全为字符串）

乐檬 POS 订单明细。做数学运算前要转型 `CAST(x AS DOUBLE)`（或 `x::DOUBLE`）。

| 用途 | 列 |
|---|---|
| 订单 | order_no、order_detail_num、order_time(YYYY-MM-DD HH:MM:SS)、order_detail_bizday(YYYYMMDD)、order_sale_channel、order_sale_type、state |
| 门店 | branch_num、branch_code、branch_name |
| 商品 | item_num、item_code、item_name、item_category、item_spec、item_unit、department、item_regular_price |
| 供应商 | supplier_num、supplier_name、supplier_code |
| 金额 | sale_money、discount_money、payment_receipt_money、order_detail_price、total_amount、tax_money |
| 折扣率 | discount_rate、overall_discount_rate |
| 经营 | management_style_type、order_payee、order_sold_by |
| **成本组（无权限 = NULL，别当 0）** | item_cost_price、order_detail_cost、order_detail_grade_cost、cost、profit、sale_profit_rate |

按日过滤用 `order_detail_bizday`（YYYYMMDD 字符串）：`WHERE order_detail_bizday = '20260705'`。

### 汇总表（PG，列已是数值/DATE，直接算，**无需 CAST**）

- **report_daily_sales**：biz_date(DATE)、branch_num、branch_name、total_orders、total_items、total_sale、total_profit
- **report_daily_category**：biz_date(DATE)、branch_num、category、total_items、total_sale、total_profit
- **report_weekly_trend**：week_start(DATE)、branch_num、branch_name、total_sale、prev_week_sale、growth_rate

日期过滤用 DATE：`WHERE biz_date = DATE '2026-07-05'`。

### 选明细还是汇总
- **retail_detail 是实时源**（增量采集，当天就有）；**汇总表有延迟**（按批聚合，可能滞后 1 天）。
- 问**今天/最近**的数据 → 优先 `retail_detail`（最新）。若发现汇总表 `MAX(biz_date)` 早于用户要的日期，**别**误报"无数据"，改查 `retail_detail`。
- 问**历史**日的总额、排名、占比、趋势 → 用汇总表（类型干净、快）。
- 要单笔订单、具体商品行、汇总表没有的维度 → 用 retail_detail。
- 两侧**不能 join**（不同引擎）。

## 呈现

- 中文回答，关键数字带单位 + **日期**。
- **直接给结果，不要写推理过程。**禁止出现"数据查询成功了"、"拿到了...数据"、"我来查一下"等铺垫句。用户只看结果，不需要知道你调了什么工具、查了什么数据。如果必须解释，用最简短的括号注释（如"（无成本权限）"）。
- `truncated:true`（结果超 50 行）时：改用聚合或加 LIMIT 重查，或在回答里说明"共 N 条，此处列前 50"。不要假装拿到了全部。
- 成本/利润为 NULL（无权限）→ 如实说"成本列无权限"，**别把 NULL 当 0 算进总额**。
