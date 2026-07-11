# report 串品牌补丁 Implementation Plan（D 前置 · Plan 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `report_daily_sales/category/weekly_trend` 串品牌 bug——加 `system_book_code` 列 + 改 PK + 改 /compute 聚合配置，按品牌正确分组，为 D 目标达成率扫清硬阻塞。

**Architecture:** /compute 是配置驱动（读 `report_definitions.sql_template`，server.js 通用不改）。补丁用 DuckDB `read_parquet(filename=true)` + `regexp_extract` 从 parquet 路径 `retail_detail/{company}/` 解析 system_book_code，`GROUP BY` 加它，写入 PG 表（新 PK 含 system_book_code）。历史 report 数据串品牌已不可信 → TRUNCATE 后按 retail_detail 全历史重算回填。

**Tech Stack:** PostgreSQL（迁移 DDL + 配置 UPDATE）、DuckDB（read_parquet filename 解析）、InsForge /compute API、GHA 部署（改 database/migrations 走 GHA）。

**对应 spec:** `docs/superpowers/specs/2026-07-11-report-target-achievement-design.md` §3。

---

## 背景事实（必读）

- `report_daily_sales` PK=`(biz_date, branch_num)`，无 system_book_code（迁移 009）。
- /compute 聚合 SQL（report_definitions）`GROUP BY date, branch_num`，glob 读两品牌 parquet 不分组 → 两品牌同 branch_num 销售额被累加合并（实测两品牌 branch_num 重叠 127，distinct 才 174 应 258）。
- retail_detail parquet 文件内**无 company 列**（乐檬 API 不返回），company 只在路径 `s3://lemeng-datasource/lemeng/retail_detail/{companyId}/{date}/...`（collect.ts:322）。
- /compute（services/server.js:489）通用：读 report_definitions 配置 → 替换占位符 → DuckDB runQuery → upsertRow（ON CONFLICT conflict_keys）。**不改 server.js**。
- report_*_v 安全视图 security_invoker=true（迁移 032/037/038/039），基表 GRANT SELECT 给 authenticated。
- 下一个迁移编号：**045**（034-044 已用）。
- 本项目无单元测试框架，验证靠 SQL 查询 + 生产端到端（SSH psql + curl）。

---

## File Structure

- **Create:** `database/migrations/045_report_brand_scoping.sql` — report 三表加 system_book_code + 改 PK + TRUNCATE + 视图重建 + report_definitions 配置更新（一个迁移，幂等）。
- **Modify（数据，非代码）:** `report_definitions` 三条记录（daily_sales/daily_category/weekly_trend）的 sql_template/field_mapping/conflict_keys——通过迁移 045 的 UPSERT 更新。
- **不改:** `services/server.js`（/compute 通用）、`web/lib/scheduler.ts`（C1 triggerCompute 调用不变，只是 /compute 内部按新配置正确分组）。

---

## Task 1: 写迁移 045 — report 三表加 system_book_code + 改 PK + TRUNCATE

**Files:**
- Create: `database/migrations/045_report_brand_scoping.sql`

- [ ] **Step 1: 创建迁移文件，写 report_daily_sales 改结构**

````sql
-- 045_report_brand_scoping.sql
-- 修复 report_daily_sales/category/weekly_trend 串品牌 bug（D 前置）
-- 两品牌 branch_num 重叠 127，原 PK 无 system_book_code → 聚合合并串品牌
-- 解法：加 system_book_code 列 + 改 PK + /compute 配置按品牌分组（read_parquet filename 解析）
-- 历史 report 数据串品牌已不可信 → TRUNCATE 重算

-- ===== report_daily_sales =====
ALTER TABLE report_daily_sales DROP CONSTRAINT IF EXISTS report_daily_sales_pkey;
TRUNCATE TABLE report_daily_sales;
ALTER TABLE report_daily_sales ADD COLUMN IF NOT EXISTS system_book_code TEXT;
ALTER TABLE report_daily_sales ALTER COLUMN system_book_code SET NOT NULL;
ALTER TABLE report_daily_sales ADD CONSTRAINT report_daily_sales_pkey
    PRIMARY KEY (biz_date, system_book_code, branch_num);
CREATE INDEX IF NOT EXISTS idx_report_daily_sales_brand_branch
    ON report_daily_sales(system_book_code, branch_num, biz_date);
````

- [ ] **Step 2: 追加 report_daily_category 改结构**

````sql
-- ===== report_daily_category =====
ALTER TABLE report_daily_category DROP CONSTRAINT IF EXISTS report_daily_category_pkey;
TRUNCATE TABLE report_daily_category;
ALTER TABLE report_daily_category ADD COLUMN IF NOT EXISTS system_book_code TEXT;
ALTER TABLE report_daily_category ALTER COLUMN system_book_code SET NOT NULL;
ALTER TABLE report_daily_category ADD CONSTRAINT report_daily_category_pkey
    PRIMARY KEY (biz_date, system_book_code, branch_num, category);
````

- [ ] **Step 3: 追加 report_weekly_trend 改结构**

````sql
-- ===== report_weekly_trend =====
ALTER TABLE report_weekly_trend DROP CONSTRAINT IF EXISTS report_weekly_trend_pkey;
TRUNCATE TABLE report_weekly_trend;
ALTER TABLE report_weekly_trend ADD COLUMN IF NOT EXISTS system_book_code TEXT;
ALTER TABLE report_weekly_trend ALTER COLUMN system_book_code SET NOT NULL;
ALTER TABLE report_weekly_trend ADD CONSTRAINT report_weekly_trend_pkey
    PRIMARY KEY (week_start, system_book_code, branch_num);
````

- [ ] **Step 4: 验证 SQL 语法（本地或服务器 dry-run）**

本地无 PG 栈，跳过本地 dry-run；在 Task 4 部署后于生产验证（Step 验证 schema）。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/045_report_brand_scoping.sql
git commit -m "feat(report-c): 045 report 三表加 system_book_code+改PK+TRUNCATE(修串品牌)"
```

---

## Task 2: 迁移 045 续 — report_*_v 视图重建（加 system_book_code）

**Files:**
- Modify: `database/migrations/045_report_brand_scoping.sql`（追加）

> 视图必须 DROP + CREATE（不能用 CREATE OR REPLACE，CLAUDE.md 坑：加列后 OR REPLACE 报 cannot drop columns from view）。视图定义要照抄现状（032/037/038/039）的成本列脱敏 CASE，只加 system_book_code 列。

- [ ] **Step 1: 先查现有视图定义（照抄脱敏逻辑）**

Run（SSH 生产，获取现有视图 SQL 作为基底）:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '\d+ report_daily_sales_v'"
```
记录成本列脱敏 CASE（`current_setting('request.jwt.claims.can_see_cost')`）的完整写法。

- [ ] **Step 2: 追加视图重建 SQL（以 daily_sales_v 为例，category_v/weekly_trend_v 同理）**

````sql
-- ===== report_daily_sales_v 重建（加 system_book_code，保留成本脱敏）=====
DROP VIEW IF EXISTS report_daily_sales_v;
CREATE VIEW report_daily_sales_v AS
SELECT
    biz_date, system_book_code, branch_num, branch_name,
    total_orders, total_items, total_sale,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_sales;
ALTER VIEW report_daily_sales_v OWNER TO postgres;
COMMENT ON VIEW report_daily_sales_v IS '每日门店销售汇总安全视图（成本列按 can_see_cost 脱敏；含 system_book_code 品牌隔离）';

-- report_daily_category_v 同理（SELECT 加 system_book_code，保留 total_profit 脱敏）
DROP VIEW IF EXISTS report_daily_category_v;
CREATE VIEW report_daily_category_v AS
SELECT
    biz_date, system_book_code, branch_num, category,
    total_items, total_sale,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN total_profit ELSE NULL END AS total_profit
FROM report_daily_category;
ALTER VIEW report_daily_category_v OWNER TO postgres;

-- report_weekly_trend_v（无成本列，仅加 system_book_code）
DROP VIEW IF EXISTS report_weekly_trend_v;
CREATE VIEW report_weekly_trend_v AS
SELECT week_start, system_book_code, branch_num, branch_name,
       total_sale, prev_week_sale, growth_rate
FROM report_weekly_trend;
ALTER VIEW report_weekly_trend_v OWNER TO postgres;

-- security_invoker（防 superuser owner 绕 RLS；若 038/039 已设，此处幂等重设）
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
ALTER VIEW report_daily_category_v SET (security_invoker = true);
ALTER VIEW report_weekly_trend_v SET (security_invoker = true);

-- 基表 GRANT（C0 已 REVOKE 原表 SELECT 给 anon/authenticated；视图 GRANT SELECT）
GRANT SELECT ON report_daily_sales_v, report_daily_category_v, report_weekly_trend_v TO authenticated;
````

> ⚠️ 若 038/039 对基表的 GRANT/REVOKE 有特殊设置，照抄现状不改 GRANT 策略，仅重建视图 SELECT 列。

- [ ] **Step 3: Commit**

```bash
git add database/migrations/045_report_brand_scoping.sql
git commit -m "feat(report-c): 045 report_*_v 视图重建加 system_book_code(保留脱敏)"
```

---

## Task 3: 迁移 045 续 — 更新 report_definitions 配置（filename 解析 + 按品牌分组）

**Files:**
- Modify: `database/migrations/045_report_brand_scoping.sql`（追加）

> 这是补丁的核心：三条 report_definitions 的 sql_template 改用 `read_parquet(filename=true)` + `regexp_extract` 从路径解析 system_book_code，GROUP BY 加它；field_mapping/conflict_keys 加 system_book_code。UPSERT 幂等（010 已用 ON CONFLICT (report_type) DO UPDATE）。

- [ ] **Step 1: 追加 daily_sales 配置 UPSERT**

````sql
-- ===== report_definitions 配置更新：按品牌分组（read_parquet filename 解析）=====
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_sales',
    '每日门店销售汇总',
    'report_daily_sales',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    {{date_column}} as biz_date_raw,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(COUNT(DISTINCT order_no) AS INTEGER) as total_orders,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "biz_date_raw": {"pg_column": "biz_date", "transform": "YYYYMMDD_to_YYYY-MM-DD"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "branch_name": {"pg_column": "branch_name"},
    "total_orders": {"pg_column": "total_orders", "type": "INTEGER"},
    "total_items": {"pg_column": "total_items", "type": "INTEGER"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"},
    "total_profit": {"pg_column": "total_profit", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["biz_date", "system_book_code", "branch_num"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;
````

- [ ] **Step 2: 追加 daily_category 配置 UPSERT**

````sql
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'daily_category',
    '每日门店品类汇总',
    'report_daily_category',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    {{date_column}} as biz_date_raw,
    branch_num,
    item_category as category,
    CAST(COUNT(*) AS INTEGER) as total_items,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale,
    CAST(SUM(CAST(profit AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  AND item_category IS NOT NULL AND item_category != ''
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num, item_category
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), {{date_column}}, branch_num, item_category
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "biz_date_raw": {"pg_column": "biz_date", "transform": "YYYYMMDD_to_YYYY-MM-DD"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "category": {"pg_column": "category"},
    "total_items": {"pg_column": "total_items", "type": "INTEGER"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"},
    "total_profit": {"pg_column": "total_profit", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["biz_date", "system_book_code", "branch_num", "category"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;
````

- [ ] **Step 3: 追加 weekly_trend 配置 UPSERT**

````sql
INSERT INTO report_definitions (
    report_type, name, target_table, source_pattern,
    sql_template, field_mapping, date_column, date_format, conflict_keys
) VALUES (
    'weekly_trend',
    '周销售趋势汇总',
    'report_weekly_trend',
    's3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
    $SQL$
SELECT
    regexp_extract(filename, 'retail_detail/([0-9]+)/', 1) AS system_book_code,
    DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d'))::DATE as week_start,
    branch_num,
    MAX(branch_name) as branch_name,
    CAST(SUM(CAST(sale_money AS DECIMAL(12,2))) AS DECIMAL(12,2)) as total_sale
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE {{date_column}} BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1),
         DATE_TRUNC('week', STRPTIME({{date_column}}, '%Y%m%d')), branch_num
ORDER BY regexp_extract(filename, 'retail_detail/([0-9]+)/', 1), week_start, branch_num
$SQL$,
    $JSON$
{
    "system_book_code": {"pg_column": "system_book_code", "type": "VARCHAR"},
    "week_start": {"pg_column": "week_start", "type": "DATE"},
    "branch_num": {"pg_column": "branch_num", "type": "VARCHAR"},
    "branch_name": {"pg_column": "branch_name"},
    "total_sale": {"pg_column": "total_sale", "type": "DECIMAL(12,2)"}
}
$JSON$::jsonb,
    'order_detail_bizday',
    'YYYYMMDD',
    '["week_start", "system_book_code", "branch_num"]'::jsonb
) ON CONFLICT (report_type) DO UPDATE SET
    name = EXCLUDED.name,
    target_table = EXCLUDED.target_table,
    source_pattern = EXCLUDED.source_pattern,
    sql_template = EXCLUDED.sql_template,
    field_mapping = EXCLUDED.field_mapping,
    conflict_keys = EXCLUDED.conflict_keys;

DO $$ BEGIN RAISE NOTICE 'Migration 045_report_brand_scoping applied'; END $$;
````

- [ ] **Step 4: Commit**

```bash
git add database/migrations/045_report_brand_scoping.sql
git commit -m "feat(report-c): 045 report_definitions 配置按品牌分组(read_parquet filename 解析)"
```

---

## Task 4: 部署迁移（GHA）+ restart postgrest

> 改 database/migrations → 走 GHA 完整部署（CLAUDE.md 规则）。GHA 会跑全部迁移（045 首次生效）。

- [ ] **Step 1: 推送触发 GHA**

```bash
git push origin main
```

- [ ] **Step 2: 监控 GHA 部署**

```bash
gh run list --limit 3
gh run watch <run-id>
```
预期：5 steps 全绿（migration step 跑 045）。

- [ ] **Step 3: restart postgrest 刷 schema 缓存（CLAUDE.md 坑）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 4: 验证 schema 生效**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT column_name FROM information_schema.columns WHERE table_name='report_daily_sales' ORDER BY ordinal_position;
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='report_daily_sales'::regclass AND contype='p';
SELECT report_type, conflict_keys FROM report_definitions WHERE report_type IN ('daily_sales','daily_category','weekly_trend');
\""
```
预期：
- report_daily_sales 列含 `system_book_code`。
- PK = `(biz_date, system_book_code, branch_num)`。
- conflict_keys 含 `system_book_code`。

---

## Task 5: 历史回填（重跑 /compute 全历史）

> TRUNCATE 后 report 表空，需按 retail_detail 全历史重算。手动触发 /compute（C1 scheduler 只算采集日附近；全历史要手动扫一段日期范围）。

- [ ] **Step 1: 确定 retail_detail parquet 的历史日期范围**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-deno-1 sh -c 'ls /data/lemeng/retail_detail/3120/ 2>/dev/null | sort | head -1; ls /data/lemeng/retail_detail/3120/ 2>/dev/null | sort | tail -1'"
```
（若 S3 路径不同，按实际 S3 布局查；记录最早/最晚日期。）

- [ ] **Step 2: 写回填脚本（按月分段调 /compute，避免单次范围过大）**

Create: `scripts/backfill-report-brand.sh`
```bash
#!/usr/bin/env bash
# 按 月 分段回填 report（daily_sales/category/weekly_trend），service 身份
set -e
FROM=2026-05-01   # 按Step1实际最早日期改
TO=2026-07-11      # 按今天改
API=https://data.shanhaiyiguo.com
KEY=$(ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a && . ./.env && echo $AGENT_API_KEY')
for TYPE in daily_sales daily_category weekly_trend; do
  echo "[$TYPE] $FROM..$TO"
  curl -sf -X POST "$API/compute" \
    -H "x-agent-key: $KEY" -H "Content-Type: application/json" \
    -d "{\"report_type\":\"$TYPE\",\"date_from\":\"$FROM\",\"date_to\":\"$TO\"}"
  echo
done
```
> weekly_trend 用宽范围（覆盖回算所有周）；daily_sales/category 同范围（ON CONFLICT 幂等）。

- [ ] **Step 3: 执行回填**

```bash
chmod +x scripts/backfill-report-brand.sh
bash scripts/backfill-report-brand.sh
```
预期：三个 report_type 各返 `{success:true, rows_written:N}`。

- [ ] **Step 4: Commit 回填脚本**

```bash
git add scripts/backfill-report-brand.sh
git commit -m "chore(report-c): 历史回填脚本(按品牌重算 report 全历史)"
```

---

## Task 6: 按品牌对账验证（完整性规则第 1 点）

> 多品牌共享一张表，必须按品牌对账（不能用全表数，会被另一品牌掩盖）。

- [ ] **Step 1: 验证两品牌 distinct (system_book_code, branch_num) 数正确**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT system_book_code, count(DISTINCT branch_num) AS distinct_branch, count(*) AS rows
FROM report_daily_sales WHERE biz_date >= '2026-07-01'
GROUP BY system_book_code ORDER BY 1;
\""
```
预期：3120 和 64188 各有独立行，distinct_branch 接近各品牌活跃店数（3120~257、64188~128，受当日有销售门店影响）；**两品牌 branch_num 不再合并**。

- [ ] **Step 2: 按品牌对账：库内 active 数 ≥ dim_branch 该品牌活跃店数（抽样某日）**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT '库内64188某日distinct店' AS k, count(DISTINCT branch_num) FROM report_daily_sales WHERE system_book_code='64188' AND biz_date='2026-07-10'
UNION ALL SELECT 'dim_branch 64188活跃店', count(*) FROM dim_branch WHERE system_book_code='64188' AND is_active;
\""
```
预期：库内 distinct 店 ≤ dim_branch 活跃店（部分店当日无销售正常），且 64188 数据独立存在（补丁前 64188 被串几乎不可见）。

- [ ] **Step 3: 抽查某重叠 branch_num 两品牌数据独立**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT system_book_code, branch_num, total_sale FROM report_daily_sales
WHERE branch_num IN (SELECT branch_num FROM dim_branch WHERE system_book_code='3120' AND is_active
                     INTERSECT SELECT branch_num FROM dim_branch WHERE system_book_code='64188' AND is_active)
  AND biz_date='2026-07-10' ORDER BY branch_num, system_book_code LIMIT 10;
\""
```
预期：同一 branch_num 出现两行（3120 + 64188 各一行），total_sale 不同——证明不再合并。

---

## Task 7: C 出口回归（确保补丁不破坏 C 已上线功能）

- [ ] **Step 1: report_*_v 问数可达（带 claim）**

Run（模拟一个有 branch_nums 的用户查视图）:
```bash
curl -sf -X POST https://data.shanhaiyiguo.com/functions/agent-query \
  -H "Content-Type: application/json" \
  -d '{"mode":"execute_sql","sql":"SELECT system_book_code, branch_num, total_sale FROM report_daily_sales_v LIMIT 5","userId":"<某wecom_id>"}'
```
预期：返数据（含 system_book_code 列），按该用户 branch_nums 裁剪。

- [ ] **Step 2: C1 自动 /compute 仍工作（次日采集后 report 推进）**

次日观察：retail 采集 verified 后，report_daily_sales 推进到当天，按品牌分组正确（Task 6 Step1 重跑确认当天两品牌独立）。

- [ ] **Step 3: C4 定时应用模板不受影响**

确认 scheduled_reports 现有 cron turn 推送正常（report_*_v 加列不破坏现有模板 SQL，除非模板 SELECT * ——若有则补 system_book_code）。

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-insforge-1 --tail 30 2>&1 | grep -i compute"
```

---

## 完成标志

- report 三表含 system_book_code，PK 含它，distinct (品牌,店) 数正确（两品牌独立）。
- report_*_v 含 system_book_code，脱敏 + security_invoker 保留。
- report_definitions 配置按品牌分组（filename 解析）。
- 历史回填完成，按品牌对账通过。
- C 出口（问数/C1 自动算/C4 推送）回归正常。
- 部署方式：GHA（改 database/migrations）+ restart postgrest。
