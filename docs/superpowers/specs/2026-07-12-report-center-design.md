# 报表中心（目标驱动达成看板）设计 spec

> 日期：2026-07-12 ｜ 子系统：前端呈现 MVP（C 方向：报表+目标中心）
> brainstorming 产物，下一步转 writing-plans 出实现计划

---

> ## 2026-07-13 修订（数据层 + 目标模型对齐）
>
> 原 spec 写于目标两类模型(057)与出库达成底座(058)**之前**，把"单指标销售看板"当唯一示例。现两者已上线，关键事实更新：
> - **目标两类**：`store`（门店目标，销售/配送，拆门店）+ `hq`（总部目标，出库金额/毛利，按品类水果/标品耗材，不拆门店）。一个 total 目标含多指标 + 挂门店/品类 breakdown。
> - **达成 4 指标全可算**：`report_achievement_v`(058) 支持 sale/delivery/outbound_amt/outbound_profit + active/closed 两态 + achievement_rate/progress_rate。
> - **真实数据已通**：销售 2598 行/188 店/到 7-13；配送 2103 行/3 品类组；批发 28 行。实测「7月经营指标」(id 22, 13天/31天) 销售达成24%/进度58%、出库金额达成44%/进度106%（超额）。
> - **门店级数据走 breakdown 行**：256 门店 breakdown 目标的 `report_achievement_v` 行天然是门店级达成，**交叉表/排行直接读视图，不需前端再聚合 report_daily_***。只有"按日累计趋势"需 report_daily_*。
>
> **本次实现范围（用户 2026-07-13 确认）**：多指标总览看板 + PC/移动双端全做。下文第四/五/七章已据此修订。

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
2. **第一版报表：多指标总览达成看板**（点一个 total 目标 → 该目标全指标达成：销售/配送/出库金额/出库毛利 KPI + 趋势 + 门店/品类排行 + 交叉表）。4 指标数据全通，一次覆盖 store/hq 两类目标
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

## 四、PC 目标达成看板（多指标总览）

点一个 total 目标（如「7月经营指标」）进入。一个目标含多指标 + 挂门店/品类 breakdown，看板按 target_type 分派布局（store 走门店维度、hq 走品类维度，组件复用）。

布局（自上而下）：
1. **目标头部**：目标名 + 状态徽章（进行中 active / 已结束 closed）+ 周期 + 目标类型（门店/总部）+ 「切换目标 ▾」（返回列表）
2. **指标 KPI 卡行**（store 4 卡 / hq 2 卡）：销售 / 配送 / 出库金额 / 出库毛利。每卡：目标值 / 实际值 / **达成率大数字**（色标：超额绿 ≥100%、接近黄 80–100%、落后红 <80%，按进度率判）/ 进度率（时间加权）/ 数据状态徽章（complete/partial/missing）。**点卡片 = 设为"聚焦指标"**，驱动下方趋势+排行。
3. **趋势 + 排行**（2:1，随聚焦指标切换）：
   - 累计达成趋势折线（聚焦指标按日累计 actual vs 目标线 vs 进度线，缺口阴影；sale 读 report_daily_sales、delivery 读 report_daily_delivery、outbound 读 delivery+wholesale 按日累计）
   - 门店达成排行（store）/ 品类达成排行（hq）：横向柱，未达标红，Top/Bottom 双向
4. **类 Excel 交叉表**：**门店 × 指标**（store，行=门店或战区聚合，列=4 指标达成率+合计）/ **品类 × 指标**（hq，行=水果/标品耗材）。数据直接读 `report_achievement_v` 的 breakdown 行（门店级天然在视图里，不前端聚合）；合计列 + 达成率列 + 色阶；点单元格下钻明细（**第一版后置**）
5. **每组件操作**：每个图表/交叉表右上角 `⬇Excel · 🖼图片 · 🔗分享`（组件级，非全页）

页级操作：`⬇导出全部（Excel/PDF）`。

**明细下钻**（第一版后置，YAGNI）：点交叉表单元格 → 该店/品类该指标的明细行（sale→retail_detail / delivery→transfer_detail / wholesale→wholesale_detail，走 duckdb）。交叉表+排行已覆盖"谁达标谁落后"，明细第二版接。

## 五、移动目标达成看板（企微内）

纵向卡片流（关键卡置顶，下滑看更多，每卡 ⋯ 可单独生成分享图）。顶部 **指标切换器**（销售/配送/出库金额/出库毛利 tab 横滑）代替 PC 多图联动，切指标后卡 1-3 随之变：
1. 环形达成率 + 实际/目标/日均还需（当前指标）
2. 趋势迷你折线（当前指标 实际 vs 目标 vs 进度）
3. 战区/品类排行（当前指标，红绿预警）
4. 门店达成分布（达标/接近/落后，当前指标）—— store 目标
5. 品类结构（堆叠条，水果 vs 标品耗材）—— hq 目标 / sale 指标
6. 商品 Top5 —— **仅 sale 指标**（report_daily_category 有品类维；delivery/wholesale 是品类组级别无单品，后置）
7. 期末预测（按当前进度推算当前指标期末达成）

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
| 目标 total + 达成率/进度（KPI 卡） | `report_achievement_v` where target_level='total'（active 实时 / closed snapshot） | pg（security_invoker 走 RLS） |
| 门店/品类级（排行、交叉表） | `report_achievement_v` where target_level='breakdown'（256 门店 / 2 品类天然在视图，**不前端聚合**） | pg |
| 按日累计趋势 | 各指标对应日汇总表（见下映射） | pg |
| 门店/战区维 | `dim_branch`（branch_name / first_level_region 战区） | pg |
| 明细下钻（第一版后置） | `retail_detail` / `transfer_detail` / `wholesale_detail`（parquet） | duckdb |

**指标 → 趋势数据源映射**（按聚焦指标选表）：

| metric_code | 日汇总表 | 累计 actual 字段 |
|---|---|---|
| sale | report_daily_sales | total_sale（branch_num 聚合） |
| delivery | report_daily_delivery | out_money（全品类） |
| outbound_amt | report_daily_delivery + report_daily_wholesale | out_money + wholesale_money（品类组 in 水果/标品耗材） |
| outbound_profit | 同上 | profit_money + wholesale_profit |

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
