# 基础维表维护（Phase 1）设计 spec

> 日期：2026-07-12 ｜ 子系统：前端呈现前置——基础维表维护
> brainstorming 产物，下一步转 writing-plans。报表中心（Phase 2）spec 见 `2026-07-12-report-center-design.md`

## 一、背景

报表中心（Phase 2）按战区/品类聚合 + 目标驱动，但前置维表数据没人维护：
- `dim_item` 4.1万行 / `dim_branch` 385行：采集自动填，base 齐
- `dim_item_ext` / `dim_branch_ext`：**0 行**（人工扩展空）
- `dim_region`（region→war_zone 映射，19行）：战区归属根，但前端零维护入口
- `targets`：扁平模型（每店一个目标），无「总目标→分解」关系；现有 admin/targets 简陋（只 sale、branch_num 手输、无批量/校验）

**Phase 1 做维表维护 CRUD + 目标分解**，让报表数字能落到业务对象上。

## 二、范围（MVP）

**做**：
1. **门店维护**：dim_branch 列表（筛/查，base 只读）+ dim_branch_ext 行内编辑（custom_group/note）+ dim_region 战区映射维护（region→war_zone，CSV 批量）+ 未映射区域预警
2. **目标分解**：总目标（多指标）→ 分解到门店（批量编辑 / 下载上传）+ 汇总校验（子和=总）

**不做（后置）**：
- 商品档案维护（dim_item + ext + 场景命名）—— 第二批（报表品类走 dim_item.category，不卡）
- 移动端编辑（维表维护 PC 为主；移动只读查看留 Phase 2）
- 权限角色（admin 白名单沿用，角色后置）
- 目标审批流

## 三、门店维护

### 3.1 门店列表（dim_branch 385 行）
- **base 字段只读**（采集维护）：门店号/名称/region_name/城市/启用/经纬度/电话...
- **ext 字段行内编辑**（dim_branch_ext）：`custom_group`（自定义分组）、`note`（备注），点单元格即改
- **战区列**（只读展示）：`dim_branch.region_name` JOIN `dim_region.war_zone`（战区在 dim_region 维护）
- **筛选**：region_name / 战区 / 城市 / 启用状态 + 搜索（门店号/名称）+ 分页

### 3.2 区域→战区映射（dim_region 19 行，战区归属根）
- 表格行内编辑：`region_name`（只读，来自 dim_branch 的 region 集合）/ `war_zone` / `sub_region` / `display_name`
- CSV 批量导入（region→war_zone）
- **改这里 → 所有该 region 的门店战区归属立即生效**（报表战区维度由此算）

### 3.3 未映射区域预警 tab
- 列出 `dim_branch` 里存在但 `dim_region` 没映射的 `region_name`（如「腾冲」漏了 war_zone）
- 一键补映射，避免报表战区漏算

### 3.4 dim_branch_ext
- `custom_group`（用于目标分解时按分组聚合，如「重点店/普通店」）+ `note`
- 在门店列表行内编辑；批量改分组（选中多店 → 设同分组）

## 四、目标分解（数据模型改造 + 界面）

### 4.1 数据模型调整（targets 扩展，向后兼容）
现状 `targets`（id/name/system_book_code/branch_num/start_date/end_date/status）+ `target_metric_values`（target_id+metric_code+target_value）是扁平的「每店一个目标」。

**加两列**（迁移幂等；branch_num 已存在，总目标约定用 'ALL'）：
```sql
ALTER TABLE targets ADD COLUMN IF NOT EXISTS parent_target_id BIGINT;  -- 分解指向总目标；总目标为 NULL
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_level TEXT DEFAULT 'breakdown';  -- 'total' 总目标 / 'breakdown' 分解
```

- **总目标**：`branch_num='ALL'`、`parent_target_id=NULL`、`target_level='total'`，`target_metric_values` 存各指标总值
- **分解**：`branch_num=<门店>`、`parent_target_id=<总目标id>`、`target_level='breakdown'`，`target_metric_values` 存该店各指标子值
- **向后兼容**：现有扁平 targets（branch_num=店、parent_id=NULL）视为「无总目标的独立目标」，`target_level='breakdown'` 默认值兼容

### 4.2 校验逻辑
- 分解保存时，每个指标：`SUM(breakdown.target_value WHERE parent=总目标) vs 总目标该指标 target_value`
- 差额红显（如销售 Σ24.8/25万 差0.2）
- 两种保存：① **平衡保存**（推荐，差额=0）② **强制保存**（允许差额，标记 `unbalanced`）
- **一键均分剩余**：把差额按战区/门店数自动摊到空缺单元格

### 4.3 report_achievement_v 适配
- `report_achievement_v` 已按 `branch_num` 算 actual（branch_nums='*' 全公司 / 单店）
- 总目标（branch_num=ALL）：actual = 全公司该指标
- 分解（branch_num=店）：actual = 该店该指标
- **总目标 actual = SUM(分解 actual)**（自然成立，无需改视图）
- 仅需：视图/查询支持 `branch_num='ALL'` 解析为全部门店（report_achievement_v 的 LATERAL 已按 branch_num 过滤，ALL 当作 '*' 处理）

### 4.4 界面（已 mockup 确认）
- **第一步 创建总目标**：名称 + 日期范围 + 指标（默认全部带出可叉掉，从 metric_definitions where data_ready）+ 每指标目标值 → 确定
- **第二步 分解目标**：
  - 批量编辑：自动带出 战区 / 分组(dim_branch_ext.custom_group) / 门店 × 各指标列，手填子值
  - 下载模板（xlsx，含战区/分组/门店+指标列）→ 填 → 上传
  - 汇总校验行（每指标子和 vs 总，差额红）+ 一键均分剩余 + 平衡/强制保存

## 五、PC 界面（已 visual 确认）

- **门店维护页** `/admin/branches`：tab（门店列表 / 区域→战区映射 / 未映射预警）
- **目标管理页** `/admin/targets`（改造）：总目标列表 + 创建总目标 + 分解（批量/上传 + 校验）
- 入口加到 admin 侧栏（现状 targets 是孤儿路由，补侧栏入口）

技术：shadcn Table + TanStack Table（列表/筛/分页）+ 行内编辑（ext/region）+ xlsx（模板下载/分解上传）。

## 六、移动端

Phase 1 维表维护 **PC 为主**（admin 操作）。移动端不做编辑（店长「看自己店/目标」留 Phase 2 报表中心）。理由：维表维护是 admin 低频操作，PC 效率高；移动端价值低。

## 七、API

- `GET/PATCH /api/admin/branches`：列表+筛 + ext 行内编辑（PATCH 单店 ext 字段）
- `GET/POST/PATCH /api/admin/regions`：dim_region CRUD + CSV 导入
- `GET/regions/unmapped`：未映射 region 预警
- `POST/api/admin/targets`（改造）：建总目标（含多指标）+ 分解（批量/上传）+ 校验
- `GET/PUT/DELETE /api/admin/targets/[id]`：目标 CRUD（总/分解）
- `GET/PUT /api/admin/targets/[id]/breakdown`：分解的批量读写 + 校验状态
- 模板下载/上传：`GET /api/admin/targets/template` / `POST /api/admin/targets/import`

走 SECURITY DEFINER RPC + 直连 PostgREST（同 D 子系统 admin route 模式，绕 RLS）。

## 八、文件结构

**新建**：
- `web/app/admin/branches/page.tsx` —— 门店维护（3 tab）
- `web/app/admin/regions/` —— 区域映射（或并入 branches tab）
- `web/lib/admin/branches.ts` / `regions.ts` / `targets.ts` —— 数据层
- `web/components/admin/` —— inline-edit-table（行内编辑表格）、target-breakdown-table（分解表+校验）
- `database/migrations/051_targets_breakdown.sql` —— targets 加 parent_target_id/target_level；校验函数/视图适配

**改造**：
- `web/app/admin/targets/page.tsx` —— 改造为总目标列表 + 分解
- `web/app/admin/layout.tsx` —— 侧栏加 门店维护 / 目标管理 入口（targets 现状孤儿路由）
- `web/app/api/admin/targets/route.ts` + close/import —— 适配总目标+分解
- `database/migrations/052_report_achievement_all.sql`（如需）—— report_achievement_v 支持 branch_num='ALL'→'*'

## 九、权限（后置）

admin 维护（白名单 ZhangDuo，沿用）。角色（管理层/战区/店长）后置，与报表中心权限一起做。

## 十、YAGNI

- 商品档案维护（第二批）
- 移动端编辑
- 权限角色
- 目标审批流
- 自定义指标（只用 metric_definitions 已有 sale/purchase/wholesale）

## 十一、后续路线

1. 商品档案维护（dim_item 列表/筛 + ext + item_scenario_names 场景命名）
2. 报表中心 Phase 2（消费 Phase 1 的战区 + 目标分解数据）
3. 权限角色 + 维护权限（谁能改哪个维表）

## 十二、成功标准

- 门店维护：385 门店列表筛/查/分页；ext（分组/备注）行内编辑；dim_region 19 行映射编辑 + CSV 导入；未映射区域预警补全
- 目标分解：建总目标（多指标，默认全选可叉）→ 分解到门店（批量编辑表格 / 下载上传）→ 汇总校验（子和 vs 总，差额红/绿，一键均分）；保存后 report_achievement_v 能算总/分解达成
- admin 侧栏有 门店维护 / 目标管理 入口（不再孤儿）
- 零破坏：现有扁平 targets + report_achievement_v 三态达成不受影响（向后兼容）
