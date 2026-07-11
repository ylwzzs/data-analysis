# 子系统 C 设计：标准报表自动触发 + 问数权限闭环 + 定时应用

> 报表体系第 3 子系统。承接 A（主数据，已落地）、B（数据注册中心，已落地）。
> 本 spec 在 B 基础上补齐「报表自动算 + 问数权限全链路（行级+列级）+ OpenClaw cron 定时应用 + carry 维表」四件事，并解决「定时任务传不进身份」的硬矛盾。

## 1. 背景与目标

用户诉求：
- 采集天天跑，但报表没人算（手动 /compute 偶发，已停在 7-05，落后 5 天）。
- 问数权限要**全盘**：行级（门店）+ 列级（成本/利润）必须闭环，不能明细脱敏、汇总裸奔。
- 充分利用 **OpenClaw cron** 做定时应用（自然语言建定时、灵活），但定时触发传不进用户身份 → 权限系统拦截（现存「建水3店21点业绩」cron 已踩坑禁用）。
- 明细要能 JOIN 维表（按战区/品类归类），且维表新鲜度要对齐 PG（定时 + 变更回调，跟通讯录同步一个逻辑）。

目标：
1. 采集后**自动** /compute，报表持续新鲜。
2. 补齐 report_* 列级成本脱敏（当前裸奔），确立 user/service 双身份模型。
3. 用 OpenClaw cron 承载定时应用，**在我们可控层**补 run_as 身份注入，安全且灵活。
4. carry 维表（**物化 parquet 路线**）让明细支持维度 JOIN，定时+变更回调双触发同步。

## 2. 关键事实基座（均已查证，非臆想）

| 事实 | 来源 | 含义 |
|---|---|---|
| /compute 无自动触发，report_daily_sales/category 停在 7-05，weekly_trend 0 行 | 生产 psql | C1 是真缺口 |
| A 维表已落地：dim_branch 385、dim_item 40963、dim_region 19、dim_item_ext 空壳 | 生产 psql | carry 前置满足 |
| `execute_sql_rls` 是全 SELECT 透传 | 迁移 015 | 汇总级维度 JOIN 今天就能跑（PG 引擎内） |
| report_* **只有行级 RLS，无列级保护**；total_profit 对 can_see_cost=false 裸奔 | 迁移 015 | 列级安全缺口（必修） |
| DuckDB postgres extension 在天翼云服务器可装 | 服务器 spike | 曾评估 attach 路线已否决（§9）；物化导出用 pgPool，不涉及 attach |
| **pg_duckdb 评估否决**：谓词下推✅，但 read_parquet 走 DuckDB 引擎**读不到 PG GUC**（`current_setting` 报 `unrecognized configuration parameter`），列级/行级安全还是 agent-query 应用层拼 claim，没简化 | 本地容器实测 | 统一引擎假象破灭，pg_duckdb 不采纳（详见 §9） |
| OpenClaw cron turn 天生不带身份：`requesterSenderId` 只来自 inbound；`src/cron` 全目录无 senderId | openclaw 源码 tool-types.ts / cron/* | sessionTarget 解决不了身份 |
| plugin ctx.sessionKey = agentSessionKey，cron turn 含 `cron:<jobid>:` 段 | 源码 + run_log | plugin 能 parse job_id 反查绑定 |
| 通讯录同步 = scheduler cron（每天 03:17）fetch function 全量兜底 + 防重入，纯定时 | scheduler.ts registerContactSyncJob | carry 触发照搬此模式 + 变更回调 |

## 3. 身份与权限模型（核心）

### 3.1 两类身份

| 身份 | 来源 | branch_nums / can_see_cost | 只能干什么 |
|---|---|---|---|
| **用户身份** | OpenClaw 透传 requesterSenderId **或** 定时应用绑定的 run_as | 该用户 `get_user_perms` | **给人看数据**（实时问数、定时推送）|
| **服务身份** | serviceJwt（sub=agent-query，无 perms claim） | 无（全量）| **算+写**（/compute 写 report_*、carry-dims 导出、读字典、写审计）|

**核心不变量**：面向人的数据出口**永远带用户 perms**；服务身份**绝不直接当给人看敏感数据的出口**——只产出全量聚合/维表，再被权限裁剪。

### 3.2 行级 + 列级双保险

| 数据 | 行级 branch_nums | 列级成本 |
|---|---|---|
| 明细 retail_detail（DuckDB） | ✅ view builder WHERE（已实现）| ✅ view builder CASE（已实现）|
| 汇总 report_*（PG） | ✅ RLS policy（已实现）| ❌→✅ **补：安全视图 `report_*_v`** 按 claim 脱敏 |
| 维表 dim_*（carry parquet） | 不裁（字典，所有人可见）| — |

**列级补法**：DB 建 `report_daily_sales_v` / `report_daily_category_v` / `report_weekly_trend_v` 安全视图，成本列按 `current_setting('request.jwt.claims.can_see_cost')` CASE 脱敏。**权威在 DB、防绕过**：原表收回 anon/authenticated SELECT，只留 service 写 + 视图读。agent-query PG 路径改查 `_v`，并用 B 的 `costColumns`（dataset_columns.is_sensitive）应用层兜底。

> 注：明细 retail_detail 走 DuckDB 引擎，权限由 agent-query 应用层拼 claim（现状，pg_duckdb 实测证明 DuckDB 引擎读不到 PG GUC，无法靠 PG 原生）。明细侧维持现状即可。

### 3.3 run_as 机制（解决定时任务无身份）

OpenClaw cron turn 的 `ctx.requesterSenderId` **恒空**（源码证实）。解法在我们可控层，两段：

**① 绑定层（后端可信写入）**：`scheduled_reports` 表存定时应用，含 `cron_job_id` + `run_as`（=创建者企微 userid）。创建定时应用的后端逻辑在**可信会话**（企微 inbound，requesterSenderId 有值）里执行：调 OpenClaw cron 创建 API 拿 job_id → 写 (job_id → 创建者) 绑定。**run_as 永远来自可信会话，非 LLM 参数**。

**② 解析层（agent-query 反查）**：plugin 的 `query_retail_data` 在 requesterSenderId 为空时，把 `ctx.sessionKey` 作为 `cronSessionKey` 透传给 agent-query。agent-query 检测 cronSessionKey 含 `cron:<jobid>:` → parse job_id → 查 `scheduled_reports.run_as` → 作为 userId 走 `get_user_perms` → RLS + 脱敏。

链路：
```
OpenClaw cron 触发(isolated) → agent turn → query_retail_data({sql})
  → plugin: requesterSenderId 空, 透传 cronSessionKey=ctx.sessionKey
  → agent-query: parse job_id → 查 scheduled_reports.run_as
  → get_user_perms(run_as) → branch_nums/can_see_cost
  → runPg/runDuckdb 按 run_as 权限裁剪+脱敏 → 返回
```

### 3.4 攻击面分析（run_as 三道闸）

| 闸 | 保证 |
|---|---|
| ① run_as 不在 LLM 可填参数 | `query_retail_data.parameters = {sql}`，无 run_as 字段；run_as 来自 scheduled_reports 表（后端写），plugin 不读 LLM 文本 |
| ② run_as = 创建者，不能指定他人 | 创建定时应用时 run_as 钉死=可信会话的 requesterSenderId；LLM 在 payload 写「以张总身份」完全无效（agent-query 只认表里绑定值） |
| ③ scheduled_reports 表 RLS + 列约束 | 用户只能管自己的定时应用（WHERE owner=current_user）；CHECK 防越权改 run_as |

**给人推送数据必须按 run_as 查**，禁止服务身份查全量给 LLM（否则 LLM 上下文越权）。

## 4. 子设计

### C0 安全闭环（必修，前置）
- 建 `report_*_v` 脱敏视图，原表收回 SELECT，agent-query PG 路径改查 `_v`。
- 明确 service/user 身份边界文档化（agent-query 注释 + architecture.md）。

### C1 采集后自动 /compute
- 在 `web/lib/scheduler.ts` 的 retail 分支末尾，`verified=success/partial` 后按 `params.dates` 调 duckdb-service `/compute`：
  - daily_sales + daily_category：用采集 `[from,to]`。
  - weekly_trend：滚动窗口（采集日往回 8 周，conflict_keys upsert 幂等）。
- compute 失败**不阻塞**采集（parquet 已落、数据没丢）；记独立 `compute_logs` + 复用 collect_fail 企微告警思路。
- 身份：service（无 perms），算全量写 report_*，查询时裁剪——**无身份矛盾**。

### C2 OpenClaw 取数路由（纯引导）
- 复用 B 的 `list_datasets`（字典实时喂模型）。SKILL.md 加优先级规则：「能命中 report_* 汇总表就别扫 retail_detail 明细；历史总额/排名/趋势用汇总，今天/最近/单笔用明细」。
- **不做**网关自动重写（YAGNI）。

### C3 carry 维表（物化 parquet + 定时/变更回调双触发）

**为什么物化不 attach**：维表小（门店 385/商品 4 万/战区 19）、变更慢；物化**天然无绕过风险**（DuckDB 查询路径完全不连 PG，碰不到 report_*），而 attach 要严防账号授权过多 + 读写分离。

**数据流**：PG dim_*(+ext) → 导出 parquet 到 S3 → DuckDB `read_parquet` 维表 parquet，明细 JOIN。

**① 导出端点 `carry-dims`**（duckdb-service 加端点，service 身份）：
- duckdb-service 已有 `pgPool`（连 PG 写 report_* 的 service 账号，/compute 在用），carry-dims 用它 `SELECT dim_*(+ext)` → DuckDB `COPY TO parquet` 写 S3（`s3://lemeng-datasource/dims/dim_*.parquet`）。**全程不用 attach、DuckDB 不连 PG**（数据流：pgPool 读 → Node → DuckDB 造 parquet）。
- 导出范围：dim_branch(+ext 战区)、dim_item(+ext)、dim_region、canonical_product（视图）。幂等全量覆盖。

**② 触发（对齐通讯录同步 + 变更回调）**：
- **定时兜底**：scheduler `registerCarryDimsJob`，cron（如 `33 4 * * *`，避开通讯录 03:17）fetch `/carry-dims`，防重入（同通讯录模式）。
- **变更回调**（fire-and-forget）：
  - `collect-branches` / `collect-items` 采集 `verified` 后 → fetch `/carry-dims`。
  - 未来 dim_*_ext 编辑 route（A 的 ext 维护 UI）成功后 → fetch `/carry-dims`。

**③ 查询**：agent-query view builder 建 TEMP VIEW：`retail_detail`（read_parquet retail_glob）+ `dim_branch`/`dim_item`/`dim_region`（read_parquet 维表 parquet）。模型 SQL 自由 `JOIN dim_*`，按需 JOIN。行级裁剪仍在 retail_detail 侧（branch filter 不变）；维表字典全可见。

**④ 新鲜度**：维表变 → 回调/定时 carry → parquet 覆盖 → 下次查询 read_parquet 读新（DuckDB 每查询重读 parquet，无缓存陈旧）。

**⑤ 注册表**：datasets 登记 dim_* 的 `source`=维表 parquet glob、`engine=duckdb_view`、`carry_enabled=true`。

### C4 定时应用（OpenClaw cron 承载 + run_as + 模板/SQL 分层）

**数据模型**：`scheduled_reports(id, owner_wecom_id, cron_job_id, name, mode, template_key, query_intent, delivery_to, run_as, enabled, created_at)`。

**创建入口（MVP）**：企微里对 bot 说「每天9点推战报」→ agent 调 `create_scheduled_report` 工具，**创建时一次性判断**（非每次执行）：
- 命中标准报表 → `mode='template'` + `template_key`（系统内置：daily_sales_brief/weekly/category_rank）。
- 个性化需求 → `mode='sql'` + `query_intent`（自然语言意图）。
- 后端在可信会话建 OpenClaw cron job（isolated + payload）+ 写 scheduled_reports（run_as=创建者、delivery_to=创建者）。
- 工具 parameters 只含「查什么/何时/推到哪」，**无 run_as/delivery_to 字段**（后端钉死=调用者）。

**执行（cron turn 按 mode 分叉）**：
- **mode=template（可靠）**：执行 template_key 的参数化 SQL（读 report_*_v，按 run_as 自动 RLS+_v 裁剪脱敏）→ 模板格式渲染。**LLM 不碰 SQL/数字**。
- **mode=sql（灵活）**：agent 按 query_intent 写 SQL → query_retail_data（plugin 透传 cronSessionKey 反查 run_as）→ 权限裁剪+脱敏 → agent 渲染（受"绝不编造"约束）。
- **两路汇合** → `push_report`（**强制用表里 delivery_to，不信 LLM 解析的 to**）。

**管理**：scheduled_reports RLS（owner 维度），用户可查/改/删自己的；删除时同步删 OpenClaw cron job（防孤儿 cron 反查 run_as 失败）。MVP 限制可建定时应用的用户/部门（防滥用）。

## 5. 数据模型变更

```sql
-- C0: 汇总表脱敏视图（成本列按 claim 脱敏；原表收回 SELECT）
CREATE VIEW report_daily_sales_v AS
SELECT biz_date, branch_num, branch_name, total_orders, total_items, total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_sales;
-- report_daily_category_v / report_weekly_trend_v 同理（按各自成本列）
REVOKE SELECT ON report_daily_sales FROM anon, authenticated;
GRANT SELECT ON report_daily_sales_v TO authenticated;
-- report_*_v 进 datasets 注册表（engine=pg_table，成本列 is_sensitive=true）；原表移出 exposed

-- C4: 定时应用绑定
CREATE TABLE scheduled_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wecom_id TEXT NOT NULL,          -- 创建者（=run_as）
  cron_job_id TEXT NOT NULL,             -- OpenClaw cron job id（反查键）
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('template','sql')),
  template_key TEXT,                     -- mode=template 时（daily_sales_brief/weekly/category_rank...）
  query_intent TEXT,                     -- mode=sql 时（自然语言意图）
  delivery_to TEXT NOT NULL,             -- 推送目标企微 userid（push_report 强制读）
  run_as TEXT NOT NULL,                  -- = owner_wecom_id（钉死）
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT run_as_is_owner CHECK (run_as = owner_wecom_id),
  CONSTRAINT mode_fields CHECK (
    (mode='template' AND template_key IS NOT NULL) OR
    (mode='sql' AND query_intent IS NOT NULL)
  )
);
CREATE POLICY scheduled_reports_owner_isolation ON scheduled_reports
  FOR SELECT TO authenticated USING (owner_wecom_id = current_setting('request.jwt.claims.sub', true));

-- C1: compute 执行日志
CREATE TABLE compute_logs (
  id BIGSERIAL PRIMARY KEY,
  report_type TEXT NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL,              -- success | failed
  rows_written INTEGER,
  duration_ms INTEGER,
  error TEXT,
  triggered_by TEXT,                 -- 'collect:<task_id>' | 'manual' | 'cron:<job_id>'
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
-- compute 失败 → status=failed → 接入 collect_fail 监控告警（完整性规则第5点）

-- C3: datasets 登记 dim_* 为 duckdb_view（carry_enabled=true）
-- UPDATE datasets SET engine='duckdb_view', source='s3://lemeng-datasource/dims/dim_branch.parquet', carry_enabled=true WHERE name='dim_branch'; （dim_item/dim_region/canonical_product 同理）
-- 新增 carry_logs（可选）：记每次 carry-dims 导出的维表/行数/触发源
```

## 6. 不在范围内（YAGNI）
- 网关自动 SQL 重写（C2 走纯引导）。
- carry attach 路线 / pg_duckdb 统一引擎（均评估否决，见 §9）。
- 多订阅者广播（MVP 一个定时应用一个 run_as=创建者；广播场景后续）。
- 定时应用管理后台 UI（MVP 企微指令 + DB 直查；后台后续）。
- 定时模板可视化编辑器（MVP 代码内置几个模板）。

## 7. 风险与待 spike
1. **plugin→agent-query 透传 cronSessionKey**：data-query plugin `execute` 加透传字段；agent-query 入口加 cronSessionKey 解析分支。（低风险）
2. **OpenClaw cron 创建 API**：后端如何可编程创建 cron job（gateway API / plugin tool）。需 spike。（中风险，C4 前置）
3. **carry-dims 导出端点**：duckdb-service 加 /carry-dims（pgPool 读 dim_* → DuckDB COPY parquet S3），复用现有 pgPool，无需 attach/新账号。（低风险）
4. **dim_*_ext 编辑 route**（carry 变更回调挂载点之一）：A 的 ext 维护 UI 待建；MVP 先挂采集回调（collect-branches/items），ext 回调随 A 补。
5. **report_*_v 视图上线需 restart postgrest**（schema 缓存坑，CLAUDE.md 已记）。

## 8. 架构变更声明
本设计涉及：新增定时应用框架（scheduled_reports + OpenClaw cron 集成 + run_as 反查）、report_* 列级脱敏视图、carry 维表物化（duckdb-service /carry-dims + 维表 parquet + 定时/回调同步）、采集后自动 /compute。**实现前须同步更新 `docs/architecture.md` §4**（问数权限闭环 + 定时应用 + carry + 自动算表）。

## 9. 已评估否决的方案（避免重提）

**pg_duckdb（PG 连 DuckDB 统一引擎）—— 否决**。本地容器实测：
- ✅ 谓词下推：read_parquet 视图 + WHERE，parquet scan 只读匹配行（100万中1万），下推生效。
- ❌ **列级/行级安全不能靠 PG 原生**：read_parquet 走 DuckDB 引擎，视图里 `current_setting('request.jwt.claims.*')` 报 `Catalog Error: unrecognized configuration parameter`（DuckDB 引擎读不到 PG GUC）。纯 `SELECT current_setting(...)` 能行只是因 pg_duckdb 把纯 PG 函数查询转发回 PG；一旦和 read_parquet 混合（必须 DuckDB 引擎），GUC 读不到。→ 明细权限还是要 agent-query 应用层拼 claim（同现状），没简化。
- ❌ 动生产 PG：生产 PG15.18 无现成 pg_duckdb 镜像（官方 PG18），要源码编译/升级 + 重启整个生产库。
- **结论**：唯一净收益（carry 便利）不值得动生产 PG，且权限没简化。否决，carry 走物化。

**carry attach（DuckDB 常驻 attach PG）—— 否决**。绕过 report_* 全量利润的风险靠账号 GRANT 收口 + duckdb-service 读写分离，工程复杂；物化天然无此风险且维表小变更慢，物化更合适。
