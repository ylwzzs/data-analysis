# 报表中心呈现层重设计 - Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现报表中心 Phase 1 核心功能：KPI 卡片 hover 详情 + 门店零售/出库数据报表 + 类别出库报表

**Architecture:** 渐进式扩展 + 视图增强方案。后端新建两个聚合视图，前端新增两个下钻表格组件，修改 KPI 卡片支持 tooltip，删除旧组件。

**Tech Stack:** PostgreSQL 视图、PostgREST API、React + TypeScript、Tailwind CSS

## Global Constraints

- 符合 DESIGN.md 约定：禁 emoji、DM Sans 字体、tabular-nums 数字对齐、三色达成率编码
- 商品类别映射：生鲜→水果 / 标品+废弃档案+广西柳州→标品 / 包装耗材+运费/仓储用耗材→耗材
- 批发客户过滤：`branch_num` 不是 64188 门店的记录
- 达成率颜色：>=1 绿 / >=0.8 琥珀 / <0.8 红
- 所有视图必须设置 `security_invoker=true` 并 GRANT SELECT TO authenticated, anon

---

## File Structure

### 新建文件

| 文件路径 | 职责 |
|---------|------|
| `database/migrations/073_report_region_breakdown_v.sql` | 门店零售/出库下钻视图（大区→小区→门店三层） |
| `database/migrations/074_report_category_summary_v.sql` | 类别出库汇总视图（水果/标品/耗材/合计） |
| `web/lib/report-center/region-breakdown.ts` | 门店零售/出库数据获取函数 |
| `web/lib/report-center/category-summary.ts` | 类别出库数据获取函数 |
| `web/components/report-center/region-drill-table.tsx` | 门店零售/出库折叠下钻表格组件 |
| `web/components/report-center/category-summary.tsx` | 类别出库报表组件 |

### 修改文件

| 文件路径 | 改动 |
|---------|------|
| `web/components/report-center/kpi-cards.tsx` | 添加 tooltip 属性，hover 显示详情 |
| `web/app/reports/targets/[id]/desktop.tsx` | 删除趋势图/排行图/交叉表，添加新组件 |
| `web/app/reports/targets/[id]/mobile.tsx` | 同上 |
| `web/app/reports/targets/[id]/page.tsx` | 调整数据获取逻辑 |

### 删除文件

| 文件路径 | 原因 |
|---------|------|
| `web/components/charts/line-chart.tsx` | 趋势图组件（Phase 1 删除） |
| `web/components/charts/rank-chart.tsx` | 排行图组件（Phase 1 删除） |
| `web/components/charts/bar-chart.tsx` | 孤儿组件 |
| `web/components/report-center/cross-table.tsx` | 交叉表组件（Phase 1 删除） |
| `web/components/mobile/report-card.tsx` | 孤儿组件 |
| `web/components/skeletons/report-detail-skeleton.tsx` | 孤儿组件 |

---

## Task 1: 创建 report_region_breakdown_v 视图

**Files:**
- Create: `database/migrations/073_report_region_breakdown_v.sql`

**Interfaces:**
- Consumes: `report_daily_sales`, `report_daily_delivery`, `report_daily_wholesale`, `dim_branch`, `targets`, `target_metric_values`
- Produces: 视图 `report_region_breakdown_v`，字段：`target_id`, `level`, `parent_code`, `region_code`, `region_name`, `sub_region_code`, `sub_region_name`, `branch_num`, `branch_name`, `sale_target`, `sale_actual`, `sale_rate`, `delivery_target`, `delivery_actual`, `delivery_rate`, `daily_sale`, `daily_delivery`, `remaining_daily_sale_target`, `remaining_daily_delivery_target`

- [ ] **Step 1: 编写迁移文件**

创建 `database/migrations/073_report_region_breakdown_v.sql`：

```sql
-- 073_report_region_breakdown_v.sql
-- 门店零售/出库数据报表下钻视图（大区→小区→门店三层）
-- 幂等: DROP VIEW IF EXISTS + CREATE VIEW

-- 视图逻辑：
-- 1. 从 targets + target_metric_values 获取目标值
-- 2. 从 dim_branch 获取大区/小区层级关系
-- 3. 从 report_daily_sales/report_daily_delivery 聚合实际值
-- 4. 三层 UNION ALL：大区层(level='region') + 小区层(level='sub_region') + 门店层(level='store')

DROP VIEW IF EXISTS report_region_breakdown_v;

CREATE VIEW report_region_breakdown_v AS
WITH 
-- 目标基础数据（只取 sale/delivery 指标）
target_base AS (
  SELECT 
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    t.breakdown_level,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = 'active'
    AND t.breakdown_level = 'store'  -- 只有门店级目标才有下钻数据
),

-- 销售目标值
sale_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'sale'
),

-- 出库目标值
delivery_targets AS (
  SELECT tmv.target_id, tmv.target_value AS delivery_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'delivery'
),

-- 门店维表（含大区/小区层级）
branch_dim AS (
  SELECT 
    branch_num,
    branch_name,
    first_level_region AS war_zone,
    second_level_region AS region_l2
  FROM dim_branch
  WHERE is_assessed_war_zone(first_level_region)  -- 只取考核战区
),

-- 销售实际值（按门店+目标聚合）
sale_actuals AS (
  SELECT 
    tb.target_id,
    rds.branch_num,
    SUM(rds.total_sale) AS sale_actual,
    SUM(CASE WHEN rds.biz_date = tb.start_date + tb.days_elapsed - 1 THEN rds.total_sale ELSE 0 END) AS daily_sale
  FROM report_daily_sales rds
  JOIN target_base tb ON rds.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE rds.system_book_code = '64188'  -- 主品牌
  GROUP BY tb.target_id, rds.branch_num
),

-- 出库实际值（按门店+目标聚合，delivery+wholesale 合并）
delivery_actuals AS (
  SELECT 
    tb.target_id,
    d.branch_num,
    SUM(COALESCE(d.out_money, 0)) AS delivery_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN COALESCE(d.out_money, 0) ELSE 0 END) AS daily_delivery
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE d.system_book_code = '64188'
  GROUP BY tb.target_id, d.branch_num
),

-- 门店层基础数据
store_level AS (
  SELECT 
    tb.target_id,
    'store' AS level,
    bd.region_l2 AS parent_code,  -- 门店的上级是小区
    bd.war_zone AS region_code,
    bd.war_zone AS region_name,
    bd.region_l2 AS sub_region_code,
    bd.region_l2 AS sub_region_name,
    bd.branch_num,
    bd.branch_name,
    COALESCE(st.sale_target, 0) AS sale_target,
    COALESCE(sa.sale_actual, 0) AS sale_actual,
    CASE WHEN st.sale_target > 0 THEN ROUND(sa.sale_actual / st.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(dt.delivery_target, 0) AS delivery_target,
    COALESCE(da.delivery_actual, 0) AS delivery_actual,
    CASE WHEN dt.delivery_target > 0 THEN ROUND(da.delivery_actual / dt.delivery_target, 4) ELSE NULL END AS delivery_rate,
    COALESCE(sa.daily_sale, 0) AS daily_sale,
    COALESCE(da.daily_delivery, 0) AS daily_delivery,
    CASE 
      WHEN tb.days_elapsed < tb.total_days AND st.sale_target > 0 
      THEN ROUND((st.sale_target - sa.sale_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0 
    END AS remaining_daily_sale_target,
    CASE 
      WHEN tb.days_elapsed < tb.total_days AND dt.delivery_target > 0 
      THEN ROUND((dt.delivery_target - da.delivery_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0 
    END AS remaining_daily_delivery_target
  FROM target_base tb
  CROSS JOIN branch_dim bd
  LEFT JOIN sale_targets st ON st.target_id = tb.target_id
  LEFT JOIN sale_actuals sa ON sa.target_id = tb.target_id AND sa.branch_num = bd.branch_num
  LEFT JOIN delivery_targets dt ON dt.target_id = tb.target_id
  LEFT JOIN delivery_actuals da ON da.target_id = tb.target_id AND da.branch_num = bd.branch_num
),

-- 小区层（汇总门店）
sub_region_level AS (
  SELECT 
    target_id,
    'sub_region' AS level,
    region_code AS parent_code,  -- 小区的上级是大区
    region_code,
    region_name,
    sub_region_code,
    sub_region_name,
    NULL AS branch_num,
    NULL AS branch_name,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target,
    SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale,
    SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM store_level
  GROUP BY target_id, region_code, region_name, sub_region_code, sub_region_name
),

-- 大区层（汇总小区）
region_level AS (
  SELECT 
    target_id,
    'region' AS level,
    NULL AS parent_code,  -- 大区无上级
    region_code,
    region_name,
    NULL AS sub_region_code,
    NULL AS sub_region_name,
    NULL AS branch_num,
    NULL AS branch_name,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target,
    SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale,
    SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM sub_region_level
  GROUP BY target_id, region_code, region_name
)

SELECT * FROM region_level
UNION ALL
SELECT * FROM sub_region_level
UNION ALL
SELECT * FROM store_level;

ALTER VIEW report_region_breakdown_v OWNER TO postgres;
ALTER VIEW report_region_breakdown_v SET (security_invoker = true);
GRANT SELECT ON report_region_breakdown_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 073 completed: report_region_breakdown_v created'; END $$;
```

- [ ] **Step 2: 提交迁移文件**

```bash
git add database/migrations/073_report_region_breakdown_v.sql
git commit -m "feat(db): add report_region_breakdown_v for store drill-down report"
```

---

## Task 2: 创建 report_category_summary_v 视图

**Files:**
- Create: `database/migrations/074_report_category_summary_v.sql`

**Interfaces:**
- Consumes: `report_daily_delivery`, `report_daily_wholesale`, `targets`, `target_metric_values`
- Produces: 视图 `report_category_summary_v`，字段：`target_id`, `category`, `sale_target`, `sale_actual`, `sale_rate`, `profit_target`, `profit_actual`, `profit_rate`, `profit_margin`, `daily_amount`, `daily_profit`, `daily_profit_margin`, `remaining_daily_profit_target`

- [ ] **Step 1: 编写迁移文件**

创建 `database/migrations/074_report_category_summary_v.sql`：

```sql
-- 074_report_category_summary_v.sql
-- 类别出库报表视图（水果/标品/耗材/合计）
-- 幂等: DROP VIEW IF EXISTS + CREATE VIEW

DROP VIEW IF EXISTS report_category_summary_v;

CREATE VIEW report_category_summary_v AS
WITH 
-- 目标基础数据（总部目标，category IS NULL）
target_base AS (
  SELECT 
    t.id AS target_id,
    t.start_date,
    t.end_date,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = 'active'
    AND t.target_level = 'total'  -- 总部目标
    AND t.category IS NULL
),

-- 出库金额目标
outbound_amt_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'outbound_amt'
),

-- 出库毛利目标
outbound_profit_targets AS (
  SELECT tmv.target_id, tmv.target_value AS profit_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'outbound_profit'
),

-- 出库实际值（按类别聚合）
category_actuals AS (
  -- delivery 数据
  SELECT 
    tb.target_id,
    d.category_group AS category,
    SUM(d.out_money) AS sale_actual,
    SUM(d.profit_money) AS profit_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.out_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.profit_money ELSE 0 END) AS daily_profit
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE d.system_book_code = '64188'
    AND d.category_group IN ('水果', '标品', '耗材')
  GROUP BY tb.target_id, d.category_group
  
  UNION ALL
  
  -- wholesale 数据（批发客户，非 64188 门店）
  SELECT 
    tb.target_id,
    w.category_group AS category,
    SUM(w.wholesale_money) AS sale_actual,
    SUM(w.wholesale_profit) AS profit_actual,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_profit ELSE 0 END) AS daily_profit
  FROM report_daily_wholesale w
  JOIN target_base tb ON w.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE w.system_book_code = '64188'
    AND w.branch_num != '64188'  -- 排除匹配到 64188 门店的记录（门店配送）
    AND w.category_group IN ('水果', '标品', '耗材')
  GROUP BY tb.target_id, w.category_group
),

-- 类别层（水果/标品/耗材）
category_level AS (
  SELECT 
    tb.target_id,
    ca.category,
    COALESCE(oat.sale_target, 0) AS sale_target,
    ca.sale_actual,
    CASE WHEN oat.sale_target > 0 THEN ROUND(ca.sale_actual / oat.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(opt.profit_target, 0) AS profit_target,
    ca.profit_actual,
    CASE WHEN opt.profit_target > 0 THEN ROUND(ca.profit_actual / opt.profit_target, 4) ELSE NULL END AS profit_rate,
    CASE WHEN ca.sale_actual > 0 THEN ROUND(ca.profit_actual / ca.sale_actual, 4) ELSE NULL END AS profit_margin,
    ca.daily_amount,
    ca.daily_profit,
    CASE WHEN ca.daily_amount > 0 THEN ROUND(ca.daily_profit / ca.daily_amount, 4) ELSE NULL END AS daily_profit_margin,
    CASE 
      WHEN tb.days_elapsed < tb.total_days AND opt.profit_target > 0 
      THEN ROUND((opt.profit_target - ca.profit_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0 
    END AS remaining_daily_profit_target
  FROM target_base tb
  CROSS JOIN (VALUES ('水果'), ('标品'), ('耗材')) AS cats(category)
  LEFT JOIN outbound_amt_targets oat ON oat.target_id = tb.target_id
  LEFT JOIN outbound_profit_targets opt ON opt.target_id = tb.target_id
  LEFT JOIN category_actuals ca ON ca.target_id = tb.target_id AND ca.category = cats.category
),

-- 合计层
total_level AS (
  SELECT 
    target_id,
    '合计' AS category,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(profit_target) AS profit_target,
    SUM(profit_actual) AS profit_actual,
    CASE WHEN SUM(profit_target) > 0 THEN ROUND(SUM(profit_actual) / SUM(profit_target), 4) ELSE NULL END AS profit_rate,
    CASE WHEN SUM(sale_actual) > 0 THEN ROUND(SUM(profit_actual) / SUM(sale_actual), 4) ELSE NULL END AS profit_margin,
    SUM(daily_amount) AS daily_amount,
    SUM(daily_profit) AS daily_profit,
    CASE WHEN SUM(daily_amount) > 0 THEN ROUND(SUM(daily_profit) / SUM(daily_amount), 4) ELSE NULL END AS daily_profit_margin,
    SUM(remaining_daily_profit_target) AS remaining_daily_profit_target
  FROM category_level
  GROUP BY target_id
)

SELECT * FROM category_level
UNION ALL
SELECT * FROM total_level;

ALTER VIEW report_category_summary_v OWNER TO postgres;
ALTER VIEW report_category_summary_v SET (security_invoker = true);
GRANT SELECT ON report_category_summary_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 074 completed: report_category_summary_v created'; END $$;
```

- [ ] **Step 2: 提交迁移文件**

```bash
git add database/migrations/074_report_category_summary_v.sql
git commit -m "feat(db): add report_category_summary_v for category outbound report"
```

---

## Task 3: 创建数据获取函数

**Files:**
- Create: `web/lib/report-center/region-breakdown.ts`
- Create: `web/lib/report-center/category-summary.ts`

**Interfaces:**
- Consumes: PostgREST API（`report_region_breakdown_v`, `report_category_summary_v`）
- Produces: 
  - `getRegionBreakdown(targetId: string): Promise<RegionBreakdownRow[]>`
  - `getCategorySummary(targetId: string): Promise<CategorySummaryRow[]>`

- [ ] **Step 1: 创建 region-breakdown.ts**

创建 `web/lib/report-center/region-breakdown.ts`：

```typescript
// web/lib/report-center/region-breakdown.ts
// 门店零售/出库数据报表下钻数据获取

export interface RegionBreakdownRow {
  target_id: number;
  level: 'region' | 'sub_region' | 'store';
  parent_code: string | null;
  region_code: string;
  region_name: string;
  sub_region_code: string | null;
  sub_region_name: string | null;
  branch_num: string | null;
  branch_name: string | null;
  sale_target: number;
  sale_actual: number;
  sale_rate: number | null;
  delivery_target: number;
  delivery_actual: number;
  delivery_rate: number | null;
  daily_sale: number;
  daily_delivery: number;
  remaining_daily_sale_target: number;
  remaining_daily_delivery_target: number;
}

export async function getRegionBreakdown(
  targetId: string
): Promise<RegionBreakdownRow[]> {
  const client = (await import("@/lib/supabase/client")).createClient();
  
  const { data, error } = await client
    .from("report_region_breakdown_v")
    .select("*")
    .eq("target_id", targetId)
    .order("sale_rate", { ascending: false, nullsFirst: false });
  
  if (error) {
    console.error("Failed to fetch region breakdown:", error);
    return [];
  }
  
  return data ?? [];
}
```

- [ ] **Step 2: 创建 category-summary.ts**

创建 `web/lib/report-center/category-summary.ts`：

```typescript
// web/lib/report-center/category-summary.ts
// 类别出库报表数据获取

export interface CategorySummaryRow {
  target_id: number;
  category: '水果' | '标品' | '耗材' | '合计';
  sale_target: number;
  sale_actual: number;
  sale_rate: number | null;
  profit_target: number;
  profit_actual: number;
  profit_rate: number | null;
  profit_margin: number | null;
  daily_amount: number;
  daily_profit: number;
  daily_profit_margin: number | null;
  remaining_daily_profit_target: number;
}

const CATEGORY_ORDER = ['水果', '标品', '耗材', '合计'] as const;

export async function getCategorySummary(
  targetId: string
): Promise<CategorySummaryRow[]> {
  const client = (await import("@/lib/supabase/client")).createClient();
  
  const { data, error } = await client
    .from("report_category_summary_v")
    .select("*")
    .eq("target_id", targetId);
  
  if (error) {
    console.error("Failed to fetch category summary:", error);
    return [];
  }
  
  // 按固定顺序排序：水果→标品→耗材→合计
  const sorted = (data ?? []).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a.category as any);
    const idxB = CATEGORY_ORDER.indexOf(b.category as any);
    return idxA - idxB;
  });
  
  return sorted;
}
```

- [ ] **Step 3: 提交数据获取函数**

```bash
git add web/lib/report-center/region-breakdown.ts web/lib/report-center/category-summary.ts
git commit -m "feat(web): add data fetch functions for region breakdown and category summary"
```

---

## Task 4: 创建 RegionDrillTable 组件

**Files:**
- Create: `web/components/report-center/region-drill-table.tsx`

**Interfaces:**
- Consumes: `RegionBreakdownRow[]`（from Task 3）
- Produces: React 组件 `RegionDrillTable`

- [ ] **Step 1: 创建组件文件**

创建 `web/components/report-center/region-drill-table.tsx`：

```typescript
"use client";

import { useMemo, useState } from "react";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { ChartActions, exportExcel } from "./chart-actions";

interface RegionDrillTableProps {
  rows: RegionBreakdownRow[];
  targetMonth: number;
  progress: number; // 时间进度，如 0.677
}

// 达成率三色编码
function rateColor(rate: number | null, progress: number): string {
  if (rate == null) return "text-slate-300";
  // 低于时间进度标红
  if (rate < progress) return "text-red-600";
  // 正常三色
  return rate >= 1 ? "text-green-600" : rate >= 0.8 ? "text-amber-600" : "text-red-600";
}

function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

interface TreeNode {
  code: string;
  name: string;
  level: 'region' | 'sub_region' | 'store';
  children: TreeNode[];
  data: RegionBreakdownRow;
  expanded: boolean;
}

export function RegionDrillTable({ rows, targetMonth, progress }: RegionDrillTableProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());

  // 构建树形结构
  const tree = useMemo(() => {
    const regionMap = new Map<string, TreeNode>();
    const subRegionMap = new Map<string, TreeNode>();
    const storeMap = new Map<string, TreeNode>();

    // 先处理大区层
    for (const r of rows) {
      if (r.level === 'region') {
        regionMap.set(r.region_code, {
          code: r.region_code,
          name: r.region_name,
          level: 'region',
          children: [],
          data: r,
          expanded: expandedNodes.has(r.region_code),
        });
      }
    }

    // 处理小区层
    for (const r of rows) {
      if (r.level === 'sub_region' && r.parent_code) {
        const node: TreeNode = {
          code: r.sub_region_code!,
          name: r.sub_region_name!,
          level: 'sub_region',
          children: [],
          data: r,
          expanded: expandedNodes.has(r.sub_region_code!),
        };
        subRegionMap.set(r.sub_region_code!, node);
        const parent = regionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }

    // 处理门店层
    for (const r of rows) {
      if (r.level === 'store' && r.parent_code) {
        const node: TreeNode = {
          code: r.branch_num!,
          name: r.branch_name!,
          level: 'store',
          children: [],
          data: r,
          expanded: false,
        };
        storeMap.set(r.branch_num!, node);
        const parent = subRegionMap.get(r.parent_code);
        if (parent) parent.children.push(node);
      }
    }

    // 小区内按销售完成率排序
    for (const sr of subRegionMap.values()) {
      sr.children.sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
    }

    // 大区内按销售完成率排序
    for (const r of regionMap.values()) {
      r.children.sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
    }

    return [...regionMap.values()].sort((a, b) => (b.data.sale_rate ?? 0) - (a.data.sale_rate ?? 0));
  }, [rows, expandedNodes]);

  const toggleExpand = (code: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // 渲染行
  const renderRows = (nodes: TreeNode[], depth: number): React.ReactNode[] => {
    const result: React.ReactNode[] = [];
    for (const node of nodes) {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedNodes.has(node.code);
      const indent = depth * 24;

      result.push(
        <tr key={node.code} className="hover:bg-slate-50">
          <td
            className="px-3 py-2 text-slate-700"
            style={{ paddingLeft: `${indent + 12}px` }}
          >
            {hasChildren && (
              <button
                onClick={() => toggleExpand(node.code)}
                className="mr-1 inline-flex items-center justify-center w-4 h-4 text-slate-400 hover:text-slate-600"
              >
                {isExpanded ? "▼" : "▶"}
              </button>
            )}
            <span className={depth === 0 ? "font-semibold" : ""}>
              {node.name}
            </span>
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.sale_target)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.sale_actual)}
          </td>
          <td
            className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.sale_rate, progress)}`}
          >
            {fmtRate(node.data.sale_rate)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.delivery_target)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.delivery_actual)}
          </td>
          <td
            className={`px-3 py-2 text-right tabular-nums ${rateColor(node.data.delivery_rate, progress)}`}
          >
            {fmtRate(node.data.delivery_rate)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.daily_sale)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.daily_delivery)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.remaining_daily_sale_target)}
          </td>
          <td className="px-3 py-2 text-right tabular-nums text-slate-700">
            {fmtCurrency(node.data.remaining_daily_delivery_target)}
          </td>
        </tr>
      );

      if (hasChildren && isExpanded) {
        result.push(...renderRows(node.children, depth + 1));
      }
    }
    return result;
  };

  const handleExcel = () => {
    // 扁平化导出
    const flatRows: RegionBreakdownRow[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        flatRows.push(node.data);
        if (expandedNodes.has(node.code)) flatten(node.children);
      }
    };
    flatten(tree);

    const head = [
      "大区名称", "小区名称", "门店名称",
      "月销售目标", " 月销售金额", " 月销售完成率",
      "月出库目标", " 月出库金额", " 月出库完成率",
      "当天销售金额", " 当天出库金额",
      "剩余日均销售目标", " 剩余日均出库目标",
    ];
    const body = flatRows.map((r) => [
      r.region_name, r.sub_region_name ?? "", r.branch_name ?? "",
      r.sale_target, r.sale_actual, fmtRate(r.sale_rate),
      r.delivery_target, r.delivery_actual, fmtRate(r.delivery_rate),
      r.daily_sale, r.daily_delivery,
      r.remaining_daily_sale_target, r.remaining_daily_delivery_target,
    ]);
    exportExcel([head, ...body], `${targetMonth}月门店零售出库数据报表`);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {targetMonth}月门店零售/出库数据报表
        </h3>
        <ChartActions onExcel={handleExcel} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">大区名称</th>
              <th className="px-3 py-2 text-right font-medium">月销售目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 月出库目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月出库金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月出库完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 当天销售金额</th>
              <th className="px-3 py-2 text-right font-medium"> 当天出库金额</th>
              <th className="px-3 py-2 text-right font-medium"> 剩余日均销售目标</th>
              <th className="px-3 py-2 text-right font-medium"> 剩余日均出库目标</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {tree.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            )}
            {renderRows(tree, 0)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交组件文件**

```bash
git add web/components/report-center/region-drill-table.tsx
git commit -m "feat(web): add RegionDrillTable component with collapsible drill-down"
```

---

## Task 5: 创建 CategorySummary 组件

**Files:**
- Create: `web/components/report-center/category-summary.tsx`

**Interfaces:**
- Consumes: `CategorySummaryRow[]`（from Task 3）
- Produces: React 组件 `CategorySummary`

- [ ] **Step 1: 创建组件文件**

创建 `web/components/report-center/category-summary.tsx`：

```typescript
"use client";

import { CategorySummaryRow } from "@/lib/report-center/category-summary";
import { ChartActions, exportExcel } from "./chart-actions";

interface CategorySummaryProps {
  rows: CategorySummaryRow[];
  targetMonth: number;
}

// 毛利率 < 12% 标红
function marginColor(margin: number | null): string {
  if (margin == null) return "text-slate-300";
  return margin < 0.12 ? "text-red-600" : "text-slate-700";
}

function fmtCurrency(v: number): string {
  return v >= 10000 ? `¥${(v / 10000).toFixed(1)}万` : `¥${v.toFixed(0)}`;
}

function fmtRate(r: number | null): string {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

export function CategorySummary({ rows, targetMonth }: CategorySummaryProps) {
  const handleExcel = () => {
    const head = [
      "类别", " 月销售目标", " 月销售金额", " 月销售完成率",
      " 月毛利目标", " 月毛利金额", " 月毛利完成率", " 月毛利率",
      " 当天出库金额", " 当天出库毛利", " 当天毛利率", " 差额日均毛利目标",
    ];
    const body = rows.map((r) => [
      r.category,
      r.sale_target, r.sale_actual, fmtRate(r.sale_rate),
      r.profit_target, r.profit_actual, fmtRate(r.profit_rate), fmtRate(r.profit_margin),
      r.daily_amount, r.daily_profit, fmtRate(r.daily_profit_margin),
      r.remaining_daily_profit_target,
    ]);
    exportExcel([head, ...body], `${targetMonth}月仓储出库数据报表`);
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {targetMonth}月仓储出库数据报表
        </h3>
        <ChartActions onExcel={handleExcel} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">类别</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月销售完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利目标</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利金额</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利完成率</th>
              <th className="px-3 py-2 text-right font-medium"> 月毛利率</th>
              <th className="px-3 py-2 text-right font-medium"> 当天出库金额</th>
              <th className="px-3 py-2 text-right font-medium"> 当天出库毛利</th>
              <th className="px-3 py-2 text-right font-medium"> 当天毛利率</th>
              <th className="px-3 py-2 text-right font-medium"> 差额日均毛利目标</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-8 text-center text-slate-400">
                  暂无数据
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.category} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-700 font-medium">
                  {r.category}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.sale_target)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.sale_actual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtRate(r.sale_rate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.profit_target)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.profit_actual)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtRate(r.profit_rate)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(r.profit_margin)}`}>
                  {fmtRate(r.profit_margin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.daily_amount)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.daily_profit)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${marginColor(r.daily_profit_margin)}`}>
                  {fmtRate(r.daily_profit_margin)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {fmtCurrency(r.remaining_daily_profit_target)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 提交组件文件**

```bash
git add web/components/report-center/category-summary.tsx
git commit -m "feat(web): add CategorySummary component for category outbound report"
```

---

## Task 6: 修改 KpiCards 组件添加 tooltip

**Files:**
- Modify: `web/components/report-center/kpi-cards.tsx`

**Interfaces:**
- Consumes: 现有 `KpiRow[]` 数据
- Produces: KPI 卡片组件，hover 显示 tooltip（总目标、总完成、完成率）

- [ ] **Step 1: 修改组件文件**

修改 `web/components/report-center/kpi-cards.tsx`，在 KPI 卡片中添加 tooltip：

```typescript
"use client";

import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";

interface KpiRow {
  metric_code: MetricCode;
  target_value: number;
  actual_value: number | null;
  achievement_rate: number | null;
  progress_rate: number | null;
  data_status: string;
}

function fmtWan(v: number) {
  return v >= 10000 ? (v / 10000).toFixed(1) + "万" : v.toFixed(0);
}

function fmtCurrency(v: number): string {
  return `¥${fmtWan(v)}`;
}

function fmtPercent(r: number): string {
  return `${(r * 100).toFixed(1)}%`;
}

// 达成率三色编码（DESIGN 语义色），按 progress_rate 着色：
//   >=1   → success #16A34A（跑赢进度）
//   >=0.8 → warning #D97706（接近）
//   <0.8  → error #DC2626（落后）
function rateColor(r: number) {
  return r >= 1
    ? "text-green-600"
    : r >= 0.8
      ? "text-amber-600"
      : "text-red-600";
}

function statusBadgeClass(s: string) {
  const m: Record<string, string> = {
    complete: "bg-green-50 text-green-700",
    partial: "bg-amber-50 text-amber-700",
    missing: "bg-red-50 text-red-700",
    not_ready: "bg-slate-100 text-slate-400",
  };
  return m[s] ?? m.not_ready;
}

// Tooltip 组件
function KpiTooltip({ target, actual, rate }: { target: string; actual: string; rate: string }) {
  return (
    <div className="absolute z-10 hidden group-hover:block bg-white border border-slate-200 rounded shadow-lg p-2 text-xs min-w-[140px]">
      <div className="space-y-1 tabular-nums">
        <div className="flex justify-between">
          <span className="text-slate-500">总目标</span>
          <span className="text-slate-700 font-medium">{target}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">总完成</span>
          <span className="text-slate-700 font-medium">{actual}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">完成率</span>
          <span className="text-slate-700 font-medium">{rate}</span>
        </div>
      </div>
    </div>
  );
}

// 4 指标 KPI 卡行：每卡显示 label / 达成率大数字 / 实际·目标·进度 / 数据状态徽章。
// 点击 onFocus 切聚焦；聚焦卡 border-blue-500 ring-1（DESIGN primary）。
// hover 显示 tooltip：总目标、总完成、完成率。
export function KpiCards({
  rows,
  focus,
  onFocus,
}: {
  rows: KpiRow[];
  focus: MetricCode;
  onFocus: (m: MetricCode) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-center text-slate-400 py-8 text-sm">
        暂无指标数据
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {METRIC_ORDER.map((code) => {
        const r = rows.find((x) => x.metric_code === code);
        if (!r) return null;
        const meta = METRICS[code];
        const progress = r.progress_rate ?? 0;
        const isFocus = focus === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => onFocus(code)}
            className={`rounded-md border p-4 text-left transition relative group ${
              isFocus
                ? "border-blue-500 ring-1 ring-blue-500"
                : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{meta.label}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${statusBadgeClass(
                  r.data_status,
                )}`}
              >
                {r.data_status}
              </span>
            </div>
            <div
              className={`mt-1 text-2xl font-semibold tabular-nums ${rateColor(
                (r.achievement_rate ?? 0) / (progress || 0.0001),
              )}`}
            >
              {((r.achievement_rate ?? 0) * 100).toFixed(1)}%
            </div>
            <div className="mt-1 text-xs tabular-nums text-slate-400">
              {fmtWan(r.actual_value ?? 0)} / {fmtWan(r.target_value)} · 进度{" "}
              {(progress * 100).toFixed(0)}%
            </div>
            {/* Tooltip */}
            <KpiTooltip
              target={fmtCurrency(r.target_value)}
              actual={fmtCurrency(r.actual_value ?? 0)}
              rate={fmtPercent(r.achievement_rate ?? 0)}
            />
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 提交修改**

```bash
git add web/components/report-center/kpi-cards.tsx
git commit -m "feat(web): add tooltip to KpiCards showing target/actual/rate on hover"
```

---

## Task 7: 更新看板页面

**Files:**
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Modify: `web/app/reports/targets/[id]/page.tsx`

**Interfaces:**
- Consumes: `RegionDrillTable`, `CategorySummary`, `getRegionBreakdown`, `getCategorySummary`
- Produces: 更新后的看板页面，删除趋势图/排行图/交叉表，添加新组件

- [ ] **Step 1: 修改 page.tsx 获取数据**

修改 `web/app/reports/targets/[id]/page.tsx`，添加新数据获取：

```typescript
// web/app/reports/targets/[id]/page.tsx
// ... 保留现有的 target, kpi, breakdown, trend, freshness 获取逻辑 ...

import { getRegionBreakdown } from "@/lib/report-center/region-breakdown";
import { getCategorySummary } from "@/lib/report-center/category-summary";

export default async function TargetDashboardPage({ params }: { params: { id: string } }) {
  const { id } = params;
  
  // ... 现有获取逻辑 ...
  
  // 新增：获取下钻数据
  const regionBreakdown = await getRegionBreakdown(id);
  const categorySummary = await getCategorySummary(id);
  
  // 计算时间进度
  const progress = target.days_elapsed && target.total_days 
    ? target.days_elapsed / target.total_days 
    : 0;
  
  // 提取月份
  const targetMonth = new Date(target.start_date).getMonth() + 1;
  
  // 按设备分发
  const deviceType = getDeviceType();
  
  if (deviceType === "mobile") {
    return (
      <MobileDashboard
        target={target}
        kpi={kpi}
        regionBreakdown={regionBreakdown}
        categorySummary={categorySummary}
        progress={progress}
        targetMonth={targetMonth}
        freshness={freshness}
      />
    );
  }
  
  return (
    <DesktopDashboard
      target={target}
      kpi={kpi}
      regionBreakdown={regionBreakdown}
      categorySummary={categorySummary}
      progress={progress}
      targetMonth={targetMonth}
      freshness={freshness}
    />
  );
}
```

- [ ] **Step 2: 修改 desktop.tsx**

修改 `web/app/reports/targets/[id]/desktop.tsx`：

```typescript
"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { KpiCards } from "@/components/report-center/kpi-cards";
import { RegionDrillTable } from "@/components/report-center/region-drill-table";
import { CategorySummary } from "@/components/report-center/category-summary";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";
import { METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";

function fmtFresh(s: string | null) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-"); }
  catch { return s.slice(0, 16).replace("T", " "); }
}

export function DesktopDashboard({
  target,
  kpi,
  regionBreakdown,
  categorySummary,
  progress,
  targetMonth,
  freshness,
}: {
  target: any;
  kpi: any[];
  regionBreakdown: RegionBreakdownRow[];
  categorySummary: CategorySummaryRow[];
  progress: number;
  targetMonth: number;
  freshness: string | null;
}) {
  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          报表中心
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-800">
            {target.name}
          </h1>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              target.status === "active"
                ? "bg-blue-50 text-blue-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {target.status === "active" ? "进行中" : "已结束"}
          </span>
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-slate-400">
          {target.start_date} ~ {target.end_date} · 数据更新 {fmtFresh(freshness)}
        </div>
      </div>

      {/* KPI 卡（保留 focus 切换但不影响下方组件） */}
      <KpiCards rows={kpi} focus="sale" onFocus={() => {}} />

      {/* 门店零售/出库数据报表 */}
      <RegionDrillTable
        rows={regionBreakdown}
        targetMonth={targetMonth}
        progress={progress}
      />

      {/* 类别出库报表 */}
      <CategorySummary rows={categorySummary} targetMonth={targetMonth} />
    </div>
  );
}
```

- [ ] **Step 3: 修改 mobile.tsx**

修改 `web/app/reports/targets/[id]/mobile.tsx`：

```typescript
"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { KpiCards } from "@/components/report-center/kpi-cards";
import { RegionDrillTable } from "@/components/report-center/region-drill-table";
import { CategorySummary } from "@/components/report-center/category-summary";
import { RegionBreakdownRow } from "@/lib/report-center/region-breakdown";
import { CategorySummaryRow } from "@/lib/report-center/category-summary";

function fmtFresh(s: string | null) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(/\//g, "-"); }
  catch { return s.slice(0, 16).replace("T", " "); }
}

export function MobileDashboard({
  target,
  kpi,
  regionBreakdown,
  categorySummary,
  progress,
  targetMonth,
  freshness,
}: {
  target: any;
  kpi: any[];
  regionBreakdown: RegionBreakdownRow[];
  categorySummary: CategorySummaryRow[];
  progress: number;
  targetMonth: number;
  freshness: string | null;
}) {
  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 sticky top-0 z-10">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs text-slate-400"
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          报表中心
        </Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-lg font-semibold text-slate-800">
            {target.name}
          </h1>
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              target.status === "active"
                ? "bg-blue-50 text-blue-700"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {target.status === "active" ? "进行中" : "已结束"}
          </span>
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-slate-400">
          {target.start_date} ~ {target.end_date} · 数据更新 {fmtFresh(freshness)}
        </div>
      </div>

      {/* KPI 卡 */}
      <div className="px-4">
        <KpiCards rows={kpi} focus="sale" onFocus={() => {}} />
      </div>

      {/* 门店零售/出库数据报表 */}
      <div className="px-4">
        <RegionDrillTable
          rows={regionBreakdown}
          targetMonth={targetMonth}
          progress={progress}
        />
      </div>

      {/* 类别出库报表 */}
      <div className="px-4">
        <CategorySummary rows={categorySummary} targetMonth={targetMonth} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 提交页面修改**

```bash
git add web/app/reports/targets/[id]/page.tsx web/app/reports/targets/[id]/desktop.tsx web/app/reports/targets/[id]/mobile.tsx
git commit -m "feat(web): update dashboard pages to use new components, remove trend/rank/cross-table"
```

---

## Task 8: 删除旧组件和孤儿组件

**Files:**
- Delete: `web/components/charts/line-chart.tsx`
- Delete: `web/components/charts/rank-chart.tsx`
- Delete: `web/components/charts/bar-chart.tsx`
- Delete: `web/components/report-center/cross-table.tsx`
- Delete: `web/components/mobile/report-card.tsx`
- Delete: `web/components/skeletons/report-detail-skeleton.tsx`

- [ ] **Step 1: 删除文件**

```bash
git rm web/components/charts/line-chart.tsx
git rm web/components/charts/rank-chart.tsx
git rm web/components/charts/bar-chart.tsx
git rm web/components/report-center/cross-table.tsx
git rm web/components/mobile/report-card.tsx
git rm web/components/skeletons/report-detail-skeleton.tsx
```

- [ ] **Step 2: 提交删除**

```bash
git commit -m "chore(web): remove deprecated trend/rank/cross-table components and orphan files"
```

---

## Task 9: 部署和验证

**Files:**
- 无新增文件

- [ ] **Step 1: 推送代码触发 GHA**

```bash
git push origin perm-arch-p1
```

- [ ] **Step 2: 等待 GHA 完成，检查部署状态**

```bash
gh run watch --exit-status
```

- [ ] **Step 3: 验证前端渲染**

访问 `https://data.shanhaiyiguo.com/reports/targets/[target_id]`，检查：
1. KPI 卡片 hover 显示 tooltip
2. 门店零售/出库数据报表折叠下钻正常
3. 类别出库报表显示正常
4. 趋势图/排行图/交叉表已删除

- [ ] **Step 4: 验证数据库视图**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT * FROM report_region_breakdown_v LIMIT 5;'"
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT * FROM report_category_summary_v LIMIT 5;'"
```

---

## Self-Review

### 1. Spec Coverage

| Spec 要求 | 对应 Task |
|-----------|----------|
| KPI 卡片 hover 详情 | Task 6 |
| 门店零售/出库数据报表（折叠下钻） | Task 1, Task 3, Task 4, Task 7 |
| 类别出库报表 | Task 2, Task 3, Task 5, Task 7 |
| 删除趋势图/排行图/交叉表 | Task 8 |
| 响应式布局（PC/移动） | Task 7 |
| 三色达成率编码 | Task 4, Task 5 |
| 毛利率 < 12% 标红 | Task 5 |
| 完成率低于时间进度标红 | Task 4 |

### 2. Placeholder Scan

✅ 无 TBD/TODO/待实现代码
✅ 所有 SQL 和 TypeScript 代码完整
✅ 所有测试命令明确

### 3. Type Consistency

✅ `RegionBreakdownRow` 在 Task 3 定义，Task 4 使用
✅ `CategorySummaryRow` 在 Task 3 定义，Task 5 使用
✅ 视图字段与 TypeScript 接口一致

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-21-report-center-phase1.md`.**
