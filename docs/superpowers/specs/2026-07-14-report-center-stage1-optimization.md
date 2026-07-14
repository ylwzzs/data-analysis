# 报表中心阶段 1 优化 spec（性能 + 视觉 + 64188 门店进销售排行）

> 日期：2026-07-14 ｜ 子系统：报表中心优化迭代（阶段 1/3）
> brainstorming 产物，下一步转 writing-plans

## 一、背景

报表中心 Phase 2 已上线（`/` 目标列表 → `/reports/targets/[id]` 多指标看板，PC/移动双端）。2026-07-13 修了销售全公司(060)/RPC 性能(061,81ms)/duckdb 并发/登录。本轮系统化优化分 3 阶段，**阶段 1 夯基础**：性能 + 视觉 + 64188 门店进销售排行。

## 二、数据口径铁律（用户两次强调，别再搞错）

- **销售明细**：3120 + 64188 **都有**（双品牌零售）
- **批发销售 + 配送毛利**：**只 3120**，64188 业务上根本没这两类——**不是待采集、不是后置做，是不存在**
- 060 视图 `system_book_code='ALL'` 时：sale 算双品牌(3120+64188)、delivery/outbound 算全部=只 3120 数据（64188 无贡献，正确）

## 三、目标与范围

**做**：
1. 性能：看板首屏加速（getTrend 并行 + outbound 双查并行）
2. 视觉：DESIGN 一致性（卡片圆角 + 空/加载状态 + tabular-nums 普查）
3. 数据：64188 门店进销售排行（改 get_breakdown + upsert_target_breakdown + 重新分解 id22）

**不做（阶段 2/3）**：明细下钻、品类结构卡、商品 Top5、期末预测、下钻联动、维度切换、时间范围切换、筛选、权限角色。

## 四、性能优化

### 4.1 getTrend 4 指标并行
**现状**：`page.tsx` L43-60 `for (const code of METRIC_ORDER) { await getTrend(...) }` —— 4 指标串行（sale/delivery/outbound_amt/outbound_profit），每个查 report_daily_*，累计 ~4× 单查耗时。outbound 还双查 delivery+wholesale。

**改动**：改 `Promise.all` 并行：
```ts
const trendEntries = await Promise.all(METRIC_ORDER.map(async (code) => {
  const kr = kpi.find((k:any) => k.metric_code === code);
  if (!kr) return [code, []];
  try { return [code, await getTrend({...t, target_value: kr.target_value, metric_code: code})]; }
  catch { return [code, []]; }
}));
const trend = Object.fromEntries(trendEntries);
```

### 4.2 outbound 趋势双查并行
**现状**：`achievement.ts` getTrend 内 outbound 走 `fetchDailySum(delivery)` + `fetchDailySum(wholesale)` 串行（main + secondary）。

**改动**：`Promise.all([fetchDailySum(main), fetchDailySum(secondary)])` 并行，再 Map 合并。

## 五、视觉打磨（DESIGN 一致）

### 5.1 卡片圆角 rounded-md → rounded-lg
**现状**：`desktop.tsx` L84/90 trend/rank 卡 `rounded-md`（6px）；`mobile.tsx` 卡 `rounded-xl`（12px，移动卡 DESIGN lg）。`cross-table.tsx` 容器 `rounded-lg`（已对）。

**改动**：desktop trend/rank 卡 `rounded-md` → `rounded-lg`（DESIGN L44 卡片 md 8px=rounded-lg）。普查 desktop/mobile 所有卡片容器统一 `rounded-lg`（PC）/`rounded-xl`（移动）。

### 5.2 空状态 + 看板 loading
**现状**：各组件（KPI/趋势/排行/交叉表）数据空时渲染空图/空表，无"暂无数据"提示。page.tsx 取数期间无 loading（SSR 空 list → 客户端 load 后填充，刷新闪）。

**改动**：
- 各组件数据空时显示"暂无数据"（`{data.length===0 && <div className="text-center text-slate-400 py-8 text-sm">暂无数据</div>}`）
- page.tsx 加 Suspense 或 loading.tsx（取数期间显示骨架/加载中），避免刷新闪空

### 5.3 tabular-nums 普查
**现状**：KPI 卡/交叉表/分解页已 tabular-nums；trend/rank 卡标题、移动卡部分数字未加。

**改动**：所有数字（标题含数字、tooltip、移动卡数值）补 `tabular-nums`。

## 六、64188 门店进销售排行

### 6.1 现状与问题
- `get_breakdown(p_parent_id)`（053 L128-139）：`SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id` + `WHERE b.system_book_code=v_sbc`。id22 改 `system_book_code='ALL'` 后 → `b.system_book_code='ALL'` → dim_branch 无 ALL 门店 → **分解页门店列表返空**（用户无法分解）。
- `upsert_target_breakdown(p_parent_id, p_sbc, p_rows, p_by)`（053 L80-105）：INSERT 门店分解用单一 `p_sbc`。前端 `saveStore`（`[id]/page.tsx` L47）硬编码 `sbc:'3120'` → 门店分解只建 3120 门店（system_book_code=3120），64188 门店永进不了。
- 报表中心看板 sale 排行用 `report_achievement_v` breakdown 行（已存 256 门店，全 3120）→ 64188 门店（128）不在。

### 6.2 改动

**① get_breakdown RPC（迁移 062 重建）**：parent sbc='ALL' 时返两品牌全部门店：
```sql
WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99'
```

**② upsert_target_breakdown RPC（迁移 062 重建）**：每门店 system_book_code 从 dim_branch 查（按 branch_num 定品牌），不再用单一 p_sbc 建：
```sql
-- INSERT 时 system_book_code 取该门店 dim_branch 的品牌
INSERT INTO targets(name, system_book_code, branch_num, ...)
SELECT t.name||'-'||v_branch,
       COALESCE((SELECT system_book_code FROM dim_branch WHERE branch_num=v_branch LIMIT 1), p_sbc),
       v_branch, t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, p_by, NOW()
FROM targets t WHERE t.id=p_parent_id
```
p_sbc 保留为 fallback（dim_branch 查不到时）。

**③ 前端 saveStore（`[id]/page.tsx` L47）**：去掉硬编码 `sbc:'3120'`，传 `sbc: 'ALL'`（或不传，route 默认 ALL；RPC 按 dim_branch 定门店品牌）。breakdown route POST `p_sbc: b.sbc || 'ALL'`。

**④ 重新分解 id22**：分解页重新加载（get_breakdown 返两品牌 385 门店）→ 用户填 64188 门店目标 → 保存（每门店 system_book_code=该门店品牌）→ report_achievement_v breakdown 含 64188 门店 → 看板 sale 排行显示 64188 门店。

### 6.3 注意
- delivery 排行：64188 门店无配送数据（breakdown 64188 门店 delivery actual=NULL/0，达成率空）→ 排行显示 64188 门店 delivery "—"（无数据）。这是正确的（64188 无配送）。
- outbound 是品类维度（hq breakdown，与门店无关），不受影响。

## 七、文件结构

**改**：
- `web/app/reports/targets/[id]/page.tsx` —— getTrend 并行 + Suspense/loading
- `web/lib/report-center/achievement.ts` —— getTrend outbound 双查并行
- `web/app/reports/targets/[id]/desktop.tsx` —— 卡片 rounded-lg + 空状态
- `web/app/reports/targets/[id]/mobile.tsx` —— 空状态 + tabular-nums
- `web/components/report-center/kpi-cards.tsx` / `cross-table.tsx` —— 空状态
- `web/app/admin/targets/[id]/page.tsx` —— saveStore 去硬编码 sbc
- `web/app/api/admin/targets/breakdown/route.ts` —— p_sbc 默认 ALL

**新建**：
- `database/migrations/062_breakdown_all_brand.sql` —— get_breakdown + upsert_target_breakdown 重建（ALL 支持 + per-门店 brand）
- `web/app/reports/targets/[id]/loading.tsx` —— 看板加载骨架

## 八、验证

- 看板首屏：getTrend 并行后首屏耗时降（4 串行→1 并行，测 before/after）
- 视觉：卡片圆角统一 lg、空状态显示、刷新不闪空（loading）
- 64188 门店进销售排行：分解页 get_breakdown(22) 返 385 门店（3120 256 + 64188 128）；重新分解后看板 sale 排行含 64188 门店；delivery 排行 64188 门店显示"—"（无数据，正确）
- 口径不变：销售双品牌(1011万)、配送/批发只 3120

## 九、YAGNI / 不做

- 明细下钻（阶段 2）
- 品类结构/Top5/期末预测（阶段 2）
- 下钻联动/维度切换/时间范围/筛选（阶段 3）
- 权限角色（后置）
- 64188 批发/配送采集（**业务上不存在，永不做**）
