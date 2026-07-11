# 报表体系 · 子系统 D：目标与达成率（设计文档）

> **状态**：设计待用户复审 → 转 writing-plans 出实现计划。
> **范围**：报表体系拆 4 子系统（A 主数据 / B 数据注册中心 / C 报表触发+取数 / D 目标达成率），本规格覆盖 **D**。承接 A（主数据维表）、C（report 汇总 + 列级脱敏 + 定时应用 + carry）。
> **架构约束**：本设计涉及修复已上线 C 的 report 表串品牌 bug（加列改 PK）+ 新增目标/指标/快照表 + 达成率视图 + web 录入与看板——按 CLAUDE.md，实现前须用户同意 + 更新 `docs/architecture.md`（§4.4 加 C 补丁 + 新增 §4.5 D）。

---

## 1. 背景与目标

用户诉求：
- 给门店下**周期销售目标**，看**达成率**——零售业核心管理动作，当前系统完全没有。
- **周期 = 纯时间段**（手选 start~end，不预设月/周/节日类型）。
- **指标做成可选项 + 固定定义**：每个指标有明确口径（销售=怎么算、拿货=怎么算），创建目标时勾选几个指标、各填目标值；可扩展（拿货待配送明细接入，还有其他指标）。
- 目标定在**门店级**，能向上汇总到战区/城市/品牌/全公司。
- **目标要有状态**：进行中（active）实时算达成率；已结束（closed）把实际值**固化成快照**留作复盘，不再随 report 变。
- 达成率要在**企微问数、定时推送、后台看板**三处看，复用 C 已建的权限/定时/carry 基建。

目标：
1. 通用目标框架：时间段 + 门店 + 多指标目标值 + 状态。
2. 指标定义层（固定口径、可扩展），MVP 内置销售（数据源就绪）+ 拿货（配送明细未接入，占位待激活）。
3. 达成率：active 实时算（实际/目标 + 进度对齐双口径），closed 读固化快照。
4. 三出口（问数/推送/看板）全读同一达成率视图，复用 C 权限（branch_nums RLS）与定时应用（C4 template）。
5. **前置修复 C 的 report 串品牌 bug**（实测发现，D 硬阻塞）。

---

## 2. 关键事实基座（均已实测，2026-07-11 生产库）

| 事实 | 来源 | 含义 |
|---|---|---|
| `report_daily_sales` PK=`(biz_date, branch_num)`，**无 system_book_code 列** | 迁移 009 | C 的隐患，见 §3 |
| 两品牌 `branch_num` **重叠 127 个**（3120=257 店、64188=128 店） | 生产 psql | report 表串品牌，distinct branch_num 才 174（应 258），数据已损 |
| `report_daily_sales` RLS：`branch_nums` claim 为 **JSONB 数组**，`'*'` 表全量 | 迁移 015 | targets/snapshots RLS 照抄 |
| `dim_branch` 层级在 **base 列**：`region_name`+`derive_war_zone()`+`branch_groups`+`city/province/district`；PK=`(system_book_code, branch_num)` | 迁移 029 | roll-up 层级字段来源 |
| `get_user_perms(p_wecom_id)` 返回 `{branch_nums, can_see_cost}` | 迁移 015/016 | 读权限现成基础 |
| report_daily_sales 列：`total_orders/total_items/total_sale/total_profit` | 迁移 009 | 销售指标 actual 用 `total_sale` |
| 现有 `/api/admin/*` route **无用户级鉴权**（service key 直调 RPC，web/lib 无 auth） | web/app/api/admin | D 录入 route 现状同（§8） |
| C4 `scheduled_reports(mode=template)` + `push_report` 强制 delivery_to + run_as RLS | 迁移 035/036 | D 推送模板复用 |
| C1 采集后自动 `/compute` 写 report，service 身份 | 架构 §4.4 | C 补丁改 /compute 聚合维度 |
| B 数据注册中心 `datasets/dataset_columns` 60s 缓存 + 自动感知 | 架构 §4.3 | 指标定义关联数据集（销售→report_daily_sales，拿货→配送明细 dataset，后接） |
| 配送明细数据源**尚未接入** | 用户 | 拿货指标 `data_ready=false` 占位，达成率暂不可算 |

---

## 3. 前置 · C 补丁（修 report 串品牌 bug，D 第一个任务）

### 3.1 问题
C1 `/compute` 从 `retail_detail` parquet（路径含 `{company}`，有品牌）聚合写 `report_daily_sales`，但后者 PK=`(biz_date, branch_num)` 不含品牌。两品牌 branch_num 重叠 127 个 → `ON CONFLICT (biz_date, branch_num) DO UPDATE` **后写覆盖先写**，64188 与 3120 同号门店销售额互串。实测 distinct branch_num=174（应 258），数据已损。D 的品牌级达成率/roll-up 全依赖 report 能区分品牌 → **D 硬阻塞**。

### 3.2 修复（架构变更，影响已上线 C）
1. 三张 report 表各加 `system_book_code TEXT NOT NULL`：
   - `report_daily_sales` PK → `(biz_date, system_book_code, branch_num)`
   - `report_daily_category` PK → `(biz_date, system_book_code, branch_num, category)`
   - `report_weekly_trend` PK → `(week_start, system_book_code, branch_num)`
2. C1 `/compute`（`services/server.js`）聚合 SQL `GROUP BY` 加 `system_book_code`（retail_detail 有 company）。
3. `report_daily_sales_v` / `_category_v` 安全视图 SELECT 列 + security_invoker 同步加 `system_book_code`。
4. **历史数据回填**：按 retail_detail parquet 重算 report 全历史（service 身份，幂等 upsert）。失败记 `compute_logs(status='failed')` → collect_fail 告警。
5. 加列后 `restart postgrest` 刷 schema 缓存。

> `dim_branch` 不受影响（PK 本就 `(system_book_code, branch_num)`）。仅 report 汇总表有此 bug。

---

## 4. 数据模型

### 4.1 `metric_definitions`（指标定义 · 开发维护口径，admin 只选不写 SQL）

```sql
CREATE TABLE IF NOT EXISTS metric_definitions (
    metric_code    TEXT PRIMARY KEY,        -- 'sale' / 'purchase' / ...
    name           TEXT NOT NULL,           -- '销售目标' / '拿货目标'
    source_dataset TEXT,                    -- 关联 B 的 datasets.name（sale→report_daily_sales，purchase→配送明细 dataset）
    value_column   TEXT,                    -- 聚合列（total_sale / 拿货量列）
    unit           TEXT,                    -- '元' / '件'
    data_ready     BOOLEAN NOT NULL DEFAULT false,  -- 数据源是否已接入（sale=true；purchase=false 直到配送明细接入）
    enabled        BOOLEAN NOT NULL DEFAULT true,   -- 是否可选（false=下线，旧目标仍可见）
    description    TEXT,
    created_at     TIMESTAMPTZ DEFAULT now()
);
```

- **内置 seed**（迁移 seed）：
  - `sale`：销售目标，source=`report_daily_sales`，value_column=`total_sale`，unit=`元`，**data_ready=true**。
  - `purchase`：拿货目标，source=`配送明细`(待接入)，value_column=待定，unit=`件`，**data_ready=false**（占位）。
- 口径 SQL（聚合模板）由开发在视图/服务里实现，**不存动态 SQL 让 admin 配**（口径复杂、易错；新指标由开发加 + 改达成率视图）。`metric_definitions` 是"指标元信息 + 是否就绪"，不是"口径引擎"。
- 配送明细接入时：`UPDATE metric_definitions SET data_ready=true, source_dataset=..., value_column=... WHERE metric_code='purchase'` + 扩展达成率视图（§4.5），框架不动。

### 4.2 `targets`（目标主表 · 时间段 + 门店 + 状态）

```sql
CREATE TABLE IF NOT EXISTS targets (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL,                  -- 目标名（如"2026年7月腾冲3店"）
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,
    start_date       DATE NOT NULL,                  -- 手选起
    end_date         DATE NOT NULL,                  -- 手选止（含）
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    closed_at        TIMESTAMPTZ,                    -- 固化时间（NULL=未关闭）
    note             TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT target_dates CHECK (end_date >= start_date),
    UNIQUE (system_book_code, branch_num, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_targets_status_dates ON targets(status, end_date);
```

### 4.3 `target_metric_values`（目标的各指标目标值 · 多指标）

```sql
CREATE TABLE IF NOT EXISTS target_metric_values (
    target_id    BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code  TEXT NOT NULL REFERENCES metric_definitions(metric_code),
    target_value NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (target_id, metric_code)
);
```

### 4.4 `target_snapshots`（已结束目标的固化实际值 · 复盘用）

```sql
CREATE TABLE IF NOT EXISTS target_snapshots (
    target_id        BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code      TEXT NOT NULL,
    actual_value     NUMERIC(14,2),           -- 固化时的实际值
    achievement_rate NUMERIC(6,2),            -- 固化时的达成率（actual/target）
    data_status      TEXT,                    -- 固化时的完整性（complete/partial/missing）
    snapshot_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (target_id, metric_code)
);
```

### 4.5 `report_achievement_v`（达成率视图 · 三态统一，security_invoker）

active + 销售指标（ready）→ 实时算 actual；active + not-ready 指标（如拿货）→ actual=NULL，标 `not_ready`；closed → 读 snapshot。

```sql
CREATE OR REPLACE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num,
    b.branch_name, derive_war_zone(b.region_name) AS war_zone, b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready,
    mv.target_value,
    -- actual：closed 读快照；active+ready(sale) 实时算；active+not_ready NULL
    CASE
      WHEN t.status = 'closed' THEN sn.actual_value
      WHEN md.metric_code = 'sale' AND md.data_ready THEN sa.sale_actual
      ELSE NULL
    END AS actual_value,
    CASE
      WHEN t.status = 'closed' THEN sn.data_status
      WHEN md.metric_code = 'sale' AND md.data_ready THEN
        CASE WHEN sa.sale_days = 0 THEN 'missing'
             WHEN sa.sale_days < (t.end_date - t.start_date + 1) THEN 'partial'
             ELSE 'complete' END
      ELSE 'not_ready'
    END AS data_status,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed,
    -- 累计达成率
    CASE WHEN mv.target_value > 0 AND t.status='closed'
         THEN sn.achievement_rate
         WHEN mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
         THEN COALESCE(sa.sale_actual,0) / mv.target_value
         ELSE NULL END AS achievement_rate,
    -- 进度对齐（仅 active；closed 无意义）
    CASE WHEN t.status='active' AND mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
              AND (LEAST(current_date, t.end_date) - t.start_date + 1) > 0
         THEN COALESCE(sa.sale_actual,0) / (
              mv.target_value * (LEAST(current_date, t.end_date) - t.start_date + 1)::numeric
              / (t.end_date - t.start_date + 1))
         ELSE NULL END AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id = t.id
JOIN metric_definitions md ON md.metric_code = mv.metric_code
LEFT JOIN dim_branch b
       ON b.system_book_code = t.system_book_code AND b.branch_num = t.branch_num
LEFT JOIN target_snapshots sn
       ON sn.target_id = t.id AND sn.metric_code = mv.metric_code
LEFT JOIN LATERAL (
    SELECT SUM(r.total_sale) AS sale_actual,
           count(DISTINCT r.biz_date) AS sale_days
    FROM report_daily_sales r
    WHERE r.system_book_code = t.system_book_code
      AND r.branch_num = t.branch_num
      AND r.biz_date BETWEEN t.start_date AND t.end_date
) sa ON md.metric_code = 'sale';   -- 仅销售指标行算（其他指标跳过 LATERAL 省开销）
```

- **security_invoker=true**：以 authenticated 查基表，走 report_daily_sales + targets 的 branch_nums RLS，双表行级裁剪防绕过。
- **多层级 roll-up 不建多视图**：靠查询 `GROUP BY war_zone/region_name/city/system_book_code` 后 `SUM(actual_value)/SUM(target_value)`。
- **新指标接入扩展**：拿货 ready 后，视图加 `purchase` 的 LATERAL（JOIN 配送明细表）+ CASE 分支。框架（表 + snapshots）不动。
- **多指标 + 多数据源视图局限**：MVP 视图硬编码 sale LATERAL（PG 视图不能动态执行 metric_definitions 的口径）。指标 ≤3 个时视图可维护；若未来指标多/口径复杂，再转 RPC `get_target_achievement(target_id)` 动态拼（§13 否决项暂不做）。

### 4.6 数据流

```
CSV/UI 录入 ──(选时间段+门店+勾选指标+填目标值)──► targets + target_metric_values
        │
        ├── active ──► report_achievement_v 实时 JOIN report_daily_sales（C1 每天更新）
        │                                ↓ 问数/推送/看板 三出口
        │
        └── end_date 过(scheduler 自动) / 用户手动"结束" ──► close_target(id)
                     ├ 算各 ready 指标 actual → target_snapshots
                     └ targets.status=closed + closed_at
                     └─► report_achievement_v 对 closed 行读 snapshot（不再实时算）
```

---

## 5. 状态与固化机制

### 5.1 三态
- **active**：`end_date >= current_date` 或未手动关。达成率实时算（§4.5）。
- **closed**：已固化。`target_snapshots` 存各 ready 指标的 actual/achievement_rate/data_status；视图对 closed 读 snapshot。
- 无 deleted 态（删除即从 targets 删，连带 metric_values/snapshots 级联）。

### 5.2 固化触发（自动 + 可提前手动）
- **自动**：scheduler 定时任务（对齐 C1 daily compute 之后，如每天 report 更新后），扫 `status='active' AND end_date < current_date` 的目标 → `close_target(id)`。
  - 延迟到 end_date **次日**固化：确保 end_date 当天数据已由 C1 采全（`end_date < current_date` 即 end_date 在今天之前）。
- **手动提前**：UI"提前结束并固化"按钮 → `close_target(id)`（用户复盘当期，不等自然到期）。
- **`close_target(target_id)`**（PG 函数 or 服务端，service 身份）：
  1. 对该目标每个 ready 指标，按 §4.5 同口径算 actual_value/achievement_rate/data_status。
  2. upsert `target_snapshots(target_id, metric_code, ...)`。
  3. `UPDATE targets SET status='closed', closed_at=now() WHERE id=$1`。
  4. not-ready 指标（如拿货未接入）：snapshot 留空 actual + data_status='not_ready'（接入后可补算重固化）。
- 固化幂等：重跑 close_target 覆盖 snapshot（手动重复盘用）。

### 5.3 重固化（复盘修正）
closed 目标支持"重新固化"（如配送明细后接入，补拿货 snapshot；或 report 历史回填后重算销售 snapshot）——重跑 close_target 覆盖。需 admin 权限。

---

## 6. 录入（改 web/，走 GHA 部署）

### 6.1 CSV/Excel 批量导入
- 路由：`POST /api/admin/targets/import`。
- 模板列：`name, system_book_code, branch_num, start_date, end_date, target_sale[, target_purchase, ...]`（每个 enabled 指标一列 `target_<metric_code>`，留空=该目标不挂此指标）。
- 服务端处理：
  1. 校验：branch_num+system_book_code ∈ dim_branch 且 is_active；start≤end；target_value≥0。
  2. upsert targets（UNIQUE 冲突更新）→ 拿 target_id → upsert target_metric_values（仅非空指标列）。
  3. **逐行校验、部分成功**：非法行入错误报告，返回 `{imported, failed, errors:[{row,reason}]}`。

### 6.2 后台 UI 表单
- 页面：`/admin/targets`。
- 新建目标：填 name / 选品牌+门店（按 war_zone/region 筛选）/ 选时间段 / 勾选指标（从 enabled 列表）→ 各填 target_value。
- 列表：按状态/战区/品牌/时间筛选；active/closed 分区；closed 可"重新固化"。
- "提前结束并固化"按钮（active 目标）。
- 调 `/api/admin/targets`（CRUD REST）。

---

## 7. 出口（一处算、三处用，全读 `report_achievement_v`）

### 7.1 实时问数（OpenClaw）
- `report_achievement_v` 注册进 `datasets`（engine=pg_table，无成本敏感列）+ `dataset_columns`。
- OpenClaw `list_datasets` 自动可见 → 用户问"本月达成率/战区排名/谁没达标/上月复盘"自动可查，按 branch_nums RLS。
- SKILL.md 加路由：目标/达成率类优先查 `report_achievement_v`；closed 的历史复盘也在该视图（status 分支）。

### 7.2 企微定时推送（复用 C4）
- 复用 `scheduled_reports(mode='template')` + `push_report`。模板 key：
  - `target_progress`：进行中目标的进度推送（如每周一推活跃目标 progress_rate）。
  - `target_recap`：目标结束后的复盘推送（close 后或定期推 closed 的 achievement_rate）。
- 模板 SQL 确定性（参数化），run_as RLS 裁剪，push_report 强制 delivery_to。

### 7.3 后台看板
- web 页读 `report_achievement_v`：active 进度条 + closed 复盘排行，按战区/品牌/指标筛选。

---

## 8. 权限

| 操作 | 权限 | 实现 |
|---|---|---|
| 读目标/达成率 | branch_nums 行级（店长看自己店） | targets/snapshots RLS + report_achievement_v security_invoker，照抄 015 JSONB policy |
| 写目标（录入/关闭/重固化） | admin 角色 | **现状：web /api/admin/* 无用户级鉴权**（service key 直调，全站通病）。MVP 录入 route 同现状，DB 层写权限给 authenticated；不新建 admin role 体系。后续 admin 鉴权加固后接入。 |

- **无列级脱敏**：销售目标不碰利润/成本 → 不需要 can_see_cost 机制。

---

## 9. 完整性 & 错误处理

- **CSV 导入**：逐行校验、部分成功、错误明细（§6.1）。
- **C 补丁历史回填**：按 retail_detail 重算 report，走 CLAUDE.md 完整性五点；失败入 compute_logs → collect_fail。
- **固化任务**：close_target 失败（如 report 当天没采到）→ 该目标保留 active + 记日志，下个周期重试；snapshot 的 data_status=partial/missing 如实标记。
- **data_status 三态 + not_ready**：active 按覆盖算 missing/partial/complete；not-ready 指标标 not_ready，避免把"没数据源"误当"达成 0"。
- **postgrest schema 缓存**：加表/列后 restart postgrest。

---

## 10. 不在范围内（YAGNI）

- 指标口径 admin 可配（动态 SQL 引擎）——口径开发维护，metric_definitions 只存元信息 + data_ready。
- 任意表达式规则引擎、目标自动分解——手录。
- 物化多层级视图 / 定时 compute 达成率表——实时视图 + GROUP BY 够。
- 企微指令批量录入——CSV/UI。
- admin 角色体系新建——复用现状 admin route。
- 拿货达成率实算——等配送明细接入（框架已预留）。

---

## 11. 实现任务（转 writing-plans 展开）

1. **C 补丁（前置）**：迁移加 system_book_code + 改 PK（report 三表）→ 改 C1 /compute 聚合 → 改 report_*_v 视图 → 历史回填 → restart postgrest → 按品牌对账验证不串。
2. **建表迁移**（幂等）：metric_definitions（+ seed sale/purchase）+ targets + target_metric_values + target_snapshots + RLS（branch_nums policy）+ GRANT。
3. **report_achievement_v 视图迁移** + security_invoker + 基表 GRANT + restart postgrest。
4. **close_target 固化函数/服务**（算 ready 指标 actual → snapshot → status=closed）。
5. **scheduler 固化任务**（daily，C1 compute 后，扫 end_date<today 的 active → close_target）。
6. **CSV 导入 route**（多指标列 + 校验 + upsert + 错误报告）+ 模板下载。
7. **后台 UI**（新建/列表/筛选/提前结束/重固化）。
8. **注册 datasets/dataset_columns**（report_achievement_v）+ SKILL.md 路由。
9. **C4 推送模板** target_progress / target_recap。
10. **后台看板页**。
11. **验证**：录测试目标（多指标）→ active 实时达成率 → 手动/自动固化 → closed 复盘读 snapshot → 三出口一致 + 权限裁剪 + C 补丁后两品牌正确。

---

## 12. 架构变更声明

- **C 补丁**：report_* 加 system_book_code 列 + 改 PK + C1 /compute 聚合 + 视图同步 + 历史回填（影响已上线 C，修真实 bug）。
- **新增**：metric_definitions + targets + target_metric_values + target_snapshots + report_achievement_v + close_target 固化 + scheduler 固化任务 + web 录入/看板 + C4 推送模板。
- 实现前更新 `docs/architecture.md`：§4.4 补 C 补丁 + 新增 §4.5 子系统 D。

---

## 13. 风险与 spike

1. **C 补丁历史回填量**：retail_detail 全历史重算 report，需评估窗口 + 分批 + 幂等。
2. **C 补丁影响面**：改 PK 影响所有读 report_* 的现有查询（C0 视图、问数路由、C4 模板），需全量回归 C 出口。
3. **视图多指标扩展性**：MVP 硬编码 sale LATERAL；指标 >3 或口径复杂时视图难维护，需转 RPC 动态拼（暂不做）。
4. **固化时机**：end_date 次日固化依赖 C1 当天采全；若采集延迟，snapshot data_status=partial，需明确"partial 也算固化完成，后续可重固化补"。
5. **拿货占位**：purchase data_ready=false，录入时可选但达成率显示 not_ready；配送明细接入时须记得翻 data_ready + 扩展视图（易遗漏，加 TODO）。
6. **admin 鉴权裸奔**（§8）：录入 route MVP 同现状，已知全局问题，不阻断 D 但记录。
7. **dim_branch 层级完整性**：region_name 缺的门店 roll-up 落 NULL 战区桶，视图/看板需处理。

---

## 14. 已评估否决的方案（避免重提）

- **定时 compute 物化达成率表**：小表 JOIN 无性能问题，多一层 compute + 表 + 完整性校验 + 冗余，YAGNI。达成率实时算 + closed 固化 snapshot 已覆盖"历史稳定"诉求。
- **物化多层级视图**：GROUP BY 一个基础视图全覆盖，多视图过度设计。
- **指标口径动态 SQL 引擎（admin 配口径）**：口径复杂易错，开发维护更稳；metric_definitions 只存元信息。
- **企微指令批量录目标**：385 数字 LLM 解析不可靠。
- **period_type 类型化周期（月/周/周末/节日）**：用户改判——纯时间段手选更简单灵活，去类型化。
