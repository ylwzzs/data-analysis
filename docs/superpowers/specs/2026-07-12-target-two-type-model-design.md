# 目标两类模型重构 设计 spec

> 日期：2026-07-12 ｜ 子系统：报表体系 D（目标与达成）—— 目标创建/管理
> 上游：架构文档 §10.8（本次新增）。达成（actual）留 Phase 2 报表中心。
> brainstorming 产物，下一步转 writing-plans。

## 一、背景

现状目标层是**纯门店维度**：`targets` 只有 branch_num（'ALL'=总目标），分解到门店。前端却暴露未定义的 `wholesale`（FK 隐患）。业务要两类目标：
- **总部目标**：看出库（配送+批发）的金额/毛利，按品类（水果/标品·耗材）分，**不拆门店**
- **门店目标**：销售 + 配送，分解到门店（现状）

底层数据齐（`delivery_detail`/`wholesale_detail`/`retail_detail`），但目标模型缺品类轴 + 新指标。

## 二、口径（已确认）

| 指标 | 口径 | 数据源 |
|---|---|---|
| 出库金额 | 配送金额 + 批发销售金额 | `delivery_detail.out_money` + `wholesale_detail.wholesale_money` |
| 出库毛利 | 配送毛利 + 批发毛利 | `delivery_detail.profit_money` + `wholesale_detail.wholesale_profit` |
| 门店配送 | 该店调入额 | `delivery_detail.out_money` by `response_branch_num` |
| 门店销售 | POS 销售额 | `report_daily_sales.total_sale`（现状 sale） |

**品类分组**（映射 `category_l1`）：水果=生鲜；标品·耗材=标品+包装耗材+运费/仓储用耗材+广西柳州；废弃档案排除。

## 三、范围

**做**（创建/管理）：
1. 模型：targets 加 `target_type`+`category`；metric_definitions 加 3 指标；修 UNIQUE；report_achievement_v 加 2 列
2. RPC：`upsert_target_total` 加 target_type；新增 `upsert_hq_category_breakdown`+`get_hq_category_breakdown`
3. UI：目标列表分两类；新建总部目标（2×2 品类×指标 + 自动汇总）；门店目标加配送指标

**不做**（Phase 2）：
- 新指标达成 actual（hq 出库/毛利/品类聚合；门店配送聚合）—— 模型已预留，Phase 2 接 report_achievement_v LATERAL
- close_target 扩展（关单固化新指标 actual）

## 四、数据模型（迁移 `057_target_two_type.sql`，幂等）

### 4.1 targets 加列 + UNIQUE 改造
```sql
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'store';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS category TEXT;
-- 旧 UNIQUE 命名 <table>_<cols>_key，DO 块判断后 DROP + ADD
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_system_book_code_branch_num_start_date_end_date_key') THEN
    ALTER TABLE targets DROP CONSTRAINT targets_system_book_code_branch_num_start_date_end_date_key;
  END IF;
  ALTER TABLE targets ADD CONSTRAINT targets_type_branch_cat_key
    UNIQUE (system_book_code, target_type, branch_num, category, start_date, end_date);
END $$;
```
> NULL category：Postgres 默认 NULL≠NULL 不冲突；hq 总目标(store 也)category=NULL 靠 target_type 区分。

### 4.2 metric_definitions 加 3 行（data_ready=false，达成 Phase2）
```sql
INSERT INTO metric_definitions (metric_code, name, source_dataset, value_column, unit, data_ready, enabled, description) VALUES
  ('outbound_amt', '出库金额', NULL, NULL, '元', false, true,
   '配送金额+批发销售金额(delivery_detail.out_money + wholesale_detail.wholesale_money)'),
  ('outbound_profit', '出库毛利', NULL, NULL, '元', false, true,
   '配送毛利+批发毛利(delivery_detail.profit_money + wholesale_detail.wholesale_profit)'),
  ('delivery', '配送', NULL, NULL, '元', false, true,
   '门店调入额(delivery_detail.out_money by response_branch_num)')
ON CONFLICT (metric_code) DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, enabled=EXCLUDED.enabled, description=EXCLUDED.description;
```
> 不删 `purchase`（无害，UI 不再暴露）。`wholesale` 不加定义行，UI 移除引用（消除 FK 隐患）。

### 4.3 report_achievement_v 加 2 列（DROP+CREATE）
SELECT 加 `t.target_type, t.category`，其余逻辑不变（非 sale 指标 data_ready=false 自动 not_ready）。

### 4.4 RPC
- `upsert_target_total` 加参数 `p_target_type TEXT DEFAULT 'store'`；INSERT/UPDATE 写入 target_type
- 新增 `upsert_hq_category_breakdown(p_parent_id BIGINT, p_rows JSONB, p_by TEXT)`：rows=[{category,metrics:{code:val}}]，按 (parent, category) find/create 子 target，upsert metrics
- 新增 `get_hq_category_breakdown(p_parent_id BIGINT)`：返 [{category, metrics:{code:val}}]，按 category 排序
- `check_breakdown_balance`：**不改**（按 parent 汇总，两类通用）
- `get_breakdown`（门店轴）：**不改**
- GRANT 新 RPC 给 authenticated/anon

## 五、API（直连 postgrest:3000）

- `POST /api/admin/targets`：body 加 `target_type` → `upsert_target_total`
- `GET/POST /api/admin/targets/breakdown`：按 parent 的 target_type 分派
  - store → 现状（get_breakdown + upsert_target_breakdown）
  - hq → get_hq_category_breakdown + upsert_hq_category_breakdown
- 路由内查 parent.target_type 决定走哪个 RPC

## 六、UI

### 6.1 列表 `/admin/targets`（page.tsx）
- 按 target_type 分两区（总部目标 / 门店目标）或加类型筛选
- 列加「类型」「品类」(hq 显示水果/标品)；hq 行 branch_num=ALL 不显示门店
- 新建按钮 → 选类型（或两个按钮）

### 6.2 新建总部目标（HQ form）
- 名称 + 周期
- **2×2 输入**：行=品类（水果/标品耗材，固定 2 行），列=指标（出库金额/出库毛利）
- 汇总行自动算（每指标：水果+标品=总）
- 保存：建 hq 总目标(target_type='hq') + 品类分解(upsert_hq_category_breakdown)，带 balance 校验（子和=总，差额确认）

### 6.3 新建门店目标（Store form，沿用现状）
- 现状 Modal 明细表式（指标=行），指标列表改 `[sale(销售), delivery(配送)]`（移除 wholesale/purchase）
- 分解页 `/admin/targets/[id]`：现状门店批量编辑/上传不变；新增 delivery 列自动带出（grid 按 metrics keys 渲染）

## 七、文件结构

**新建**：
- `database/migrations/057_target_two_type.sql` — 模型+指标+视图+RPC

**改造**：
- `web/app/admin/targets/page.tsx` — 列表分两类 + HQ form + Store form 指标列表
- `web/app/admin/targets/[id]/page.tsx` — 按 parent 类型分派（hq 品类 grid / store 门店 grid）
- `web/app/api/admin/targets/route.ts` — POST 加 target_type
- `web/app/api/admin/targets/breakdown/route.ts` — 按 parent 类型分派 hq/store RPC
- `web/app/api/admin/targets/template/route.ts` — 模板指标列表去 wholesale（hq 模板另议，可后置）

## 八、部署

改 migration + web/ → **GHA 完整部署** + restart postgrest（057 视图/RPC 刷 schema 缓存）。

## 九、成功标准

- 总部目标：建一个（如 7月），填出库金额(水果60/标品40=100)+出库毛利，存为 hq 总目标+2 品类分解；balance 校验子和=总
- 门店目标：建一个，指标=销售+配送，分解到门店（现状不变 + 新增配送列）
- 列表分两类显示，hq 行展示品类
- 零破坏：现有 sale 目标 + report_achievement_v sale 达成不受影响（target_type 默认 'store' 兼容旧数据）
- 迁移幂等（ADD COLUMN IF NOT EXISTS / DROP+CREATE VIEW / CREATE OR REPLACE FUNCTION / DO 块判断 UNIQUE）

## 十、Phase 2 预留（本次不做）

- report_achievement_v LATERAL 加 outbound_amt/outbound_profit/delivery 的 actual 计算（delivery+wholesale 聚合，按品类/门店）
- 品类映射：明细 JOIN dim_item 取 category_l1 → 归水果/标品耗材组（需确定明细品类字段与 category_l1 对齐策略）
- close_target 扩展固化新指标
- hq 达成看板（报表中心）
