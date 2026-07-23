# 语义层 A4：dim_customer 客户维度物化管道 设计 spec

**日期**：2026-07-23
**状态**：已确认，待实现
**前置**：A1（metric_registry + dimensions/dimension_levels + validate + dictionary_v）；A2（生成器 + report_store_sales_drill_v）；A3（admin 页）均已完成并部署
**关联**：design spec §3.2.3（dim_customer 草案）、dim_branch 029 物化模式、/carry-dims 维表管道

---

## 1. 目标

建批发客户维度 `dim_customer`——从 wholesale_detail parquet **派生物化**（乐檬无客户档案 API，client_code/client_name 只能从批发明细 DISTINCT），注册到语义层维度模型，让 customer 成为可用维度（A3 admin 可见 + A2 生成器后续可加客户维度视图 + 批发客户出库报表的数据基础）。

A4 交付：dim_customer/dim_customer_ext 建表 + DuckDB 派生 endpoint + customer 维度注册 + 日 cron 调度。

### 非目标（YAGNI）
- 客户维度视图（A2 生成器扩展，留后续）
- 客户维度前端报表页（Phase 2）
- client_name→门店匹配规则收敛（需业务定义，留后续）
- wholesale 采集后即时刷新（fire-and-forget，日 cron 够用）

---

## 2. 四个已确认决策

1. **维度层级**：单层（customer）。客户分组（区域/类型）业务规则不明确，强行做两层层级留空上层；先单层做实，分组后续加（改 dimension_levels 即可，A1 表支持）。
2. **字段集**：base 派生 5 字段（client_name/first_order_date/last_order_date/active_days/is_active）+ ext 人工 2 字段（custom_group/note）；不含累计金额（易过期，留报表实时算）；不含对应门店（业务不确定，留后续 ext）。
3. **PK**：`(system_book_code, client_code)`——乐檬编号品牌内（仿 dim_branch 双列 PK）。
4. **触发**：硬编码日 cron `47 4 * * *`（Asia/Shanghai），错开 carry-dims 04:33 + target-close 05:10。dim_customer 慢变，日频全量刷新够（不用 wholesale 采集后每 5 分钟）。

---

## 3. 架构与数据流

```
04:47 cron (registerDimCustomerJob, web/lib/scheduler.ts)
   ↓ fetch /derive-dim-customer (services/server.js 新 endpoint, 仿 /carry-dims)
DuckDB: 每请求新连接 + 重配 S3 → 全量 DISTINCT
   SELECT system_book_code, client_code,
          arg_max(client_name, <date_col>) AS client_name,
          MIN(<date_col>) AS first_order_date, MAX(<date_col>) AS last_order_date,
          COUNT(DISTINCT <date_col>) AS active_days
   FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet')
   WHERE client_code IS NOT NULL AND client_code <> ''
   GROUP BY system_book_code, client_code
   ↓ 软删除(全量 is_active=false) → upsert(见到的标回 true) → COPY parquet
dim_customer (PG) + dim_customer.parquet (S3 dims/)
   ↓
dimensions/dimension_levels 注册 customer 单层维度（083）
   ↓ PostgREST 可查 + A3 admin 可见 + A2 生成器后续可用
```

**模式复用**：
- 建表仿 `029_dim_branch.sql`（base 派生覆盖 + ext 人工 FK CASCADE + is_active 软删除 + _full 视图 + GRANT）
- endpoint 仿 `/carry-dims`（server.js:578，维表管道：连 DuckDB+配 S3+读源+upsert PG+COPY parquet），**非** `/compute`（报表聚合）
- cron 仿 `registerCarryDimsJob`（scheduler.ts:680/696，硬编码兜底 job）
- duckdb 每请求独立连接 + 重配 S3（memory duckdb-transform-isolation 坑）

---

## 4. 文件结构

| 文件 | 职责 |
|---|---|
| `database/migrations/082_dim_customer.sql` | 建 dim_customer（base+is_active+raw）+ dim_customer_ext（FK CASCADE 人工）+ customer_full 视图 + GRANT，仿 029 |
| `database/migrations/083_register_customer_dimension.sql` | dimensions + dimension_levels 注册 customer 单层（derived） |
| `services/server.js` | 新增 `/derive-dim-customer` endpoint（仿 /carry-dims 7 步） |
| `web/lib/scheduler.ts` | 新增 `registerDimCustomerJob()`，cron `47 4 * * *` |

---

## 5. 建表 DDL（082，仿 029）

```sql
CREATE TABLE IF NOT EXISTS dim_customer (
  system_book_code   TEXT NOT NULL,
  client_code        TEXT NOT NULL,
  client_name        TEXT,
  first_order_date   DATE,
  last_order_date    DATE,
  active_days        INT,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  raw                JSONB,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (system_book_code, client_code)
);

CREATE TABLE IF NOT EXISTS dim_customer_ext (
  system_book_code  TEXT NOT NULL,
  client_code       TEXT NOT NULL,
  custom_group      TEXT,
  note              TEXT,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by        TEXT,
  PRIMARY KEY (system_book_code, client_code),
  FOREIGN KEY (system_book_code, client_code)
    REFERENCES dim_customer(system_book_code, client_code) ON DELETE CASCADE
);

DROP VIEW IF EXISTS customer_full;
CREATE VIEW customer_full AS
  SELECT c.*, e.custom_group, e.note
  FROM dim_customer c
  LEFT JOIN dim_customer_ext e
    ON c.system_book_code = e.system_book_code AND c.client_code = e.client_code;
ALTER VIEW customer_full SET (security_invoker = true);

GRANT SELECT ON dim_customer, customer_full TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON dim_customer_ext TO authenticated;
```

**关键点**：
- PK `(system_book_code, client_code)`；ext FK CASCADE（base 物理删则 ext 随）
- 软删除 `is_active=false` 不物理删行 → ext 人工数据不被派生刷新误删（CASCADE 只在物理删触发）
- customer_full 用 `DROP+CREATE`（禁 CREATE OR REPLACE，CLAUDE.md 坑）

---

## 6. DuckDB 派生 endpoint（services/server.js，仿 /carry-dims）

**`POST /derive-dim-customer`**（鉴权 `x-agent-key == AGENT_API_KEY`）：

1. 每请求新 DuckDB 连接 + 重配 S3（env `S3_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET`）
2. 跑派生 SQL（DuckDB 读 parquet 全历史 DISTINCT，`arg_max` 取最近 name）
3. **软删除**：`UPDATE dim_customer SET is_active = false`（标全量为非活跃）
4. **upsert**：逐行 `INSERT ... ON CONFLICT (system_book_code, client_code) DO UPDATE SET client_name=..., first_order_date=..., last_order_date=..., active_days=..., is_active=TRUE, updated_at=NOW()`
5. **COPY**：`COPY (SELECT ...) TO 's3://lemeng-datasource/dims/dim_customer.parquet'`
6. 返回 `{ derived: N, active: M }`（N 总客户，M is_active=true）

> **实现注意**：wholesale_detail parquet 的日期列名（`date` vs `biz_date`）须在 writing-plans 时确认 parquet schema，SQL 用实际列名。client_code/client_name 列名已确认（050:44-45）。

---

## 7. 维度注册（083，A1 表）

```sql
INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter)
VALUES ('customer','客户','批发客户维度（从 wholesale_detail 派生）','derived','dim_customer','client_code','wholesale_detail','从批发明细 DISTINCT client_code 派生', false)
ON CONFLICT (dim_code) DO UPDATE SET name=EXCLUDED.name, source_type=EXCLUDED.source_type, join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key, is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level)
VALUES ('customer','customer','客户',0,'client_code','client_name', NULL)
ON CONFLICT (dim_code, level_code) DO UPDATE SET level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column, name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level;

DO $$ BEGIN RAISE NOTICE 'Migration 083: registered customer dimension'; END $$;
```

**关键点**：
- `source_type='derived'`（区别 branch/item 的 static）——validate_semantic_registry 对 derived 维度跳过 join_key 物化校验（078:34-35，物化表由本任务保证）
- `is_assessed_filter=false`（不套考核战区白名单）
- 单层 customer（depth 0, parent null）
- 注册后 A3 admin 字典/层级树自动显示 customer

---

## 8. 调度（web/lib/scheduler.ts）

新增 `registerDimCustomerJob()`，仿 `registerCarryDimsJob`：
- cron `47 4 * * *`（Asia/Shanghai）
- 错开：carry-dims 04:33（后 14 分）、target-close 05:10（前 23 分）、门店采集 04:00/04:30
- 执行：fetch `/derive-dim-customer`（`x-agent-key` 头），记日志
- 注册点：scheduler 初始化（registerCarryDimsJob 旁）

---

## 9. 部署与验证

### 部署（GHA 完整）
- 改 `database/migrations/`（082/083）+ `services/server.js` + `web/lib/scheduler.ts` → GHA
- **部署后须重启 postgrest**（新表 dim_customer + dimensions 注册，刷 schema 缓存）
- 迁移幂等（CREATE TABLE IF NOT EXISTS + ON CONFLICT + DROP/CREATE VIEW）

### 验证
- 手动触发 `/derive-dim-customer` 首次物化：`{derived: N, active: M}`
- `SELECT COUNT(*), COUNT(*) FILTER (WHERE is_active) FROM dim_customer;`
- `SELECT * FROM validate_semantic_registry();`（0 行）
- A3 admin `/admin/semantic`：字典出 customer、层级树出客户单层、健康 validate 仍 0

---

## 10. 成功标准

- [ ] dim_customer + dim_customer_ext + customer_full 建表，幂等
- [ ] `/derive-dim-customer` 跑通，从 parquet 派生 N 客户，is_active 正确
- [ ] customer 维度注册（单层 derived）
- [ ] validate_semantic_registry() 仍 0 问题
- [ ] scheduler 04:47 cron 注册（手动触发 endpoint 验证）
- [ ] 部署后重启 postgrest，A3 admin 可见 customer 维度

---

## 11. 现状约束（雷区）

1. 乐檬无客户档案 API → 只能从 wholesale_detail parquet DISTINCT 派生
2. 建表仿 029（双表 + 软删除 + FK CASCADE + _full 视图 + GRANT）
3. endpoint 仿 /carry-dims（维表管道），非 /compute（报表聚合）
4. duckdb 每请求独立连接 + 重配 S3（并发隔离坑）
5. 视图 DROP+CREATE，禁 CREATE OR REPLACE
6. 部署后重启 postgrest（新表/维度注册刷 schema 缓存）
7. derived 维度 validate 跳过 join_key 物化校验（物化由本任务保证）
8. parquet 日期列名（date/biz_date）实现时确认
