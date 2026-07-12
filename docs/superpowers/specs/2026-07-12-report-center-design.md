# 报表中心（目标驱动达成看板）设计 spec

> 日期：2026-07-12 ｜ 子系统：前端呈现 MVP（C 方向：报表+目标中心）
> brainstorming 产物，下一步转 writing-plans 出实现计划

## 一、背景与现状

前端现状（已 Explore 证实）：**管理后台为主体，数据消费空白**。
- 管理侧 7 页全是真实数据（数据源/采集/监控/目标/管理仪表盘），但呈现粗糙（原生 `<table>`）。
- 消费侧仅 `/`（报表中心）+ `/reports/[id]`（详情），且**全是 mock 假数据**：只有 2 条种子报表（`002_seed.sql`），详情页图表/明细标 `TODO: 接入真实查询`。
- 后端数据层已丰富但消费侧没接：`report_achievement_v`（目标达成）、`report_daily_sales/category`、`report_weekly_trend`、`retail_detail`/`delivery_detail`/`wholesale_detail` 三明细、`dim_item`/`dim_branch`/`canonical_product`。
- 基建到位：Next 16 + React 19 + shadcn/ui + Tailwind v4 + ECharts 6 + TanStack Table；企微登录 + 组件级双端适配（消费侧移动端已完整）。

**本次 MVP 把后端已有的数据，通过「报表中心」呈现给业务用户**。

## 二、目标与范围

**目标**：报表中心 = 目标驱动的达成看板。选目标 → 该目标的达成分析（进度/排行/趋势/差距/明细）。PC 丰富展示 + 移动卡片流，类 Excel 交叉、下钻联动、导出/分享。

**MVP 做**：
1. 报表中心骨架：`/` = 目标列表（默认进行中 active，可切 closed）→ 点目标 → 达成看板
2. **第一版报表：销售目标达成看板**（数据最现成：`report_achievement_v` + `report_daily_sales/category`），跑通全流程
3. PC 丰富看板（KPI / 趋势 / 排行 / 类 Excel 交叉表 / 下钻联动 / 每组件下载分享）
4. 移动卡片流（7 张信息卡 / 维度切换器 / 生成分享图）
5. 导出（Excel/图片/PDF，PC）+ 分享图（移动）
6. 双端适配（复用现有组件级双端机制）

**MVP 不做（后置）**：
- 权限角色（管理层/战区/店长）——所有登录用户先看全数据，admin/非 admin 基础区分沿用现有白名单
- 业务数据板块（全量明细自由查）——由现有 OpenClaw 问数覆盖，后续再做专门入口
- 自由透视（类 Excel 先「预设交叉」，不做拖拽透视）
- 运营周报（需新算汇总表）
- 拿货/批发目标报表（第二版复制销售报表的模式）

## 三、信息架构

```
/ （报表中心，登录后落地页）
  → 目标列表（默认 active 进行中；可切 closed 已结束）
    → 点目标 → /reports/targets/[id]  目标达成看板
                 ├─ PC：/desktop  丰富看板
                 └─ 移动：/mobile  卡片流
```

**替换**：现有 `/` 的假报表中心（2 条种子）+ `/reports/[id]` 的 mock 详情页。现有假数据迁移：`reports` 表 + `002_seed.sql` 假报表废弃（或保留兼容，新看板直接读 targets/report_achievement_v）。

**目标驱动**（A 方案，已确认）：目标是入口，看板是目标的视图。区分 active（实时算 actual）/ closed（读 snapshot 固化值），对应 D 子系统 `report_achievement_v` 三态。

## 四、PC 目标达成看板（销售目标示例）

布局（自上而下）：
1. **目标头部**：目标名 + 状态徽章（进行中/已结束）+ 周期 + 指标类型 + 「切换目标 ▾」
2. **KPI 大数字行**（5 个）：目标值 / 实际值 / 达成率 / 进度率（时间加权）/ 日均还需；色标（跑赢绿/落后红）；点数字下钻明细
3. **趋势 + 排行**（2:1）：
   - 累计达成趋势折线（实际累计 vs 目标线 vs 进度线，缺口阴影）
   - 战区达成排行（横向柱，未达标红）
4. **类 Excel 交叉表**：默认 战区 × 品类 销售达成；**维度切换**（战区/门店/品类/商品 任选两维交叉）；点单元格下钻明细；合计列 + 达成率列
5. **每组件操作**：每个图表/交叉表右上角 `⬇Excel · 🖼图片 · 🔗分享`（组件级，非全页）
6. **明细下钻区**：点 KPI/排行/交叉表单元格 → 展开对应明细（retail_detail 行）

页级操作：`⬇导出全部（Excel/PDF）`。

## 五、移动目标达成看板（企微内）

纵向卡片流（关键卡置顶，下滑看更多，每卡 ⋯ 可单独生成分享图）：
1. 环形达成率 + 实际/目标/日均还需
2. 趋势迷你折线（实际 vs 目标 vs 进度）
3. 战区排行（红绿预警）
4. 品类结构（堆叠条）
5. 商品 Top5
6. 门店达成分布（达标/接近/落后）
7. 期末预测（按当前进度推算）

**移动端设计要点**：
- **维度切换器**（战区/品类/门店/商品 tab 横滑）代替 PC 多图联动
- **下钻**：点 list 进下一级（战区 › 门店），面包屑返回，不弹窗
- **生成分享图**：一键把当前视图截成带标题+大数字+排行的卡片图，企微转发（移动端不下文件）
- 弱化下载（Excel/PDF 只在 PC）
- 未达标红色 + ⚠

## 六、交互（下钻 / 联动 / 导出 / 分享）

- **下钻联动**：PC 多图联动（点战区 → 趋势/排行/交叉表都过滤到该战区）；移动用顶部维度切换器 + 层级面包屑。最多 3 级（战区 → 门店 → 商品）。
- **类 Excel 交叉表**：预设维度交叉（不做自由拖拽），两维可选（行/列各一维）+ 度量（销售额/达成率/量）。
- **导出**：
  - Excel：组件数据导出（`xlsx` / SheetJS）
  - 图片：组件截图（`html2canvas`）
  - PDF：整页报表（PC，服务端 puppeteer 或客户端 jsPDF；MVP 先客户端）
- **分享**：
  - PC：分享链接（带目标 id + 当前筛选，登录后还原视图）
  - 移动：生成分享图（html2canvas 截卡片 → 企微转发图片）

## 七、数据来源与流

| 看板内容 | 数据源 | 引擎 |
|---|---|---|
| 目标 + 达成率/进度 | `report_achievement_v`（active 实时 / closed snapshot） | pg（security_invoker 走 RLS） |
| 销售汇总（趋势/排行/交叉表） | `report_daily_sales`（日门店）/ `report_daily_category`（日门店品类） | pg |
| 周/月趋势 | `report_weekly_trend` / 按日聚合 | pg |
| 商品/门店维 | `dim_item` / `dim_branch` / `canonical_product` / `dim_region` | pg |
| 明细下钻 | `retail_detail` / `delivery_detail` / `wholesale_detail`（parquet） | duckdb（read_parquet） |

**数据流**：前端组件 → `web/app/api/query/route.ts`（新建，代理）→ 按引擎分发：
- pg 汇总表/视图 → PostgREST（带 JWT，走 RLS）
- duckdb 明细 parquet → agent-query `/query`（带 AGENT_API_KEY + user_id）

权限（后置）：MVP 不做角色，但 query 代理仍带 user_id（为后续 RLS 预留），MVP 阶段全量返回。

## 八、技术栈与选型

**沿用**：Next 16 / React 19 / shadcn/ui / Tailwind v4 / ECharts 6（图表）/ TanStack Table（明细表）/ 现有双端组件机制（middleware 设备检测 + 组件级切换）。

**新增依赖**：
- `xlsx`（SheetJS）—— Excel 导出
- `html2canvas` —— 图片导出 / 分享图
- `jspdf`（PDF，MVP 客户端）

**类 Excel 交叉表**：用 TanStack Table 的 grouping/aggregation + 自定义交叉渲染（行维 × 列维 pivot）。不引入 agGrid/pivot 库（YAGNI，预设交叉够用）。

**ECharts**：扩展现有 `components/charts/bar-chart.tsx`，加 line（趋势）/ bar-horizontal（排行）/ pie/donut（结构）/ gauge（达成率环形）等封装。

## 九、文件结构

**改造**：
- `web/app/page.tsx` —— `/` 改为「目标列表」（默认 active），替换假报表中心
- `web/middleware.ts` + `web/components/layout/header.tsx` —— 白名单抽到配置（消除重复两处）
- 废弃 `web/components/reports/`（desktop-detail/mobile-detail/report-detail 三份重复 mock）+ `database/migrations/002_seed.sql` 假报表数据

**新建**：
- `web/app/reports/targets/[id]/page.tsx` —— 目标达成看板页（按设备分发 PC/移动）
- `web/app/reports/targets/[id]/desktop.tsx` / `mobile.tsx` —— 双端看板
- `web/lib/report-center/` —— 数据层：
  - `targets.ts`（目标列表 + 达成概览，读 report_achievement_v）
  - `sales-dashboard.ts`（销售看板各模块数据：KPI/趋势/排行/交叉表/Top，读 report_daily_sales/category）
  - `share.ts`（生成分享图）
- `web/components/report-center/` —— 组件：
  - `target-list.tsx`（目标列表）
  - `kpi-cards.tsx`、`trend-chart.tsx`、`rank-chart.tsx`、`cross-table.tsx`、`top-list.tsx`、`store-distribution.tsx`、`forecast-card.tsx`
  - `chart-actions.tsx`（每组件的 ⬇Excel/🖼图片/🔗分享 按钮封装）
  - `share-image.tsx`（分享图生成）
- `web/app/api/query/route.ts` —— 查询代理（pg→PostgREST / duckdb→agent-query，带 user_id）
- `web/components/charts/` —— 扩展 line/rank-donut/gauge 等图表封装

## 十、双端适配

复用现有机制：`middleware.ts` 设备检测 → `device_type` cookie + `x-device-type` header → 页面 `isMobile ? <Mobile/> : <Desktop/>`。
- PC 看板：多列网格（KPI 5 列 / 趋势+排行 2:1 / 交叉表全宽）
- 移动看板：单列卡片流
- 看板页 `reports/targets/[id]/page.tsx` 按设备分发，PC/mobile 各一文件（不共用复杂布局，避免之前 reports 三份重复的坑——这次 PC/mobile 分文件但共享数据层 `lib/report-center/`）

## 十一、权限（后置，MVP 不做）

MVP：所有登录用户看全数据。admin（ZhangDuo 白名单）多一个「管理后台」入口（现有）。
后续版本：管理层（全公司+成本）/ 战区负责人（本战区）/ 店长（本店），基于 `branch_nums` + `can_see_cost` RLS，身份映射走「admin 手动配 user_profiles」（待定）。query 代理现在就带 user_id，为后续预留。

## 十二、YAGNI

- 不做自由拖拽透视（预设交叉够用）
- 不做权限角色（后置）
- 不做业务数据板块（问数覆盖，后置）
- 不做运营周报（需新算，后置）
- 第一版只销售目标报表（拿货/批发第二版复制）
- 不引入 agGrid（TanStack 够用）

## 十三、后续路线

1. 拿货目标报表（delivery_detail）、批发目标报表（wholesale_detail）—— 复制销售报表模式
2. 权限角色（管理层/战区/店长 + RLS + user_profiles 配置）
3. 业务数据板块（全量明细自由查/探索，区别于报表中心的目标驱动）
4. 运营周报（/compute 新汇总模板 + triggerCompute）
5. 自由透视（若预设交叉不够用）
6. admin 后台移动适配 + `/admin/targets` 侧栏入口（现状孤儿路由）

## 十四、成功标准（MVP）

- `/` 进入目标列表，看到真实目标（active/closed），可切换
- 点销售目标 → PC 看板：KPI/趋势/排行/类 Excel 交叉表全接真数据，可切维度、点单元格下钻明细，每组件可导出 Excel/图片、分享
- 移动端（企微内）看板：7 卡片流，维度切换，一键生成分享图转发
- 假报表（002_seed + reports 详情 mock）清除或隐藏
- 零 mock：所有数字来自真实查询
