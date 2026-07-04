# 数据采集系统架构文档

> **重要：架构确定后不得擅自变更，任何调整需经用户同意**

## DuckDB 三角色架构

DuckDB 服务承担三个角色：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DuckDB 服务                                      │
│                         端口：9000（内网）                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  角色 1：数据转换                                                │   │
│  │  端点：POST /transform（全量覆盖）/ POST /merge（增量合并）      │   │
│  │  输入：JSON 明细数据 + 配置                                      │   │
│  │  处理：校验、去重、分片；/merge 读旧 parquet+并新+去重写回       │   │
│  │  输出：Parquet 写入 OOS（all.parquet 为权威文件）                │   │
│  │  触发：采集完成后调用（全量→/transform，增量→/merge）            │   │
│  │  状态：✅ 已实现                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  角色 2：计算引擎（标准报表）                                     │   │
│  │  端点：POST /compute                                             │   │
│  │  输入：报表类型 + 日期范围                                       │   │
│  │  处理：read_parquet(OOS) → 聚合计算                              │   │
│  │  输出：计算结果写入 PostgreSQL 汇总表                            │   │
│  │  触发：采集完成后自动触发                                        │   │
│  │  状态：⏳ 待实现                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  角色 3：个性化查询（OpenClaw）                                   │   │
│  │  端点：POST /query                                               │   │
│  │  输入：SQL（OpenClaw 生成）                                      │   │
│  │  处理：鉴权 → read_parquet(OOS) → 执行 SQL                       │   │
│  │  输出：查询结果返回 OpenClaw                                     │   │
│  │  触发：用户自然语言提问                                          │   │
│  │  鉴权：⏳ 待讨论                                                 │   │
│  │  状态：⏳ 待实现                                                 │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 数据源与采集任务架构（两层）

```
数据源（data_sources）          ← 持有鉴权：token / appid+secret（按 auth_type）
│   粒度 = (外部系统, 品牌)。乐檬一个账号可管多个品牌(company)，
│   但 token 按 company 隔离：JWT payload 的 company_id 即品牌，登录不同品牌拿到不同 token。
│   多品牌 token 可同时有效（已实测：切换品牌不互顶）。
├── 乐檬-3120（auth_type=bearer，token 的 company_id=3120，~5 天有效）
│   ├── 采集任务：商品档案采集     ← 共用上层 token
│   └── 采集任务：销售订单明细采集 ← 共用上层 token
├── 乐檬-64188（auth_type=bearer，token 的 company_id=64188）
│   └── 采集任务：销售订单明细采集 ← 共用上层 token
└── 金蝶（未来，auth_type=kingdee，credential_data 存 appid/secret）
    └── 采集任务：…                ← 共用上层鉴权
```

- **鉴权归属数据源**：一个(系统,品牌)组合 = 一个数据源，其下所有采集任务共用该源的唯一 token。
  杜绝「同系统拆多源、各存一份 token」导致的一活一死。
- **品牌由 token 决定，非请求参数**：乐檬 API 的品牌(company)写在 JWT 的 `company_id` claim 里，签名 `scopeIds` 与品牌无关（恒为空）。换品牌 = 换 token（重新登录），不是加请求参数。
- **branch_nums 传空 = 该品牌全部门店**：`branch_nums:[]` 返回当前 token(company) 维度的全量（实测 3120=13118、64188=8134/天）。无需为每个品牌枚举门店号。
- **scheduler 读凭证**：按 `collect_tasks.source_id` 取 `auth_credentials`，同源任务自然共用。
- **扩展约定**：新增源类型（金蝶等）时，scheduler 按 `data_source.auth_type` 分派鉴权方式（当前仅 bearer/token）。

## 数据流架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  采集数据                                                                │
│  来源：乐檬 API（每天几万条）                                            │
│       │                                                                 │
│       ▼                                                                 │
│  Next.js API Route                                                       │
│  端点：/api/admin/collect-lemeng                                         │
│  功能：调用乐檬 API + DuckDB transform                                   │
│       │                                                                 │
│       ▼                                                                 │
│  DuckDB /transform                                                       │
│  输出：OOS Parquet（明细数据，60天归档）                                 │
│       │                                                                 │
│       ├──► DuckDB /compute（自动触发）                                   │
│       │        │                                                        │
│       │        └──► PostgreSQL 汇总表                                    │
│       │              ├── report_daily_sales                             │
│       │              ├── report_daily_category                          │
│       │              └── report_weekly_trend                           │
│       │                                                                 │
│       └──► 前端报表                                                      │
│              └──► PostgREST                                              │
│              └──► PostgreSQL（秒级响应，500并发）                        │
│                                                                         │
│  用户自然语言提问                                                        │
│       │                                                                 │
│       ▼                                                                 │
│  OpenClaw                                                                 │
│  功能：意图解析 + SQL 生成                                               │
│       │                                                                 │
│       ▼                                                                 │
│  DuckDB /query                                                           │
│  功能：鉴权 + read_parquet(OOS) + 执行 SQL                              │
│       │                                                                 │
│       ▼                                                                 │
│  OpenClaw                                                                 │
│  输出：自然语言回答                                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## OOS 存储（冷数据）

```
天翼云 OOS
└── Bucket: lemeng-datasource
    └── lemeng/retail_detail/{company_id}/{date}/   ← company_id 从 token payload 解出，按品牌分区
        ├── all.parquet              → 该品牌当日全部明细
        ├── branch_num_N.parquet     → 按门店分片
        └── ...

数据量：每天几万条（按品牌独立计），保留 60+ 天
格式：Parquet + zstd 压缩
用途：归档 + DuckDB 计算 + 个性化查询
说明：按 company_id 分区，使各品牌采集任务各写各的文件（杜绝跨品牌 /merge 写竞争、
      order_no 跨品牌歧义）；跨品牌查询用 glob：read_parquet('.../retail_detail/*/{date}/all.parquet')。
      历史数据（2026-07-04 的 3120）曾写在无 company_id 的旧路径 lemeng/retail_detail/{date}/，
      迁移到新路径或由下次全量核对重写覆盖。
```

## PostgreSQL 存储（热数据）

```sql
-- 每日门店销售汇总（几万条明细 → 几百条汇总）
CREATE TABLE report_daily_sales (
    biz_date DATE NOT NULL,
    branch_num INTEGER NOT NULL,
    branch_name VARCHAR(100),
    total_orders INTEGER,
    total_items INTEGER,
    total_sale DECIMAL(12,2),
    total_profit DECIMAL(12,2),
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (biz_date, branch_num)
);

-- 每日品类汇总
CREATE TABLE report_daily_category (
    biz_date DATE NOT NULL,
    category VARCHAR(50) NOT NULL,
    total_items INTEGER,
    total_sale DECIMAL(12,2),
    total_profit DECIMAL(12,2),
    PRIMARY KEY (biz_date, category)
);

-- 周趋势汇总
CREATE TABLE report_weekly_trend (
    week_start DATE NOT NULL,
    branch_num INTEGER NOT NULL,
    total_sale DECIMAL(12,2),
    growth_rate DECIMAL(5,2),
    PRIMARY KEY (week_start, branch_num)
);
```

用途：前端报表热查询（秒级响应，500并发）

## 定时调度

```
Next.js web 容器
└── lib/scheduler.ts
    ├── node-cron 注册任务
    ├── timezone: Asia/Shanghai
    ├── server 启动时自初始化（web/instrumentation.ts 的 register() 调 ensureSchedulerInitialized，
    │   带退避重试；web 容器重启后 cron 不再静默停止）
    ├── 首次 /api/admin 调用兜底初始化（仍保留）
    └── 端点：GET/POST /api/admin/scheduler/reload

任务配置：
└── collect_tasks 表
    ├── schedule_cron：cron 表达式（Asia/Shanghai）
    ├── enabled：是否启用
    ├── params：任务参数（task_type / date_mode / page_size / 运行时水位线 watermark）
    └── 防重入：runningTasks 集合，并发触发跳过

两种采集模式（零售明细）：
├── 全量（full）：新一天 / 距上次全量≥55min / 无水位线 时触发
│   └── count → 全部分页 → DuckDB /transform 覆盖 all.parquet（每小时核对一次）
└── 增量（incremental）：其余每 5 分钟触发
    └── count → 若总数>水位线则从上次页（重叠1页）续采尾部 → DuckDB /merge 合并去重写回

水位线 watermark（写回 collect_tasks.params）：{ date, last_count, last_full_ts }
├── 仅落盘成功才推进 last_count；失败保持旧值，下次多重叠（安全）
├── 跨天：date≠今天 → 自动 full，新分区 lemeng/retail_detail/{新日期}/
└── 当天数据：params.date_mode=today → 运行时算 [今天,今天]（dates 必须双元素区间）
```

## 鉴权方案

### PostgreSQL 报表鉴权（已确认）

```
企微通讯录同步 → 用户归属部门
     ↓
登录时 JWT 携带部门信息
     ↓
PostgreSQL RLS 策略：按部门过滤报表
     ↓
数据库层强制隔离
```

详见：memory/permission-design.md

### DuckDB /query 鉴权（待讨论）

```
OpenClaw SQL → DuckDB /query → 鉴权 → read_parquet → 返回结果

鉴权逻辑：
└── 待讨论
```

## 其他组件

### OpenClaw

```
位置：deploy/docker-compose.prod.yml
功能：Agent 服务，自然语言意图解析
集成：生成 SQL → 调 DuckDB /query
状态：已部署
```

### PostgREST

```
位置：docker-compose.yml
功能：自动 REST API，暴露 PostgreSQL 表
鉴权：JWT + RLS
状态：已部署
```

## 已确认的决策

| 决策项 | 确认结果 |
|--------|---------|
| 定时调度位置 | node-cron（Next.js 内） |
| DuckDB 服务数量 | 单服务 |
| 采集逻辑位置 | Next.js API Route |
| 明细数据存储 | OOS Parquet（60天） |
| 汇总数据存储 | PostgreSQL |
| 报表查询 | PostgreSQL + PostgREST |
| PostgreSQL 鉴权 | RLS + 部门 ID |
| 鉴权归属 | 数据源层（同源任务共用一 token），非任务层 |
| 数据源粒度 | (外部系统, 品牌)。乐檬每品牌一个数据源，各持自己的 token |
| 品牌(company)归属 | 由 token 的 JWT `company_id` 决定，非请求参数；换品牌=换 token |
| 多品牌 token 共存 | ✅ 已实测：切换品牌不互顶，两品牌 token 可同时有效 |
| branch_nums 取值 | 传空 `[]` = 该品牌(company)全部门店，无需枚举 |
| OOS 存储 | 按品牌分区：`lemeng/retail_detail/{company_id}/{date}/` |
| 零售明细采集模式 | 当天数据、8-24 点每 5 分钟增量 + 每小时全量核对 |

## 待讨论/待实现

| 项目 | 状态 |
|------|------|
| DuckDB /compute 端点 | ⏳ 待实现 |
| PostgreSQL 汇总表 | ⏳ 待创建 |
| 采集后自动触发计算 | ⏳ 待实现 |
| DuckDB /query 鉴权逻辑 | ⏳ 待讨论 |
| OpenClaw 集成 | ⏳ 待实现 |