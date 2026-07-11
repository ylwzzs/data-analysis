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

**3. 成本列无权限 = NULL，别当 0**：成本/利润为 NULL（无权限）→如实说"成本列无权限"，**别把 NULL 当 0 算进总额**（list_datasets 里 is_sensitive=true 的列即为成本组）。

**4. 一问一查**：能一条 SQL 搞定别拆多条。总额/计数/排名/占比用 SUM/COUNT 聚合，别把明细拉回来自己算。

## 选明细还是汇总（汇总优先）

**优先命中汇总表**：问历史日的总额/排名/占比/趋势 → 用 `report_daily_sales_v` / `report_daily_category_v` / `report_weekly_trend`（类型干净、快、成本列自动脱敏）。只有下列情况才扫 `retail_detail` 明细：
- 问**今天/最近**（汇总表可能滞后约 1 天）。
- 要**单笔订单、具体商品行**等明细。
- 汇总表没有的维度。

维表（dim_item/dim_branch/dim_region）可直接查做 lookup（如"有哪些门店/战区"）。按战区/品类聚合历史 → 用汇总表 JOIN 维表；明细级 × 维度归类待 carry（C3）。

## 呈现

中文回答，关键数字带单位 + 日期。**直接给结果**，不要"查询成功/我来查一下"等铺垫。truncated 时改用聚合/加 LIMIT 重查，或说明"共 N 条，此处列前 50"。
