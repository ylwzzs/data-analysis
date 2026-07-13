# 报表中心（多指标总览达成看板）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后端已就绪的达成数据（`report_achievement_v` 4 指标 + 门店/品类 breakdown + 三张日汇总表）通过「报表中心」呈现给业务用户：点目标 → 多指标达成看板（KPI/趋势/排行/交叉表），PC 丰富 + 移动卡片流，零 mock。

**Architecture:** 目标驱动。`/` = 目标列表（读 `report_achievement_v` where target_level='total'）→ 点目标进 `/reports/targets/[id]` 看板。看板按 target_type 分派（store 走门店维度、hq 走品类维度）。前台读全部走 `web/lib/api.ts` per-request token client（SDK + 用户 JWT，走 RLS），**不建 query 代理路由**（现状前台 Server Component 直调 SDK 即可）；admin 写才走 `/api/admin/*`。PC/移动分文件渲染，共享 `lib/report-center/` 数据层。门店级数据直接读视图 breakdown 行（不前端聚合），仅趋势读 report_daily_*。

**Tech Stack:** Next 16 App Router (RSC) / React 19 / shadcn/ui / Tailwind v4 / ECharts 6 (echarts-for-react) / @tanstack/react-table / xlsx (Excel 导出) / html2canvas (图片+分享图，新装) / @insforge/sdk。

**Spec:** `docs/superpowers/specs/2026-07-12-report-center-design.md`（2026-07-13 已修订对齐多指标+双端）

---

## 关键数据事实（已实测 2026-07-13）

- 真实目标 id=22「7月经营指标」(store total, ALL, 7-01~7-31)，挂 256 store breakdown（门店）+ 2 hq breakdown（水果/标品耗材，出库品类）。一个 total 含全 4 指标。
- `report_achievement_v` 字段：target_id, name, status(active/closed), start_date, end_date, target_type(store/hq), target_level(total/breakdown), category, branch_num, metric_code(sale/delivery/outbound_amt/outbound_profit), target_value, actual_value, data_status(complete/partial/missing), achievement_rate, progress_rate, days_elapsed, total_days, war_zone(first_level_region), branch_name。
- 4 指标真实达成（id22, 13天/31天）：销售 559万/达成24%/进度58%；配送 379万/33%/79%；出库金额 621万/44%/106%；出库毛利 72.9万/52%/124%。
- 日汇总表：report_daily_sales(biz_date,system_book_code,branch_num,total_sale)、report_daily_delivery(biz_date,system_book_code,branch_num,category_group,out_money,profit_money)、report_daily_wholesale(同 delivery 结构, wholesale_money/wholesale_profit)。

---

## 文件结构

**新建：**
- `web/lib/report-center/metric-source.ts` — metric_code → 趋势表/字段映射常量
- `web/lib/report-center/targets.ts` — 目标列表 + total 详情（读 report_achievement_v）
- `web/lib/report-center/achievement.ts` — 看板数据：KPI/breakdown(排行+交叉表)/trend
- `web/lib/auth.ts` — ADMIN_USERIDS 共享常量（消除 header/middleware 重复）
- `web/components/charts/line-chart.tsx` — 累计趋势折线
- `web/components/charts/rank-chart.tsx` — 横向柱排行
- `web/components/charts/gauge-chart.tsx` — 环形达成率（移动）
- `web/components/report-center/chart-actions.tsx` — ⬇Excel/🖼图片/🔗分享 按钮封装
- `web/components/report-center/kpi-cards.tsx` — 4 指标 KPI 卡行
- `web/components/report-center/cross-table.tsx` — 门店×指标 交叉表
- `web/components/report-center/target-list.tsx` — 目标列表
- `web/components/report-center/share-image.tsx` — 移动分享图（html2canvas）
- `web/app/reports/targets/[id]/page.tsx` — 看板页（按设备分发）
- `web/app/reports/targets/[id]/desktop.tsx` — PC 看板
- `web/app/reports/targets/[id]/mobile.tsx` — 移动卡片流

**改造：**
- `web/app/page.tsx` — `/` 改目标列表（替换假报表中心）
- `web/components/layout/header.tsx` — ADMIN_USERIDS 引用 `lib/auth.ts`
- `web/middleware.ts` — ADMIN_USERIDS 引用 `lib/auth.ts`
- `web/app/reports/page.tsx` — 设备分发统一用 `getDeviceType()`（消除 UA 直判）

**废弃：**
- `web/components/reports/desktop-detail.tsx` / `mobile-detail.tsx` / `report-detail.tsx`（三份 mock）
- `web/app/reports/[id]/` 旧假报表详情路由（保留文件但重定向到新看板，或删除）
- `database/migrations/002_seed.sql` 假报表数据（列表不再读 reports 表，读 targets）

---

## Task 1: 基建（依赖 + 共享常量 + 设备分发统一）

**Files:**
- Create: `web/lib/auth.ts`
- Modify: `web/components/layout/header.tsx:10`, `web/middleware.ts:5-9`
- Modify: `web/app/reports/page.tsx:10-35`
- Install: `html2canvas`

- [ ] **Step 1: 装 html2canvas（用 npmmirror 镜像）**

```bash
cd web && npm install html2canvas --registry=https://registry.npmmirror.com
```
预期：package.json dependencies 出现 `html2canvas`。

- [ ] **Step 2: 建 `web/lib/auth.ts` 共享白名单**

```ts
// web/lib/auth.ts
// admin 白名单单一来源（消除 header.tsx 与 middleware.ts 的重复定义）
export const ADMIN_USERIDS = new Set(["ZhangDuo", "YangWei"]);

export function isAdmin(userid: string | null | undefined): boolean {
  return !!userid && ADMIN_USERIDS.has(userid);
}
```

- [ ] **Step 3: header.tsx 引用共享常量**

`web/components/layout/header.tsx:10` 删除 `const ADMIN_USERIDS = new Set(["ZhangDuo","YangWei"])`，改为：
```ts
import { isAdmin } from "@/lib/auth";
// 原来用 ADMIN_USERIDS.has(userid) 的地方改 isAdmin(userid)
```

- [ ] **Step 4: middleware.ts 引用共享常量**

`web/middleware.ts:5-9` 删除本地 ADMIN_USERIDS 定义，改 `import { ADMIN_USERIDS } from "@/lib/auth"`。注意 middleware 是 edge runtime，确认 `lib/auth.ts` 不用 Node API（只 new Set，OK）。

- [ ] **Step 5: reports/page.tsx 设备分发统一**

`web/app/reports/page.tsx` 把 `isMobileDevice(ua)` 改为 `getDeviceType(headers)`（与详情页一致）：
```ts
import { getDeviceType } from "@/lib/get-device-type";
// 在 page 里：
const deviceType = getDeviceType(headers());
const isMobile = deviceType === "mobile";
```

- [ ] **Step 6: 构建验证 + commit**

```bash
cd web && npm run build 2>&1 | tail -20
```
预期：build 通过（白名单引用无误、edge runtime 无报错）。
```bash
git add web/lib/auth.ts web/components/layout/header.tsx web/middleware.ts web/app/reports/page.tsx web/package.json
git commit -m "refactor(report-center): 基建-共享ADMIN_USERIDS+统一设备分发+装html2canvas

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 数据层 — metric 映射 + 目标列表/详情

**Files:**
- Create: `web/lib/report-center/metric-source.ts`
- Create: `web/lib/report-center/targets.ts`

- [ ] **Step 1: 建 metric-source.ts 映射常量**

```ts
// web/lib/report-center/metric-source.ts
// metric_code → 趋势数据源映射。outbound 走 delivery+wholesale 双查前端合并。
export type MetricCode = "sale" | "delivery" | "outbound_amt" | "outbound_profit";

export interface MetricMeta {
  code: MetricCode;
  label: string;          // 中文标签
  unit: string;           // 单位（元/万）
  trendTable: "report_daily_sales" | "report_daily_delivery" | "report_daily_wholesale";
  trendValueCol: string;  // 累计字段
  // outbound 由 delivery+wholesale 合成，需两个源
  secondaryTable?: "report_daily_wholesale";
  secondaryValueCol?: string;
  // 品类过滤（outbound 只计 水果/标品耗材；sale/delivery 全部）
  categoryIn?: string[];
}

export const METRICS: Record<MetricCode, MetricMeta> = {
  sale:            { code:"sale",            label:"销售",     unit:"元", trendTable:"report_daily_sales",    trendValueCol:"total_sale" },
  delivery:        { code:"delivery",         label:"配送",     unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money" },
  outbound_amt:    { code:"outbound_amt",     label:"出库金额", unit:"元", trendTable:"report_daily_delivery", trendValueCol:"out_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_money", categoryIn:["水果","标品耗材"] },
  outbound_profit: { code:"outbound_profit",  label:"出库毛利", unit:"元", trendTable:"report_daily_delivery", trendValueCol:"profit_money",
                     secondaryTable:"report_daily_wholesale", secondaryValueCol:"wholesale_profit", categoryIn:["水果","标品耗材"] },
};

export const METRIC_ORDER: MetricCode[] = ["sale","delivery","outbound_amt","outbound_profit"];
```

- [ ] **Step 2: 建 targets.ts — 目标列表 + total 详情**

```ts
// web/lib/report-center/targets.ts
// 读 report_achievement_v：目标列表(total行) + total 详情(4指标KPI)
import { getClient } from "@/lib/api";

export interface TargetSummary {
  target_id: number; name: string; status: "active"|"closed";
  target_type: "store"|"hq"; start_date: string; end_date: string;
  // 概览：主指标达成率（取该目标的第一个指标，列表卡用）
  sample_metric: string; sample_achievement_rate: number; sample_progress_rate: number;
}

// 目标列表：DISTINCT total 行（一个目标 4 指标 → 取一行代表）
export async function getTargetList(status?: "active"|"closed"): Promise<TargetSummary[]> {
  const client = await getClient();
  let q = client.from("report_achievement_v").select("*").eq("target_level","total");
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("status").order("start_date",{ascending:false});
  if (error) throw error;
  // 按 target_id 去重（取 metric_code 优先 sale 的行）
  const byId = new Map<number, TargetSummary>();
  for (const r of data ?? []) {
    if (byId.has(r.target_id)) continue;
    byId.set(r.target_id, {
      target_id: r.target_id, name: r.name, status: r.status, target_type: r.target_type,
      start_date: r.start_date, end_date: r.end_date,
      sample_metric: r.metric_code, sample_achievement_rate: r.achievement_rate ?? 0,
      sample_progress_rate: r.progress_rate ?? 0,
    });
  }
  return [...byId.values()];
}

// total 详情：该目标全指标 KPI 行
export async function getTargetKpi(targetId: number) {
  const client = await getClient();
  const { data, error } = await client.from("report_achievement_v")
    .select("*").eq("target_id", targetId).eq("target_level","total");
  if (error) throw error;
  return data ?? [];  // 每行一个 metric_code 的 KPI
}
```

- [ ] **Step 3: 验证查询能跑通（容器内 node 直调）**

在本地 dev 或 SSH 容器验证 SQL 语义正确（确认字段名/过滤）：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT target_id,name,metric_code,target_value,actual_value,achievement_rate,progress_rate
FROM report_achievement_v WHERE target_level='total' ORDER BY target_id,metric_code;\""
```
预期：返回 id=22 的 4 行（sale/delivery/outbound_amt/outbound_profit），字段名与 targets.ts 一致。

- [ ] **Step 4: build + commit**

```bash
cd web && npm run build 2>&1 | tail -10
git add web/lib/report-center/metric-source.ts web/lib/report-center/targets.ts
git commit -m "feat(report-center): 数据层-metric映射+目标列表/详情(targets.ts)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 数据层 — 看板数据（breakdown 排行/交叉表 + 趋势）

**Files:**
- Create: `web/lib/report-center/achievement.ts`

- [ ] **Step 1: 建 achievement.ts — breakdown + 趋势**

```ts
// web/lib/report-center/achievement.ts
// breakdown(门店/品类排行+交叉表) + 趋势(按日累计)
import { getClient } from "@/lib/api";
import { METRICS, MetricCode } from "./metric-source";

export interface BreakdownRow {
  target_id: number; branch_num: string; branch_name: string; war_zone: string;
  category: string | null; metric_code: MetricCode;
  target_value: number; actual_value: number | null;
  achievement_rate: number | null; progress_rate: number | null;
}

// breakdown 行：store→门店(256) / hq→品类(2)。用于排行+交叉表。
export async function getBreakdown(targetId: number, targetType: "store"|"hq"): Promise<BreakdownRow[]> {
  const client = await getClient();
  const { data, error } = await client.from("report_achievement_v")
    .select("target_id,branch_num,branch_name,war_zone,category,metric_code,target_value,actual_value,achievement_rate,progress_rate")
    .eq("parent_target_id", targetId).eq("target_level","breakdown").eq("target_type", targetType);
  if (error) throw error;
  return (data ?? []) as BreakdownRow[];
}

export interface TrendPoint { date: string; cum_actual: number; target_line: number; progress_line: number; }

// 趋势：按日累计 actual vs 目标线(匀) vs 进度线(匀)。按 metric 选表，outbound 双查合并。
export async function getTrend(target: {
  system_book_code: string; branch_num: string; category: string | null;
  start_date: string; end_date: string; target_value: number; metric_code: MetricCode;
}): Promise<TrendPoint[]> {
  const meta = METRICS[target.metric_code];
  const client = await getClient();
  // 主表按日聚合
  const main = await fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn);
  let merged = main;
  if (meta.secondaryTable && meta.secondaryValueCol) {
    const sec = await fetchDailySum(client, meta.secondaryTable, meta.secondaryValueCol, target, meta.categoryIn);
    // 按日期合并（FULL JOIN 语义）
    const byDate = new Map<string, number>();
    for (const d of main) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
    for (const d of sec) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
    merged = [...byDate.entries()].map(([date,value]) => ({date,value}));
  }
  return toTrendPoints(merged, target);
}

// 内部：单表按日聚合（branch_num='ALL' 时汇总全部门店；categoryIn 过滤品类组）
async function fetchDailySum(client: any, table: string, col: string, t: any, categoryIn?: string[]) {
  let q = client.from(table).select(`biz_date,${col}`)
    .eq("system_book_code", t.system_book_code)
    .gte("biz_date", t.start_date).lte("biz_date", t.end_date);
  if (t.branch_num && t.branch_num !== "ALL") q = q.eq("branch_num", t.branch_num);
  if (categoryIn && categoryIn.length) q = q.in("category_group", categoryIn);
  // report_daily_sales 无 category_group 列，categoryIn 为 undefined 时不加该过滤（sale 全品类）
  const { data, error } = await q;
  if (error) throw error;
  // 按日求和（同日多行合并）
  const byDate = new Map<string, number>();
  for (const r of data ?? []) byDate.set(r.biz_date, (byDate.get(r.biz_date) ?? 0) + Number(r[col] ?? 0));
  return [...byDate.entries()].map(([date,value]) => ({date, value}));
}

// 内部：日累计 + 目标线 + 进度线
function toTrendPoints(daily: {date:string,value:number}[], t: {start_date:string;end_date:string;target_value:number}): TrendPoint[] {
  const sorted = daily.filter(d => d.date >= t.start_date && d.date <= t.end_date).sort((a,b)=>a.date<b.date?-1:1);
  const days = Math.max(1, Math.round((+new Date(t.end_date) - +new Date(t.start_date))/86400000) + 1);
  const dailyTarget = t.target_value / days;
  let cum = 0;
  return sorted.map((d, i) => {
    cum += d.value;
    const dayIdx = i + 1;
    return {
      date: d.date,
      cum_actual: Math.round(cum),
      target_line: Math.round(dailyTarget * dayIdx),
      progress_line: Math.round(dailyTarget * dayIdx), // 进度线=目标匀速线（与目标线同，进度率另在KPI体现）
    };
  });
}
```

> 注：`progress_line` 与 `target_line` 同（匀速目标线）；进度率（实际/匀速应达）已在 KPI 卡呈现。趋势图聚焦"实际累计 vs 匀速目标线"的缺口。

- [ ] **Step 2: 验证 breakdown + 趋势查询语义**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT target_type, count(*), count(distinct branch_num) FROM report_achievement_v WHERE parent_target_id=22 AND target_level='breakdown' GROUP BY target_type;\""
```
预期：store 256 行、hq 2 行。
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT biz_date, sum(out_money) FROM report_daily_delivery WHERE system_book_code='3120' AND biz_date BETWEEN '2026-07-01' AND '2026-07-12' GROUP BY 1 ORDER BY 1 LIMIT 5;\""
```
预期：每日配送额行（验证趋势查询字段）。

- [ ] **Step 3: build + commit**

```bash
cd web && npm run build 2>&1 | tail -10
git add web/lib/report-center/achievement.ts
git commit -m "feat(report-center): 数据层-breakdown排行/交叉表+趋势(achievement.ts)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 图表组件（line / rank / gauge + chart-actions）

**Files:**
- Create: `web/components/charts/line-chart.tsx`
- Create: `web/components/charts/rank-chart.tsx`
- Create: `web/components/charts/gauge-chart.tsx`
- Create: `web/components/report-center/chart-actions.tsx`

沿用现有 `web/components/charts/bar-chart.tsx` 范式：接收结构化 data，组件内组装 ECharts option，传 `<ReactECharts option={...}/>`。

- [ ] **Step 1: line-chart.tsx（累计趋势：实际 vs 目标线，缺口阴影）**

```tsx
// web/components/charts/line-chart.tsx
"use client";
import ReactECharts from "echarts-for-react";

export interface TrendPoint { date: string; cum_actual: number; target_line: number; }
export function LineChart({ data, height = 300 }: { data: TrendPoint[]; height?: number }) {
  const option = {
    tooltip: { trigger: "axis" },
    legend: { data: ["实际累计", "目标线"], top: 0 },
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    xAxis: { type: "category", data: data.map(d => d.date.slice(5)) },
    yAxis: { type: "value" },
    series: [
      {
        name: "实际累计", type: "line", smooth: true, data: data.map(d => d.cum_actual),
        areaStyle: { opacity: 0.1 }, itemStyle: { color: "#1E40AF" },
      },
      {
        name: "目标线", type: "line", smooth: true, data: data.map(d => d.target_line),
        lineStyle: { type: "dashed", color: "#94A3B8" }, itemStyle: { color: "#94A3B8" },
      },
    ],
  };
  return <ReactECharts option={option} style={{ height }} />;
}
```

- [ ] **Step 2: rank-chart.tsx（横向柱排行，未达标红）**

```tsx
// web/components/charts/rank-chart.tsx
"use client";
import ReactECharts from "echarts-for-react";

export interface RankItem { name: string; rate: number; }  // rate=达成率 0~1
export function RankChart({ data, height = 300 }: { data: RankItem[]; height?: number }) {
  const sorted = [...data].sort((a,b) => a.rate - b.rate); // 升序（横向柱从下往上）
  const option = {
    tooltip: { trigger: "axis", formatter: (p: any) => `${p[0].name}: ${(p[0].value*100).toFixed(1)}%` },
    grid: { left: 80, right: 30, top: 10, bottom: 20 },
    xAxis: { type: "value", max: 1, axisLabel: { formatter: (v:number) => (v*100).toFixed(0)+"%" } },
    yAxis: { type: "category", data: sorted.map(d => d.name) },
    series: [{
      type: "bar",
      data: sorted.map(d => ({
        value: d.rate,
        itemStyle: { color: d.rate >= 1 ? "#16A34A" : d.rate >= 0.8 ? "#F59E0B" : "#DC2626" },
      })),
    }],
  };
  return <ReactECharts option={option} style={{ height }} />;
}
```

- [ ] **Step 3: gauge-chart.tsx（环形达成率，移动用）**

```tsx
// web/components/charts/gauge-chart.tsx
"use client";
import ReactECharts from "echarts-for-react";

export function GaugeChart({ rate, label }: { rate: number; label?: string }) {
  const pct = Math.round(rate * 100);
  const color = rate >= 1 ? "#16A34A" : rate >= 0.8 ? "#F59E0B" : "#DC2626";
  const option = {
    series: [{
      type: "gauge", startAngle: 90, endAngle: -270, radius: "90%",
      pointer: { show: false }, progress: { show: true, overlap: false, roundCap: true, clip: false, itemStyle: { color } },
      axisLine: { lineStyle: { width: 16, color: [[1, "#E2E8F0"]] } },
      splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false },
      data: [{ value: pct }],
      title: { show: false },
      detail: { valueAnimation: true, fontSize: 28, offsetCenter: [0,0], formatter: `{value}%`, color },
    }],
  };
  return <div className="relative"><ReactECharts option={option} style={{ height: 200 }} />{label && <p className="text-center text-sm text-slate-500 -mt-4">{label}</p>}</div>;
}
```

- [ ] **Step 4: chart-actions.tsx（⬇Excel/🖼图片/🔗分享 按钮封装）**

```tsx
// web/components/report-center/chart-actions.tsx
"use client";
import { Download, Image as ImageIcon, Share2 } from "lucide-react";
import * as XLSX from "xlsx";

// Excel 导出：传二维数组（含表头）
export function exportExcel(rows: (string|number)[][], filename: string) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : filename + ".xlsx");
}

// 图片导出：html2canvas 截 ref 元素
export async function exportImage(el: HTMLElement, filename: string) {
  const html2canvas = (await import("html2canvas")).default;
  const canvas = await html2canvas(el, { backgroundColor: "#fff", scale: 2 });
  const link = document.createElement("a");
  link.download = filename.endsWith(".png") ? filename : filename + ".png";
  link.href = canvas.toDataURL("image/png");
  link.click();
}

export function ChartActions({ onExcel, onImage, onShare }: { onExcel?: ()=>void; onImage?: ()=>void; onShare?: ()=>void }) {
  return (
    <div className="flex gap-1 text-xs text-slate-400">
      {onExcel && <button onClick={onExcel} title="导出Excel" className="hover:text-slate-700">⬇Excel</button>}
      {onImage && <button onClick={onImage} title="导出图片" className="hover:text-slate-700">🖼图片</button>}
      {onShare && <button onClick={onShare} title="分享" className="hover:text-slate-700">🔗分享</button>}
    </div>
  );
}
```

- [ ] **Step 5: build 验证（确认 html2canvas 动态 import 正常）+ commit**

```bash
cd web && npm run build 2>&1 | tail -10
git add web/components/charts/line-chart.tsx web/components/charts/rank-chart.tsx web/components/charts/gauge-chart.tsx web/components/report-center/chart-actions.tsx
git commit -m "feat(report-center): 图表组件-line/rank/gauge+导出封装(chart-actions)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: PC 目标列表页（`/` 改造）

**Files:**
- Modify: `web/app/page.tsx`
- Create: `web/components/report-center/target-list.tsx`

- [ ] **Step 1: target-list.tsx 组件**

```tsx
// web/components/report-center/target-list.tsx
import Link from "next/link";
import { TargetSummary } from "@/lib/report-center/targets";

function fmtPct(r: number) { return (r*100).toFixed(1)+"%"; }
function rateColor(r: number) { return r>=1?"text-green-600":r>=0.8?"text-amber-600":"text-red-600"; }

export function TargetList({ targets }: { targets: TargetSummary[] }) {
  if (!targets.length) return <div className="text-center text-slate-400 py-12">暂无目标</div>;
  return (
    <div className="grid gap-3">
      {targets.map(t => (
        <Link key={t.target_id} href={`/reports/targets/${t.target_id}`}
          className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-5 py-4 hover:border-blue-400 hover:shadow-sm transition">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-slate-800">{t.name}</span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${t.status==="active"?"bg-blue-50 text-blue-700":"bg-slate-100 text-slate-500"}`}>
                {t.status==="active"?"进行中":"已结束"}
              </span>
              <span className="text-xs text-slate-400">{t.target_type==="store"?"门店":"总部"}</span>
            </div>
            <div className="text-xs text-slate-400 mt-1 tabular-nums">{t.start_date} ~ {t.end_date}</div>
          </div>
          <div className="text-right tabular-nums">
            <div className={`text-xl font-semibold ${rateColor(t.sample_progress_rate)}`}>{fmtPct(t.sample_progress_rate)}</div>
            <div className="text-xs text-slate-400">达成 {fmtPct(t.sample_achievement_rate)}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: page.tsx 改为目标列表**

`web/app/page.tsx` 替换假报表中心逻辑：
```tsx
import { getDeviceType } from "@/lib/get-device-type";
import { getTargetList } from "@/lib/report-center/targets";
import { TargetList } from "@/components/report-center/target-list";
import { Sidebar } from "@/components/layout/sidebar";

export default async function HomePage() {
  const [targets, closedTargets] = await Promise.all([
    getTargetList("active"),
    getTargetList("closed"),
  ]);
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 p-6 max-w-5xl mx-auto">
        <h1 className="text-xl font-semibold text-slate-800 mb-4">报表中心 · 进行中目标</h1>
        <TargetList targets={targets} />
        {closedTargets.length > 0 && (
          <>
            <h2 className="text-sm font-medium text-slate-500 mt-8 mb-3">已结束</h2>
            <TargetList targets={closedTargets} />
          </>
        )}
      </main>
    </div>
  );
}
```
> 注：保留 `getDeviceType` 分发能力——若移动端需不同布局，加 `isMobile ? <MobileList/> : <DesktopList/>`。第一版列表 PC/移动共用 `TargetList`（响应式 grid 够用），移动看板在 Task 9。

- [ ] **Step 3: build + 本地视觉验证 + commit**

```bash
cd web && npm run build 2>&1 | tail -10
```
本地 `npm run dev` 访问 `/`，确认看到真实目标「7月经营指标」卡片（达成率/进度率真数字）。
```bash
git add web/app/page.tsx web/components/report-center/target-list.tsx
git commit -m "feat(report-center): 首页改目标列表(读report_achievement_v total行)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: PC 看板页骨架 + 头部 + KPI 卡

**Files:**
- Create: `web/app/reports/targets/[id]/page.tsx`
- Create: `web/app/reports/targets/[id]/desktop.tsx`
- Create: `web/components/report-center/kpi-cards.tsx`

- [ ] **Step 1: kpi-cards.tsx（4 指标 KPI 卡行 + 聚焦切换）**

```tsx
// web/components/report-center/kpi-cards.tsx
"use client";
import { METRICS, METRIC_ORDER, MetricCode } from "@/lib/report-center/metric-source";

interface KpiRow { metric_code: MetricCode; target_value: number; actual_value: number | null;
  achievement_rate: number | null; progress_rate: number | null; data_status: string; }

function fmtWan(v: number) { return v>=10000 ? (v/10000).toFixed(1)+"万" : v.toFixed(0); }
function rateColor(r: number) { return r>=1?"text-green-600":r>=0.8?"text-amber-600":"text-red-600"; }
function statusBadge(s: string) {
  const m: Record<string,string> = { complete:"bg-green-50 text-green-700", partial:"bg-amber-50 text-amber-700", missing:"bg-red-50 text-red-700", not_ready:"bg-slate-100 text-slate-400" };
  return m[s] ?? m.not_ready;
}

export function KpiCards({ rows, focus, onFocus }: { rows: KpiRow[]; focus: MetricCode; onFocus: (m: MetricCode)=>void }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {METRIC_ORDER.map(code => {
        const r = rows.find(x => x.metric_code === code);
        if (!r) return null;
        const meta = METRICS[code];
        const rate = r.progress_rate ?? 0;
        const isFocus = focus === code;
        return (
          <button key={code} onClick={() => onFocus(code)}
            className={`text-left rounded-lg border p-4 transition ${isFocus?"border-blue-500 ring-1 ring-blue-500":"border-slate-200 bg-white hover:border-slate-300"}`}>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-500">{meta.label}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusBadge(r.data_status)}`}>{r.data_status}</span>
            </div>
            <div className={`text-2xl font-semibold tabular-nums mt-1 ${rateColor(rate)}`}>{((r.achievement_rate??0)*100).toFixed(1)}%</div>
            <div className="text-xs text-slate-400 tabular-nums mt-1">
              {fmtWan(r.actual_value??0)} / {fmtWan(r.target_value)} · 进度 {(rate*100).toFixed(0)}%
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: desktop.tsx 看板（头部 + KPI + 占位趋势/排行/交叉表）**

```tsx
// web/app/reports/targets/[id]/desktop.tsx
"use client";
import { useState } from "react";
import Link from "next/link";
import { MetricCode } from "@/lib/report-center/metric-source";
import { KpiCards } from "@/components/report-center/kpi-cards";
import { LineChart } from "@/components/charts/line-chart";
import { RankChart } from "@/components/charts/rank-chart";

export function DesktopDashboard({ target, kpi, trend, breakdown }: any) {
  const [focus, setFocus] = useState<MetricCode>("sale");
  const focusTrend = trend[focus] ?? [];
  const focusRank = (breakdown.store ?? [])
    .filter((r:any) => r.metric_code === focus)
    .map((r:any) => ({ name: r.branch_name || r.branch_num, rate: r.achievement_rate ?? 0 }))
    .slice(0, 15);
  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600">← 报表中心</Link>
          <h1 className="text-xl font-semibold text-slate-800">{target.name}</h1>
          <div className="text-xs text-slate-400 tabular-nums">{target.start_date} ~ {target.end_date}</div>
        </div>
      </div>
      {/* KPI */}
      <KpiCards rows={kpi} focus={focus} onFocus={setFocus} />
      {/* 趋势 + 排行 */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2">累计达成趋势 · {focus}</h3>
          <LineChart data={focusTrend.map((d:any)=>({date:d.date,cum_actual:d.cum_actual,target_line:d.target_line}))} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700 mb-2">门店达成排行 · {focus}</h3>
          <RankChart data={focusRank} />
        </div>
      </div>
      {/* 交叉表 Task 8 填充 */}
    </div>
  );
}
```

- [ ] **Step 3: page.tsx 按设备分发 + 取数**

```tsx
// web/app/reports/targets/[id]/page.tsx
import { notFound } from "next/navigation";
import { getDeviceType } from "@/lib/get-device-type";
import { getClient } from "@/lib/api";
import { getTargetKpi } from "@/lib/report-center/targets";
import { getBreakdown, getTrend } from "@/lib/report-center/achievement";
import { METRIC_ORDER } from "@/lib/report-center/metric-source";
import { DesktopDashboard } from "./desktop";

export default async function TargetDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const targetId = Number(id);
  const headersList = await headers();
  const isMobile = getDeviceType(headersList) === "mobile";

  const client = await getClient();
  // total 行取目标元信息（任一指标行）
  const { data: totalRows } = await client.from("report_achievement_v")
    .select("*").eq("target_id", targetId).eq("target_level","total").limit(1);
  if (!totalRows?.length) notFound();
  const t = totalRows[0];

  const [kpi, breakdownStore, breakdownHq] = await Promise.all([
    getTargetKpi(targetId),
    getBreakdown(targetId, "store"),
    getBreakdown(targetId, "hq"),
  ]);

  // 每个指标的趋势
  const trend: Record<string, any> = {};
  for (const code of METRIC_ORDER) {
    const kpiRow = kpi.find((k:any) => k.metric_code === code);
    if (kpiRow) {
      try { trend[code] = await getTrend({ system_book_code:t.system_book_code, branch_num:t.branch_num, category:t.category, start_date:t.start_date, end_date:t.end_date, target_value:kpiRow.target_value, metric_code:code }); }
      catch { trend[code] = []; }
    }
  }

  if (isMobile) {
    // Task 9 实现
    return <div className="p-4">移动看板（Task 9）</div>;
  }
  return <div className="max-w-7xl mx-auto p-6"><DesktopDashboard target={t} kpi={kpi} trend={trend} breakdown={{store:breakdownStore, hq:breakdownHq}} /></div>;
}
```

> 注：`headers()` 需在文件顶部 `import { headers } from "next/headers"`（Next 16 异步）。page.tsx 是 Server Component，取数并行；desktop.tsx 是 client（含 useState 聚焦切换）。

- [ ] **Step 4: build + 视觉验证 + commit**

```bash
cd web && npm run build 2>&1 | tail -15
```
本地访问 `/reports/targets/22`，确认：头部目标名+周期、4 KPI 卡（真数字，销售红/出库绿）、点 KPI 切换聚焦、趋势+排行随切换变。
```bash
git add web/app/reports/targets/\[id\]/page.tsx web/app/reports/targets/\[id\]/desktop.tsx web/components/report-center/kpi-cards.tsx
git commit -m "feat(report-center): PC看板骨架-头部+KPI卡+聚焦切换+趋势/排行接入

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: PC 看板 — 交叉表 + 导出

**Files:**
- Create: `web/components/report-center/cross-table.tsx`
- Modify: `web/app/reports/targets/[id]/desktop.tsx`（接入交叉表）

- [ ] **Step 1: cross-table.tsx（门店×指标 交叉表，TanStack Table）**

```tsx
// web/components/report-center/cross-table.tsx
"use client";
import { useMemo } from "react";
import { METRIC_ORDER, METRICS } from "@/lib/report-center/metric-source";
import { ChartActions, exportExcel } from "./chart-actions";

interface Row { branch_num: string; branch_name: string; war_zone: string; metric_code: string; achievement_rate: number | null; actual_value: number | null; }

function cell(rate: number | null) {
  if (rate == null) return <td className="px-3 py-2 text-slate-300">—</td>;
  const cls = rate>=1?"text-green-600":rate>=0.8?"text-amber-600":"text-red-600";
  return <td className={`px-3 py-2 tabular-nums ${cls}`}>{(rate*100).toFixed(0)}%</td>;
}

// 门店 × 指标 交叉表：行=门店，列=4指标达成率，末列=实际销售
export function CrossTable({ rows, onExportData }: { rows: Row[]; onExportData?: (rows: Row[])=>void }) {
  // 透视：branch_num → { metric: row }
  const pivot = useMemo(() => {
    const m = new Map<string, { branch_name: string; war_zone: string; byMetric: Record<string, Row> }>();
    for (const r of rows) {
      if (!m.has(r.branch_num)) m.set(r.branch_num, { branch_name:r.branch_name, war_zone:r.war_zone, byMetric:{} });
      m.get(r.branch_num)!.byMetric[r.metric_code] = r;
    }
    return [...m.entries()].sort((a,b) => (a[1].war_zone||"").localeCompare(b[1].war_zone||""));
  }, [rows]);

  const handleExcel = () => {
    const head = ["战区","门店", ...METRIC_ORDER.map(c => METRICS[c].label+"达成")];
    const body = pivot.map(([num, v]) => [v.war_zone, v.branch_name||num, ...METRIC_ORDER.map(c => v.byMetric[c]?((v.byMetric[c].achievement_rate??0)*100).toFixed(1)+"%":"—")]);
    exportExcel([head, ...body], "门店指标达成");
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-slate-700">门店 × 指标达成</h3>
        <ChartActions onExcel={handleExcel} />
      </div>
      <div className="overflow-auto max-h-[480px]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-500">
            <tr><th className="px-3 py-2 text-left">战区</th><th className="px-3 py-2 text-left">门店</th>
              {METRIC_ORDER.map(c => <th key={c} className="px-3 py-2 text-right">{METRICS[c].label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pivot.map(([num, v]) => (
              <tr key={num} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-500">{v.war_zone}</td>
                <td className="px-3 py-2 text-slate-700">{v.branch_name||num}</td>
                {METRIC_ORDER.map(c => cell(v.byMetric[c]?.achievement_rate ?? null))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: desktop.tsx 接入交叉表**

在 `desktop.tsx` 的趋势/排行 grid 后加：
```tsx
import { CrossTable } from "@/components/report-center/cross-table";
// JSX 末尾：
<CrossTable rows={breakdown.store} />
```

- [ ] **Step 3: build + 验证交叉表有 256 行 + Excel 导出 + commit**

```bash
cd web && npm run build 2>&1 | tail -10
```
本地访问 `/reports/targets/22`，确认交叉表渲染 256 门店（按战区分组、达成率三色），点 ⬇Excel 下载 xlsx。
```bash
git add web/components/report-center/cross-table.tsx web/app/reports/targets/\[id\]/desktop.tsx
git commit -m "feat(report-center): PC看板-门店×指标交叉表+Excel导出

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 移动看板（卡片流 + 指标切换 + 分享图）

**Files:**
- Create: `web/app/reports/targets/[id]/mobile.tsx`
- Create: `web/components/report-center/share-image.tsx`
- Modify: `web/app/reports/targets/[id]/page.tsx`（isMobile 分支接 MobileDashboard）

- [ ] **Step 1: share-image.tsx（html2canvas 截卡片生成分享图）**

```tsx
// web/components/report-center/share-image.tsx
"use client";
import { useRef } from "react";
import { Share2 } from "lucide-react";

export function ShareButton({ targetRef, filename }: { targetRef: React.RefObject<HTMLElement|null>; filename: string }) {
  const onShare = async () => {
    if (!targetRef.current) return;
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(targetRef.current, { backgroundColor:"#fff", scale:2 });
    // 企微内无法直接分享图片到会话，先下载（用户手动转发）
    const link = document.createElement("a");
    link.download = filename + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  return <button onClick={onShare} className="flex items-center gap-1 text-xs text-blue-600"><Share2 size={14}/>生成分享图</button>;
}
```

- [ ] **Step 2: mobile.tsx 移动卡片流**

```tsx
// web/app/reports/targets/[id]/mobile.tsx
"use client";
import { useState, useRef } from "react";
import Link from "next/link";
import { METRIC_ORDER, METRICS, MetricCode } from "@/lib/report-center/metric-source";
import { GaugeChart } from "@/components/charts/gauge-chart";
import { LineChart } from "@/components/charts/line-chart";
import { RankChart } from "@/components/charts/rank-chart";
import { ShareButton } from "@/components/report-center/share-image";

export function MobileDashboard({ target, kpi, trend, breakdown }: any) {
  const [focus, setFocus] = useState<MetricCode>("sale");
  const cardRef = useRef<HTMLDivElement>(null);
  const kpiRow = kpi.find((k:any) => k.metric_code === focus);
  const focusTrend = trend[focus] ?? [];
  const focusRank = (breakdown.store ?? [])
    .filter((r:any) => r.metric_code === focus)
    .map((r:any) => ({ name: r.branch_name||r.branch_num, rate: r.achievement_rate ?? 0 }))
    .slice(0, 8);
  const fmtWan = (v:number) => v>=10000 ? (v/10000).toFixed(1)+"万" : v.toFixed(0);

  return (
    <div className="max-w-md mx-auto p-3 space-y-3">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-xs text-slate-400">← 报表中心</Link>
        <ShareButton targetRef={cardRef} filename={`${target.name}-${METRICS[focus].label}`} />
      </div>
      {/* 指标切换器 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {METRIC_ORDER.map(c => (
          <button key={c} onClick={()=>setFocus(c)}
            className={`text-xs px-3 py-1 rounded-full whitespace-nowrap ${focus===c?"bg-blue-600 text-white":"bg-slate-100 text-slate-600"}`}>
            {METRICS[c].label}
          </button>
        ))}
      </div>
      <div ref={cardRef} className="space-y-3">
        {/* 卡1 环形达成率 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <GaugeChart rate={kpiRow?.achievement_rate ?? 0} label={METRICS[focus].label} />
          <div className="flex justify-around text-center text-xs mt-2 tabular-nums">
            <div><div className="text-slate-400">实际</div><div className="font-medium text-slate-700">{fmtWan(kpiRow?.actual_value??0)}</div></div>
            <div><div className="text-slate-400">目标</div><div className="font-medium text-slate-700">{fmtWan(kpiRow?.target_value??0)}</div></div>
            <div><div className="text-slate-400">进度</div><div className="font-medium text-slate-700">{((kpiRow?.progress_rate??0)*100).toFixed(0)}%</div></div>
          </div>
        </div>
        {/* 卡2 趋势迷你 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <LineChart data={focusTrend.map((d:any)=>({date:d.date,cum_actual:d.cum_actual,target_line:d.target_line}))} height={160} />
        </div>
        {/* 卡3 门店排行 */}
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h4 className="text-xs text-slate-500 mb-1">门店达成 Top/Bottom</h4>
          <RankChart data={focusRank} height={200} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: page.tsx isMobile 分支接入**

`web/app/reports/targets/[id]/page.tsx` 的 isMobile 分支改为：
```tsx
import { MobileDashboard } from "./mobile";
// ...
if (isMobile) return <MobileDashboard target={t} kpi={kpi} trend={trend} breakdown={{store:breakdownStore, hq:breakdownHq}} />;
```

- [ ] **Step 4: build + 企微内验证 + commit**

```bash
cd web && npm run build 2>&1 | tail -10
```
企微移动端打开 `https://data.shanhaiyiguo.com/reports/targets/22`，确认：指标 tab 横滑切换、环形达成率、趋势、排行、生成分享图下载 png。
```bash
git add web/app/reports/targets/\[id\]/mobile.tsx web/components/report-center/share-image.tsx web/app/reports/targets/\[id\]/page.tsx
git commit -m "feat(report-center): 移动看板-卡片流+指标切换+分享图

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 清理废弃 mock + 假报表种子 + 路由

**Files:**
- Delete: `web/components/reports/desktop-detail.tsx`, `mobile-detail.tsx`, `report-detail.tsx`
- Delete/Redirect: `web/app/reports/[id]/`（旧假报表详情）
- Modify: `database/migrations/002_seed.sql`（假报表数据——列表已不读，可保留或加注释废弃）

- [ ] **Step 1: 删除三份 mock detail 组件**

```bash
git rm web/components/reports/desktop-detail.tsx web/components/reports/mobile-detail.tsx web/components/reports/report-detail.tsx
```

- [ ] **Step 2: 旧 `/reports/[id]` 路由重定向到新看板**

把 `web/app/reports/[id]/page.tsx` 内容替换为重定向（兼容旧链接/书签）：
```tsx
import { redirect } from "next/navigation";
export default async function LegacyReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 旧 reports 表 id 与 target_id 不同源；统一回到目标列表
  redirect("/");
}
```
> 注：旧 reports 表是假种子，id 与 targets 无映射，直接回列表。若需保留某 id→target 映射可后续补。

- [ ] **Step 3: 002_seed 假报表标注废弃**

`database/migrations/002_seed.sql` 顶部加注释（不删数据，避免迁移历史不一致）：
```sql
-- ⚠️ DEPRECATED 2026-07-13: 假报表种子，报表中心已改读 targets/report_achievement_v。
-- 列表页不再读 reports 表，此种子仅历史保留。新看板见 /reports/targets/[id]。
```

- [ ] **Step 4: 清理引用 + build + commit**

```bash
grep -rn "desktop-detail\|mobile-detail\|report-detail" web/  # 确认无残留 import
cd web && npm run build 2>&1 | tail -15
```
预期：build 通过，无未解析 import。
```bash
git add -A web/components/reports web/app/reports/\[id\] database/migrations/002_seed.sql
git commit -m "chore(report-center): 清理废弃mock detail组件+旧路由重定向+假报表标注废弃

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: 部署 + 端到端验证

**Files:** 无（部署 + 验证）

- [ ] **Step 1: 推送触发 GHA**

```bash
git push origin main
gh run watch  # 监控部署（约 3-4 分钟，5 steps 全绿）
```

- [ ] **Step 2: PC 端验证（生产）**

- 访问 `https://data.shanhaiyiguo.com/` → 看到真实目标「7月经营指标」卡片
- 点进 `/reports/targets/22` → 4 KPI 卡（销售24%/配送33%/出库金额44%/出库毛利52%，色标正确）
- 点 KPI 切聚焦 → 趋势折线 + 门店排行随之变
- 交叉表 256 门店按战区分组、三色达成率、⬇Excel 下载正常

- [ ] **Step 3: 企微移动端验证**

- 企微内打开同一链接 → 移动卡片流、指标 tab 切换、环形达成率、生成分享图
- 在企微 PC 端 + 移动端分别验证设备分发正确

- [ ] **Step 4: 数据准确性核对**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT metric_code, target_value, actual_value, achievement_rate, progress_rate FROM report_achievement_v WHERE target_id=22 AND target_level='total' ORDER BY metric_code;\""
```
预期：看板 KPI 数字与此查询一致（零 mock，全真值）。

- [ ] **Step 5: 更新 memory**

更新 `frontend-presentation.md` memory：Phase 2 报表中心已完成（多指标总览+PC/移动双端，读 report_achievement_v breakdown+report_daily_*趋势）。

---

## 自审（writing-plans skill checklist）

**1. Spec coverage：**
- spec 第二章「目标列表 active/closed 切换」→ Task 5（page.tsx 取 active+closed）
- spec 第四章「目标头部/KPI卡/趋势/排行/交叉表/导出」→ Task 6/7（PC 全覆盖）
- spec 第四章「明细下钻后置」→ plan 明确后置（Task 注释）
- spec 第五章「移动 7 卡 + 指标切换 + 分享图」→ Task 8（移动卡片流：环形/趋势/排行 + 指标切换器 + 分享图；品类结构/商品Top5/期末预测 标后置——sale-only 卡第一版后置）
- spec 第七章「数据源 metric 映射」→ Task 2/3（metric-source.ts + achievement.ts trend）
- spec 第九章「文件结构」→ 全部覆盖（lib/report-center/* + components/report-center/* + reports/targets/[id]/*）
- spec「废弃三份 mock + 假报表」→ Task 9
- spec「白名单抽配置」→ Task 1

**2. 后置项（plan 明确标注，避免 scope creep）：**
- 明细下钻（retail/transfer/wholesale_detail parquet + duckdb）
- 品类结构卡、商品 Top5（sale-only）、期末预测
- PDF 导出（jspdf 未装）
- 权限角色（admin/战区/店长 RLS）

**3. Type 一致性：** MetricCode = "sale"|"delivery"|"outbound_amt"|"outbound_profit"，METRIC_ORDER/METRICS/KpiCards/getTrend 全用同一类型；BreakdownRow/TrendPoint 在 achievement.ts 与 desktop/mobile 消费一致；getTargetKpi/getBreakdown/getTrend 返回类型与组件 props 对齐。

**4. 风险点：**
- `report_achievement_v` 是 security_invoker 视图，前台 SDK 走用户 JWT 走 RLS——若用户 branch_nums 非 '*'，看到的会被 RLS 收窄。MVP 全量（anon/authenticated 默认无 branch_nums 限制）应返全量；若返回空需查 RLS policy（report_daily_delivery 有 report_rls_branch_nums policy，视图继承）。
- `getTrend` 的 outbound 双查前端合并：若某日只有 delivery 无 wholesale（或反之），Map 合并能处理（FULL JOIN 语义）。
- html2canvas 对 ECharts canvas 截图：需 `html2canvas` 配置或 ECharts `renderAsImage`；若截图空白，改用 ECharts 自带 `getDataURL()` 导出图表图片（chart-actions 里 chart 实例调 getDataURL）。
