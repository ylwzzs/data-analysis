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
│  │  端点：POST /transform                                           │   │
│  │  输入：JSON 明细数据 + 配置                                      │   │
│  │  处理：校验、去重、分片                                          │   │
│  │  输出：Parquet 写入 OOS                                          │   │
│  │  触发：采集完成后调用                                            │   │
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
    └── lemeng/retail_detail/{date}/
        ├── all.parquet              → 当日全部明细
        ├── branch_num_1.parquet     → 门店1明细
        ├── branch_num_2.parquet     → 门店2明细
        └── ...                      → 按门店分片

数据量：每天几万条，保留 60+ 天
格式：Parquet + zstd 压缩
用途：归档 + DuckDB 计算 + 个性化查询
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
    ├── 首次 API 调用时初始化
    └── 端点：GET/POST /api/admin/scheduler/reload

任务配置：
└── collect_tasks 表
    ├── schedule_cron：cron 表达式
    ├── enabled：是否启用
    └── 每日凌晨 2:00 执行采集
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

## 待讨论/待实现

| 项目 | 状态 |
|------|------|
| DuckDB /compute 端点 | ⏳ 待实现 |
| PostgreSQL 汇总表 | ⏳ 待创建 |
| 采集后自动触发计算 | ⏳ 待实现 |
| DuckDB /query 鉴权逻辑 | ⏳ 待讨论 |
| OpenClaw 集成 | ⏳ 待实现 |