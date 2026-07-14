# 目标分解页重新设计 spec（总部布局 + 门店三级分解）

> 日期：2026-07-14 ｜ 子系统：目标分解（D 子系统）/admin/targets/[id]
> brainstorming 产物，下一步转 writing-plans

## 一、背景

`/admin/targets/[id]` 分解页两个问题：
1. **总部板块**：2 列（出库金额/出库毛利）窄，右边大片空白；合计行"合计 / 总目标"两值重复（hqSum 与 balance.total 应相等，显示两值冗余）。
2. **门店板块**：现在只门店级分解（total → 门店 breakdown 两级）。用户要**三级分解**：战区目标 → 二级区域目标 → 门店分解，多级独立设 + 子和校验。

## 二、目标与范围

**做**：
1. 总部板块布局紧凑 + 合计去重（留一个）
2. 门店板块三级分解（战区 → 二级区域 → 门店），多级独立目标 + 子和校验

**数据口径**：销售/配送分解到门店（store breakdown）；战区/二级区域级是销售/配送的汇总目标（非品类）。出库品类（hq）不变。

## 三、总部板块（布局 + 合计去重）

### 现状
2×2 表（品类行 × 指标列）+ 合计行"合计 / 总目标"（hqSum / balance.total 两值）。列 w-40 窄，右边空。

### 改动
- **布局紧凑**：品类 × 指标 2×2 表加宽（w-40→w-56 或 fill），或改卡片式（每品类卡含 2 指标输入）。去右边空白。
- **合计去重**：合计行只留一个值——留"合计"（hqSum，品类输入和），去掉"总目标"重复显示。子和校验（hqSum vs balance.total）用色标：差额=0 绿 ✓，差额≠0 红 + 显示差额。不再"合计 / 总目标"两值并列。

## 四、门店三级分解（核心）

### 4.1 数据模型
targets 加 3 列（迁移 063）：
- `breakdown_level TEXT` — 'war_zone'/'region_l2'/'store'（门店级默认 'store'，向后兼容）
- `war_zone TEXT` — 战区（first_level_region）
- `region_l2 TEXT` — 二级区域（second_level_region）

三级 breakdown（都 `parent_target_id=total`，扁平，breakdown_level 区分）：
- **战区级**：breakdown_level='war_zone', war_zone=战区名, branch_num='ALL', region_l2=NULL
- **二级区域级**：breakdown_level='region_l2', war_zone+region_l2, branch_num='ALL'
- **门店级**：breakdown_level='store', branch_num=门店, war_zone+region_l2（从 dim_branch 取）

UNIQUE 改造：`(system_book_code, target_type, branch_num, category, breakdown_level, war_zone, region_l2, start_date, end_date)`（加 breakdown_level/war_zone/region_l2 区分三级）。

### 4.2 RPC（迁移 063 重建）
- **upsert_target_breakdown** 扩展：参数加 `p_level`（war_zone/region_l2/store）+ 行数据含 war_zone/region_l2/branch_num。按 level + 定位键（战区=war_zone，区域=war_zone+region_l2，门店=branch_num）upsert。每门店级 upsert 时从 dim_branch 取 war_zone/region_l2 填充。
- **get_breakdown** 返三级：`{warZoneRows, regionRows, storeRows}`（战区行/区域行/门店行，各含 metrics）。
- **check_breakdown_balance** 三级校验：每指标 `战区子和=total`、`区域子和=战区`、`门店子和=区域`。返 `{sale:{total, warZoneSum, regionSum, storeSum, ...}, delivery:{...}}` + 各级 balanced 标志。

### 4.3 视图（迁移 063 重建 report_achievement_v）
report_achievement_v LATERAL 按 breakdown_level 分派：
- `breakdown_level='store'`（门店级）：现有逻辑（branch_num）
- `breakdown_level='war_zone'`（战区级）：LATERAL 按 `war_zone` 聚合（report_daily_sales JOIN dim_branch ON branch_num + WHERE first_level_region=t.war_zone）
- `breakdown_level='region_l2'`（区域级）：LATERAL 按 `war_zone+region_l2` 聚合

sale/delivery LATERAL 都加 war_zone/region_l2 分支。outbound（hq 品类）不变。

### 4.4 前端三级表（`[id]/page.tsx` 门店板块）
- 三级树形表：战区行（可展开）→ 二级区域行（可展开）→ 门店行
- 每级行：名称 + sale 目标输入 + delivery 目标输入 + 子和校验（子和=父，差额色标）
- 战区行：战区名 + sale/delivery 目标 + 该战区区域子和校验
- 区域行：二级区域名 + sale/delivery 目标 + 该区域门店子和校验
- 门店行：门店号/名 + sale/delivery 目标（最细）
- 展开/折叠（默认战区展开，区域/门店折叠）
- 保存：upsert 三级（战区/区域/门店各自 upsert）
- 下载/导入模板：三级（战区/区域/门店 sheet 或层级）

### 4.5 子和校验
- 门店 sale 和 = 区域 sale 目标（差额红）
- 区域 sale 和 = 战区 sale 目标（差额红）
- 战区 sale 和 = total sale（差额红）
- delivery 同理
- 保存时 confirm 差额（如现有 saveStore confirm）

## 五、文件结构

**迁移**：
- `database/migrations/063_breakdown_three_level.sql` — targets 加 breakdown_level/war_zone/region_l2 + UNIQUE 改造 + upsert_target_breakdown/get_breakdown/check_breakdown_balance 重建（三级）+ report_achievement_v 重建（war_zone/region_l2 LATERAL）

**前端**：
- `web/app/admin/targets/[id]/page.tsx` — 总部板块布局紧凑 + 合计去重；门店板块改三级树形表
- `web/app/api/admin/targets/breakdown/route.ts` — GET 返三级（warZoneRows/regionRows/storeRows）；POST 按 level 分派
- `web/app/api/admin/targets/template/route.ts` — 模板三级（若需要）

## 六、验证

- 总部板块：布局紧凑无右边空白；合计单值 + 子和色标
- 门店三级：get_breakdown 返三级；分解页树形表（战区→区域→门店）；子和校验三级；保存 upsert 三级
- report_achievement_v：战区级/区域级 breakdown 算达成（按 war_zone/region_l2 聚合）
- 看板 sale 排行：门店级 breakdown 不变（含 64188）；战区/区域级 breakdown 可用于看板战区排行（后续）

## 七、YAGNI / 不做
- 战区名规整（"其余门店1"/"广西大区"等不规整，是 dim_branch 采集数据，不在本 spec 清理）
- 门店级以下的商品级分解
- hq 品类分解改三级（hq 只有品类 2 级，不需三级）
