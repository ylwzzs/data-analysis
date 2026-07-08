# 监控告警体系设计（v1）

> 状态：已与用户确认设计方向（2026-07-08），待写实施计划。
> 架构登记：见 `docs/architecture.md` §八。
> 本文件是详细设计；架构文档是唯一架构源、本文为其细化。

---

## 0. 背景与现状缺口

现状探查（2026-07-08）发现的缺口，本设计逐一补齐：

| 缺口 | 现状 | 本设计 |
|---|---|---|
| 告警硬编码 | 5 个 inline `if 失败 then notifyWecom(...)`（scheduler.ts:227/241/265/313、collect-lemeng:122） | 结构化规则表，阈值/收件人/模板/级别/开关全走表 |
| token 过期只能事后发现 | `auth_credentials.expires_at` 没人填没人查；JWT `exp` 在 payload 里但只解了 `company_id`；靠 `code:-1` 才报 | `token_expire` evaluator 运行时解 JWT `exp`，临过期前预警 |
| 无失败状态机 | `collect_tasks` 无 `consecutive_failures`；只有单次失败通知，无连续失败/恢复 | `monitor_alerts` 状态表 + 连续失败计数 + 恢复通知 |
| 无应用级健康检查 | 只有容器存活探针；web 连 `/api/health` 都没有 | `service_down` evaluator 主动探活 6 个服务 |
| 通道单点 | wecom-notify 跑在 InsForge 上，InsForge 挂则告警发不出 | `notifyWecomDirect` web 直连企微兜底，仅 InsForge-down 用 |
| collect_logs 写读不匹配 ⚠️ | 代码写 `duration_ms`/`response_summary`，表只有 `result`，写入静默失败、大盘耗时列恒空 | 前置迁移：给 `collect_logs` 加列 |

---

## 1. 目标 / 非目标

### v1 目标
- 覆盖 7 个 `check_type`：`token_expire` / `collect_fail` / `request_fail` / `service_down` / `data_freshness` / `data_integrity` / `contact_sync`。
- 结构化规则表驱动：改阈值/收件人/模板/级别/开关不动代码、不发版（migration 或登库 SQL）。
- 告警降噪：同问题窗口内不重复；问题消失发"已恢复"。
- 通道鲁棒：InsForge 宕机时仍能告警。
- 只读监控大盘：实时活跃告警 + 事件流 + 健康灯 + 采集日志。

### v1 非目标（YAGNI，留 v2）
- 任意表达式规则引擎（JSONLogic/SQL 片段）——结构化枚举已够。
- 规则 CRUD 管理界面——规则走 DB/migration。
- 值班排班 / 升级链 / 静默时段（quiet hours）——小团队暂不需要。
- 指标时序存储（Prometheus 式）——告警量低，事件表足够。
- 自愈（自动重启/刷新 token）——只告警，不自动处置。

---

## 2. 引擎拓扑

**复用 web 端 node-cron（`web/lib/scheduler.ts`）**，新增「监控扫描」调度。不新增容器、不新增 edge function。

理由：
- 已有 globalThis 跨 chunk 单例 + instrumentation 自启（`web/instrumentation.ts`），web 重启后 cron 不静默停止——与现有采集调度同构。
- web 容器已有 `AGENT_API_KEY`、内网直达 duckdb/insforge/postgres/openclaw，可做应用级探活。
- edge function 60s 超时硬限 + 冷启动 + 无法持有内存态，不适合做「每分钟扫多服务」。
- 独立 monitor 容器：多一个要被监控的容器（递归），过度工程。

**扫描分桶（按 check_type 自然节奏，不引入 per-rule interval 簿记）：**

| cron（Asia/Shanghai） | 跑哪些 check_type |
|---|---|
| 每分钟 | `service_down` |
| 每 5 分钟 | `collect_fail`、`request_fail`、`token_expire` |
| 每小时 | `data_freshness`、`contact_sync` |
| 每日 03:00 | `data_integrity` |

每个桶是一次扫描循环：读 `monitor_rules WHERE check_type IN (...) AND enabled` → 逐条跑 evaluator → 更新 `monitor_alerts` → 按需发通知。防重入复用 scheduler 现有 globalThis 锁机制。

---

## 3. 数据模型

### 3.1 `monitor_rules`（规则定义）
```sql
CREATE TABLE IF NOT EXISTS monitor_rules (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  check_type VARCHAR(50) NOT NULL,            -- 7 种枚举
  target TEXT,                                 -- 规则作用对象：source_id / task_id / svc 名 / dataset 等，语义随 check_type
  threshold JSONB NOT NULL DEFAULT '{}'::jsonb,-- 如 {"before_hours":24} / {"consecutive":3} / {"failure_rate":0.3,"window_min":30}
  severity VARCHAR(20) NOT NULL DEFAULT 'high',-- critical / high / medium
  touser TEXT,                                 -- | 分隔；空或 @default = NOTIFY_DEFAULT_TUSERS
  template TEXT,                               -- 文案，支持 {占位符}
  suppress_window_seconds INT NOT NULL DEFAULT 1800,  -- 同问题重复通知间隔
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 外部配置数据一律 TEXT/VARCHAR 大长度，遵循项目约定
```

### 3.2 `monitor_alerts`（告警状态/事件——降噪与恢复核心）
```sql
CREATE TABLE IF NOT EXISTS monitor_alerts (
  id SERIAL PRIMARY KEY,
  alert_key TEXT NOT NULL UNIQUE,              -- "问题"唯一标识，如 token:src_3120 / collect:task_5 / svc:duckdb
  rule_id INT NOT NULL REFERENCES monitor_rules(id) ON DELETE CASCADE,
  check_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',-- active / resolved
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INT NOT NULL DEFAULT 1,
  last_notify_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  context JSONB NOT NULL DEFAULT '{}'::jsonb   -- 本次求值快照，供模板渲染
);
CREATE INDEX IF NOT EXISTS idx_monitor_alerts_status ON monitor_alerts(status);
```
> `alert_key` 唯一约束 → 同一问题在表里只一行，evaluator 用 upsert 更新；状态 active↔resolved 转换即事件。

### 3.3 `external_request_logs`（请求级埋点，`request_fail` 数据源）
```sql
CREATE TABLE IF NOT EXISTS external_request_logs (
  id BIGSERIAL PRIMARY KEY,
  source_id INT,
  endpoint TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status INT,
  ok BOOLEAN NOT NULL,
  latency_ms INT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ext_req_ts ON external_request_logs(ts);
-- `callLemengApi` 每次调用追加一行；定时清理 >7 天（cron 或 PG job）
```

### 3.4 ⚠️ 前置修复：`collect_logs` 加列
```sql
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS duration_ms INT;
ALTER TABLE collect_logs ADD COLUMN IF NOT EXISTS response_summary JSONB;
-- 让现有 scheduler.ts:339/342、collect-lemeng:195/198 的写入生效；修好大盘 duration 列
```

### 3.5 `monitor_state`（evaluator 运行态小表）
```sql
CREATE TABLE IF NOT EXISTS monitor_state (
  key TEXT PRIMARY KEY,            -- 如 contact_sync.last_webhook_ts / <rule>.last_evaluated_at
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 存各 evaluator 跨轮需要的运行态（回调最近时间、上次求值时间等），不进 monitor_alerts 污染事件流
```

### 3.6 权限（RLS 关闭，按角色 GRANT，遵循采集表同款）
```sql
GRANT SELECT ON monitor_rules, monitor_alerts TO anon, authenticated;  -- 大盘只读
GRANT SELECT ON external_request_logs TO authenticated;
-- 写（INSERT/UPDATE）只给 web 可信服务端用 service_role / 管理连接，不对 anon 暴露
```

---

## 4. 七个 check_type × evaluator

每个 evaluator 是纯函数：`(rule, 数据源快照) → { firing: bool, alert_key, context }`。

### 4.1 `token_expire`（主动，最大空白填补）
- 数据源：`auth_credentials.credential_data`（乐檬 JWT）。
- 求值：base64url 解 JWT payload → 读 `exp`（与现有 `decodeCompanyId` 同款，`web/lib/collect.ts:16-28`）→ `remain_hours = (exp - now)/3600`。
- threshold：`{"before_hours": 24}` → `remain_hours < before_hours` 即 firing。
- alert_key：`token:{source_id}`；context：`{brand, remain_hours, exp_at}`。
- 兜底：若 JWT 无 `exp`，回退用 `auth_credentials.expires_at`（若已填）。

### 4.2 `collect_fail`
- 数据源：`collect_logs`（按 task_id 取最近 N 条）。
- 求值：某 task 最近 `window` 条里 `status IN ('failed','partial')` 的连续段 ≥ `consecutive` → firing。
- threshold：`{"consecutive": 3, "window": 5}`。
- alert_key：`collect:{task_id}`；context：`{task_name, last_error, consecutive_count}`。

### 4.3 `request_fail`
- 数据源：`external_request_logs`（依赖 §3.3 埋点）。
- 求值：窗口 `window_min` 内 `ok=false` 占比 > `failure_rate` → firing。
- threshold：`{"failure_rate": 0.3, "window_min": 30, "min_samples": 5}`（样本不足不触发，防误报）。
- alert_key：`req:{source_id}`；context：`{source_name, failure_rate, samples, recent_errors}`。

### 4.4 `service_down`（应用级探活，5s 超时）
- 探活清单（一条规则 `target` = 一个服务名）：
  - `web` → `GET http://localhost:3000/api/health`（**新增端点**）
  - `duckdb` → `GET http://duckdb:9000/health`（已有）
  - `insforge` → `GET http://insforge:7130/api/health`
  - `postgres` → `SELECT 1`
  - `deno` → `GET http://deno:7133/health`
  - `openclaw` → `GET http://openclaw:18789/healthz`
- 求值：任一探活失败（超时/非 2xx/连接拒绝）→ firing。
- threshold：`{}`（无阈值，二值）。
- alert_key：`svc:{name}`；context：`{name, detail, http_status, latency_ms}`。
- **特殊：`svc:insforge` firing 时走兜底通道**（§6.2）。

### 4.5 `data_freshness`
- 数据源：PG `report_daily_sales`/`report_daily_category` 最大 biz_date；DuckDB parquet 最新日期（按 company_id）。
- 求值：最新数据日期距今 > `stale_hours` → firing。
- threshold：`{"stale_hours": 2, "dataset": "report_daily_sales"}`。
- alert_key：`fresh:{dataset}`；context：`{dataset, latest_date, age_hours}`。

### 4.6 `data_integrity`（最重，每日一次）
- 数据源：DuckDB 明细 count（**web 复用现有 DuckDB 调用，即 `DUCKDB_URL`，与 scheduler/collect 同款**）vs PG 汇总数 `SUM`。
- 求值：`|明细 - 汇总| / 明细 > threshold.diff_rate` → firing。
- threshold：`{"dataset": "report_daily_sales", "diff_rate": 0.01, "date": "yesterday"}`。
- alert_key：`integrity:{dataset}:{date}`；context：`{dataset, date, detail_count, summary_count, diff_rate}`。

### 4.7 `contact_sync`
- 数据源：`org_users.updated_at` MAX（全量同步落点）；回调最近时间存 `monitor_state['contact_sync.last_webhook_ts']`（webhook route 每次收到事件时 upsert）。
- 求值：距上次成功同步 > `max_age_hours` → firing。
- threshold：`{"max_age_hours": 30}`（全量每日 03:17，超 30h 必异常）。
- alert_key：`contact_sync`；context：`{last_full_sync_at, last_webhook_at, age_hours}`。

---

## 5. 告警生命周期与降噪

```
evaluator(rule) → { firing, alert_key, context }
  ├─ firing=true:
  │     upsert monitor_alerts(alert_key)
  │       status 保持/置 active；occurrence_count++；last_seen_at=now；context=快照
  │     若 (last_notify_at IS NULL) OR (now - last_notify_at >= rule.suppress_window_seconds):
  │         dispatch_notify(rule, context)   → 主通道 §6.1
  │         last_notify_at = now
  ├─ firing=false AND 存在 status=active 同 alert_key:
  │     status=resolved；resolved_at=now
  │     dispatch_notify(rule, context, recovered=true)  → 发「已恢复」
  └─ firing=false AND 无 active 行: 不动作
```

- **降噪**：`suppress_window_seconds` 默认 30min，同问题窗口内不重复发。
- **恢复通知**：active→resolved 发一次"✅ 已恢复"。
- **严重度**：仅标签 + 大盘过滤 + 是否 @ 全员（critical 可配 `touser=@all`）；v1 不做升级链。
- **收件人**：`touser` 为空或 `@default` → 展开 `process.env.NOTIFY_DEFAULT_TUSERS`。

---

## 6. 通知出口

### 6.1 主通道：`functions/wecom-notify`（复用）
- 规则 `template` 用 `{占位符}`，evaluator 用 context 渲染后送 `notifyWecom()`（web 薄客户端）。
- msgtype 默认 markdown；critical 可用 textcard 带跳转链接（指向大盘）。
- 模板示例：
  - `token_expire`：`🔴 [{severity}] 乐檬-{brand} token 将在 {remain_hours}h 后过期，请尽快更新`
  - `service_down`：`🔴 [{severity}] {svc} 不可达（{detail}），影响：{impact}`
  - 恢复：`✅ [{severity}] {alert_key} 已恢复（持续 {duration}）`

### 6.2 兜底通道：`notifyWecomDirect`（web 直连企微，仅 InsForge-down）
- 触发条件：`service_down` evaluator 探到 `svc:insforge` 不可达。
- 实现：web 用 `WECOM_OPS_SECRET` + `WECOM_OPS_AGENT_ID` + `WECOM_CORP_ID` **直连** `https://qyapi.weixin.qq.com/cgi-bin/message/send`，绕开 InsForge。
- **env 三处检查（CLAUDE.md 教训）**：web 容器需有 `WECOM_OPS_SECRET`/`WECOM_OPS_AGENT_ID`/`WECOM_CORP_ID`（通讯录回调 route 已用前两者，确认 `WECOM_OPS_AGENT_ID` 也在 compose env）。
- 范围：仅这一条路径直连；其余全走 wecom-notify。避免双通道逻辑泛滥。

---

## 7. 大盘（只读，新建 `/admin/monitor`）

- **实时活跃告警**：`monitor_alerts WHERE status='active' ORDER BY severity, last_seen_at DESC`，显示首次发现/持续时长/发生次数/context 摘要。
- **事件流**：最近 N 条状态变更（含 resolved），时间线展示。
- **健康灯矩阵**：7 个 check_type 各自最近一次求值结果（绿=无 active / 红=有 active / 灰=未启用）。
- **采集日志**：接 `collect_logs`（复用 `/admin/sources/monitor` 现有逻辑，duration_ms 修好后有耗时列）。
- 数据走 PostgREST（`@insforge/sdk` + ANON_KEY，表已 GRANT SELECT）。

---

## 8. 错误处理 / 鲁棒性

- **per-rule try/catch**：单条规则/evaluator 抛错不能拖垮整轮扫描；捕获后写一条 `monitor_alerts`（`check_type='evaluator_error'`, `alert_key='eval:{rule_id}'`）自我监控。
- 探活统一 5s 超时；DB 查询带超时。
- `external_request_logs` 定时清理 >7 天。
- 通知发送失败不回滚告警状态（已落 `monitor_alerts`），下个窗口重试发；`last_notify_at` 仅成功才更新。
- 扫描循环防重入：复用 scheduler `globalThis.__schedulerState` 同款锁。
- evaluator 是纯函数 + 数据源快照注入，便于单测。

---

## 9. 测试策略

- **evaluator 单测**：每个 check_type 一个，造 fixture（假 collect_logs / 假 JWT 含 exp / mock 探活响应 / 假 request_logs），断言 firing/alert_key/context。
- **生命周期单测**：active upsert → suppress 窗口内不重发 → 恢复转 resolved + 发恢复通知。
- **端到端**：插一条必触发的规则（如 `collect_fail consecutive=1` + 造一条 failed log）→ 跑一轮扫描 → 断言 `monitor_alerts` active + 企微收到（mock wecom-notify）→ 改数据恢复 → 断言 resolved 通知。
- **兜底通道测**：mock insforge 探活失败 → 断言走 `notifyWecomDirect`（mock 企微 API）。

---

## 10. 落地分期（建议顺序）

1. **前置修复**：`collect_logs` 加列迁移 → 验证大盘 duration 有值。
2. **建表**：`monitor_rules` / `monitor_alerts` / `external_request_logs` / `monitor_state` + 权限。
3. **引擎骨架**：scheduler 加 4 个扫描桶 cron + 防重入 + per-rule try/catch + 生命周期/降噪。
4. **evaluator 逐个**：先 `service_down`（含 `/api/health` 新端点 + InsForge 兜底通道）→ `token_expire`（解 exp）→ `collect_fail` → `data_freshness` → `contact_sync`（含 webhook route 写 `monitor_state`）→ `data_integrity`。
5. **大盘** `/admin/monitor`。
6. **种子规则**：migration 插入 7 类默认规则（阈值/收件人/模板）。
7. **埋点**：`callLemengApi` 写 `external_request_logs`（`request_fail` 前置）。

---

## 11. v2 留口

- per-rule `check_interval`（覆盖 check_type 默认节奏）。
- 规则 CRUD 管理界面（表单/试跑/手动静音）。
- 静默时段 / 值班排班 / 升级链。
- 指标时序存储 + 趋势图（Grafana 式）。
- 自愈动作（token 刷新、服务重启）。
