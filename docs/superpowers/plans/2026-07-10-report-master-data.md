# 报表主数据（子系统 A）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立品牌隔离的商品/门店主数据（dim_item / dim_branch + 扩展 + 跨品牌合并视图），废弃臆想的 lemeng_items，为报表体系打地基。

**Architecture:** 主数据存 PostgreSQL，PK 一律 `(system_book_code, *)` 止住跨品牌碰撞。商品档案采集写 `dim_item`（base 列 + raw JSONB），人工扩展进独立表 `dim_item_ext`（采集永不碰），跨品牌合并用 `canonical_product` 视图按 `item_code` 自动聚合。门店 `dim_branch` 的 base 从销售明细 distinct 自动发现、战区层级人工维护。设计依据见 `docs/superpowers/specs/2026-07-10-report-master-data-design.md`。

**Tech Stack:** PostgreSQL + PostgREST（迁移幂等）、Next.js web（`web/lib/collect-items.ts` 采集）、node-cron 调度、乐檬 API（`nhsoft.base.business.item.page.new`）。

**验证方式（本仓无单测框架）:** TS 编译 → 迁移应用 → curl/psql 核查。部署：web/ + database/ 改动走 GHA（`git push`）；纯 function 改动走 SSH 直调（本计划不涉及 function）。

**关联键（实测已定）:** 明细 `item_num` = 档案 `item_num`；跨品牌合并键 = `item_code`。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `database/migrations/024_master_data.sql` | 建主数据表 + 视图 + 权限 | 新建 |
| `web/lib/collect-items.ts` | 商品档案采集 → 写 dim_item（全字段、结构化类别、brand-scoped） | 重写 |
| `database/migrations/025_dim_branch_discovery_task.sql` | dim_branch 自动发现调度任务 | 新建 |
| `database/migrations/026_retire_lemeng_items.sql` | 废弃旧表 | 新建 |
| `docs/architecture.md` | §1.1 表清单 + §5 增加 master data 说明 | 修改 |

---

## Task 1: 建主数据表 + 合并视图 + 权限

**Files:**
- Create: `database/migrations/024_master_data.sql`
- Modify: `database/migrations/002_seed.sql`（无需，权限在本迁移内）

- [ ] **Step 1: 写迁移文件（幂等，外部数据字段一律 TEXT）**

`database/migrations/024_master_data.sql`:
```sql
-- 024_master_data.sql
-- 报表主数据：商品(dim_item)/商品扩展(dim_item_ext)/场景命名/门店(dim_branch) + 跨品牌合并视图
-- 设计依据：docs/superpowers/specs/2026-07-10-report-master-data-design.md
-- 幂等：全部 IF NOT EXISTS / OR REPLACE。

-- ===== 商品主数据（采集权威） =====
CREATE TABLE IF NOT EXISTS dim_item (
    system_book_code   TEXT NOT NULL,
    item_num           TEXT NOT NULL,
    item_code          TEXT,
    bar_code           TEXT,
    item_name          TEXT,
    category_code      TEXT,
    category_name      TEXT,
    category_path      TEXT,
    top_category       TEXT,
    item_brand         TEXT,
    department         TEXT,
    item_unit          TEXT,
    item_regular_price TEXT,
    item_cost_price    TEXT,
    supplier_name      TEXT,
    item_tags          TEXT,
    raw                JSONB,
    updated_at         TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, item_num)
);
CREATE INDEX IF NOT EXISTS idx_dim_item_code ON dim_item(item_code);
CREATE INDEX IF NOT EXISTS idx_dim_item_category ON dim_item(category_name);
DROP TRIGGER IF EXISTS update_dim_item_updated_at ON dim_item;
CREATE TRIGGER update_dim_item_updated_at
    BEFORE UPDATE ON dim_item FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
COMMENT ON TABLE dim_item IS '商品主数据（采集覆盖 base 列 + raw JSONB；PK 品牌隔离）';

-- ===== 商品扩展（人工维护，采集永不碰） =====
CREATE TABLE IF NOT EXISTS dim_item_ext (
    system_book_code TEXT NOT NULL,
    item_num         TEXT NOT NULL,
    custom_group     TEXT,
    note             TEXT,
    updated_at       TIMESTAMP DEFAULT NOW(),
    updated_by       TEXT,
    PRIMARY KEY (system_book_code, item_num),
    FOREIGN KEY (system_book_code, item_num) REFERENCES dim_item(system_book_code, item_num) ON DELETE CASCADE
);
COMMENT ON TABLE dim_item_ext IS '商品扩展（人工二次维护，采集绝不写入；外键级联删）';

-- ===== 场景命名（跨品牌共享，挂在 canonical item_code） =====
CREATE TABLE IF NOT EXISTS item_scenario_names (
    item_code    TEXT NOT NULL,
    scenario     TEXT NOT NULL,
    display_name TEXT NOT NULL,
    PRIMARY KEY (item_code, scenario)
);
COMMENT ON TABLE item_scenario_names IS '商品场景命名映射（一商品多场景多名）';

-- ===== 门店主数据（base 自动发现 + ext 战区人工） =====
CREATE TABLE IF NOT EXISTS dim_branch (
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,
    branch_code      TEXT,
    branch_name      TEXT,
    war_zone         TEXT,
    city             TEXT,
    region           TEXT,
    updated_at       TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (system_book_code, branch_num)
);
DROP TRIGGER IF EXISTS update_dim_branch_updated_at ON dim_branch;
CREATE TRIGGER update_dim_branch_updated_at
    BEFORE UPDATE ON dim_branch FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
COMMENT ON TABLE dim_branch IS '门店主数据（base 自动发现可覆盖；war_zone/city/region 人工维护不覆盖）';

-- ===== 跨品牌合并视图（按 item_code 自动聚合） =====
CREATE OR REPLACE VIEW canonical_product AS
SELECT item_code,
       (ARRAY_AGG(item_name ORDER BY item_name))[1] AS display_name,
       (ARRAY_AGG(category_name ORDER BY item_name))[1] AS category_name,
       (ARRAY_AGG(top_category ORDER BY item_name))[1] AS top_category,
       COUNT(DISTINCT system_book_code) AS brand_count,
       ARRAY_AGG(DISTINCT system_book_code) AS brands
FROM dim_item
WHERE item_code IS NOT NULL
GROUP BY item_code;
COMMENT ON VIEW canonical_product IS '跨品牌合并层：按 item_code 自动聚合（60% 同码合并、40% 各异分开）';

-- ===== 权限 =====
GRANT SELECT ON dim_item, dim_branch, canonical_product, item_scenario_names TO authenticated;
GRANT SELECT, INSERT, UPDATE ON dim_item_ext, item_scenario_names, dim_branch TO authenticated;
-- 注：item_cost_price 属成本敏感列，搬运进 DuckDB 时按 §4.2 can_see_cost 脱敏（C 子系统接线）。
```

- [ ] **Step 2: 本地语法自查（可选，psql --dry 不校验逻辑，仅看明显错误）**

人工 review：所有 `IF NOT EXISTS` / `OR REPLACE` 齐全；PK 均含 `system_book_code`；外键引用存在。

- [ ] **Step 3: 提交并走 GHA 部署（迁移由 GHA Step 3 应用）**

```bash
git add database/migrations/024_master_data.sql
git commit -m "feat(db): 报表主数据表 dim_item/dim_branch + canonical_product 视图

- dim_item PK(system_book_code,item_num) 止跨品牌碰撞
- dim_item_ext 扩展表(人工维护,采集永不碰)
- item_scenario_names 场景命名
- dim_branch base+战区层级
- canonical_product 按 item_code 自动跨品牌合并

依据 docs/superpowers/specs/2026-07-10-report-master-data-design.md"
git push origin main
```

- [ ] **Step 4: 验证部署（GHA 完成后）**

```bash
gh run list --limit 1   # 等绿
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '\d dim_item'"
```
Expected: 表存在，PK = (system_book_code, item_num)；`\dv canonical_product` 视图存在。

- [ ] **Step 5: PostgREST 可读核查**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "curl -s 'http://localhost:7130/rest/v1/canonical_product?limit=3' -H 'apikey: \$INSFORGE_ANON_KEY'"
```
Expected: `[]`（空数组，表刚建无数据，HTTP 200 非 404）。

---

## Task 2: 重写 collect-items → 写 dim_item（全字段、结构化类别、brand-scoped）

**Files:**
- Modify: `web/lib/collect-items.ts`（重写 `LemengItem` 接口、`upsertToPostgREST`、`collectItems` 的记录映射；保留签名/拉取/签名算法）

- [ ] **Step 1: 改 LemengItem 接口 + 加 mapper**

把 `web/lib/collect-items.ts` 顶部的 `interface LemengItem`（原 11 字段）替换为接收 API 原始对象，并新增 mapper。保留 `generateSignature`/`buildHeaders`/`buildBody`/`callLemengApi`/`fetchWithTimeout` 不变。

替换原 `interface LemengItem {...}` 为：
```ts
// API 原始记录（按需取字段，其余进 raw）
interface LemengItem { [k: string]: any }

// dim_item 列（base 列 + raw；绝不写 ext 列）
interface DimItemRow {
  system_book_code: string
  item_num: string
  item_code: string | null
  bar_code: string | null
  item_name: string | null
  category_code: string | null
  category_name: string | null
  category_path: string | null
  top_category: string | null
  item_brand: string | null
  department: string | null
  item_unit: string | null
  item_regular_price: string | null
  item_cost_price: string | null
  supplier_name: string | null
  item_tags: string | null
  raw: object
}

// 乐檬 API 原始对象 → dim_item 行（结构化类别从嵌套对象取）
function mapToDimItem(it: LemengItem): DimItemRow | null {
  const system_book_code = String(it.system_book_code ?? '')
  const item_num = String(it.item_num ?? '')
  if (!system_book_code || !item_num) return null  // 缺主键跳过
  const cat = it.item_category || {}
  const dept = it.item_department || {}
  const str = (v: any) => (v == null ? null : String(v))
  return {
    system_book_code,
    item_num,
    item_code: str(it.item_code),
    bar_code: str(it.bar_code ?? it.item_barcode),
    item_name: str(it.item_name),
    category_code: str(cat.category_code),
    category_name: str(cat.category_name),
    category_path: str(it.full_category_path),
    top_category: str(it.top_category),
    item_brand: str(it.item_brand),
    department: str(dept.item_department_name ?? it.department),
    item_unit: str(it.item_unit ?? it.unit_name),
    item_regular_price: str(it.item_regular_price),
    item_cost_price: str(it.item_cost_price),
    supplier_name: str(it.item_first_supplier),
    item_tags: str(it.item_tag_strs),
    raw: it,
  }
}
```

- [ ] **Step 2: 改 upsertToPostgREST → 写 dim_item**

把原 `upsertToPostgREST(records: LemengItem[])` 整个函数替换为：
```ts
async function upsertToPostgREST(records: LemengItem[]): Promise<{ success: boolean; upserted?: number; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Prefer': 'resolution=merge-duplicates'   // 冲突在 PK (system_book_code, item_num) 上 merge
  };
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }
  const rows = records.map(mapToDimItem).filter((r): r is DimItemRow => r !== null);
  if (rows.length === 0) return { success: true, upserted: 0 };
  const url = `${POSTGREST_URL}/dim_item`;
  try {
    const response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(rows) }, 30000);
    if (response.status === 201 || response.status === 200) return { success: true, upserted: rows.length };
    const errorText = await response.text();
    console.error(`[collect-items] Error response (${response.status}): ${errorText.slice(0, 500)}`);
    return { success: false, error: `PostgREST ${response.status}: ${errorText.slice(0, 200)}` };
  } catch (err: unknown) {
    console.error(`[collect-items] Fetch error:`, (err instanceof Error ? err.message : String(err)));
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}
```

- [ ] **Step 3: 改 collectItems 内的 upsert 批构造 + getDbCount 目标**

原 `collectItems` 里 `const upsertRecords = batch.map(item => ({ item_num: ..., item_code: ... }))`（11 字段）那段，替换为直接传 `batch`（原始记录）给 `upsertToPostgREST`（mapper 在其内部跑）：
```ts
    const { success, error } = await upsertToPostgREST(batch);
```
（删除原手写 11 字段的 `upsertRecords` 构造块。）

把 `getDbCount` 的 URL `${POSTGREST_URL}/lemeng_items?select=item_num` 改为 `${POSTGREST_URL}/dim_item?select=item_num`。

- [ ] **Step 4: TS 编译自查**

```bash
cd web && npx tsc --noEmit
```
Expected: 无报错（`LemengItem` 索引签名 `[k:string]:any` 下 `it.xxx` 取值合法）。

- [ ] **Step 5: 提交并走 GHA**

```bash
git add web/lib/collect-items.ts
git commit -m "feat(collect-items): 重写为写 dim_item（全字段+结构化类别+brand-scoped）

- mapToDimItem 从 API 原始对象映射；类别从嵌套对象取 category_code/name/path/top
- upsert 目标 lemeng_items→dim_item，PK(system_book_code,item_num)
- system_book_code 从响应派生（不再硬编码）"
git push origin main
```

---

## Task 3: 回填 3120（新逻辑采入 dim_item）+ 验证

**Files:** 无新文件（用现成路由触发）

- [ ] **Step 1: 触发 3120 商品档案采集（写 dim_item）**

等 Task 2 的 GHA 绿后：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "curl -s -X POST http://localhost:3000/api/admin/collect-items -H 'Content-Type: application/json' -d '{\"task_id\":\"a0000000-0000-0000-0000-000000000002\"}'"
```
Expected: `{"success":true,"total":16786,"collected":16786,"verified":true,...}`（total 与之前一致）。

- [ ] **Step 2: 核查 dim_item 写入 + 结构化类别**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT system_book_code, COUNT(*) FROM dim_item GROUP BY 1; SELECT item_num,item_code,category_name,category_path,top_category FROM dim_item WHERE item_num='312005582';\""
```
Expected: 3120 一行 ~16786；「瓜瓜乐（八六王蜜瓜）」item_num=312005582 的 category_path 为「生鲜->水果生鲜->蜜瓜类」之类（非 JSON blob）。

- [ ] **Step 3: 核查 canonical_product 视图**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT COUNT(*) total, COUNT(*) FILTER (WHERE brand_count>1) multi_brand FROM canonical_product;\""
```
Expected: 此时仅 3120，`multi_brand=0`（64188 未采）；total ≈ distinct item_code 数。64188 采后 multi_brand 才 >0。

---

## Task 4: 解决 64188 center branch_id + 建 64188 商品档案采集任务

**Files:**
- Create: `database/migrations/025_lemeng64188_items_task.sql`（仅在前两步确认 branch_id 后写实际值）

> 64188 `auth_config` 为空、无商品档案任务。需先找到 64188 item API 的 center branch_id。

- [ ] **Step 1: 解码 64188 token JWT 找 branch 线索**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com \
  "docker exec deploy-postgres-1 psql -U postgres -d insforge -tAc \"select credential_data::jsonb->>'token' from auth_credentials where source_id='c0000000-0000-0000-0000-000000000001'\" | tr -d '\\n' | jq -R 'gsub(\"^Bearer \";\"\") | split(\".\") | .[1] | @base64d | fromjson'"
```
读 payload 里的 `company_id`/`branch`/`center` 类 claim，记下候选 branch_id。

- [ ] **Step 2: 试调 64188 item API（验 branch_id 是否品牌无关）**

复用 Task 1 调查时用的采样脚本（容器内 `docker exec deploy-web-1 node`，复用 collect-items 签名 + `LEMENG_SECRET_KEY`），传 `source_id=c0000000-...-001`、`branch_id=28444`（3120 的）、`size=2`：
- 若返回 `system_book_code=64188` 的商品 → branch_id 品牌无关，**任意值可用**，直接用 28444。
- 若报错/返回空 → 用 Step 1 的候选 branch_id 重试；都不行则问业务方要 64188 总店编号。

- [ ] **Step 3: 写 64188 任务迁移（把上一步确定的 branch_id 填入 params）**

`database/migrations/025_lemeng64188_items_task.sql`（`<64188_BRANCH_ID>` 换成实测值）：
```sql
-- 025_lemeng64188_items_task.sql
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled)
VALUES (
    'c0000000-0000-0000-0000-000000000003'::uuid,
    '乐檬-64188-商品档案采集',
    'c0000000-0000-0000-0000-000000000001'::uuid,
    'collect-items',
    '30 3 * * *',                                   -- 与 3120 错峰（3120 是 0 3）
    '{"task_type":"items","page_size":200,"branch_id":<64188_BRANCH_ID>}'::jsonb,
    true
) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, params=EXCLUDED.params;

-- 64188 数据源 auth_config 补 branch_id（统一来源）
UPDATE data_sources SET auth_config = '{"branch_id": <64188_BRANCH_ID>, "branch_nums": "99"}'::jsonb
WHERE id = 'c0000000-0000-0000-0000-000000000001';
```

- [ ] **Step 4: 提交 + GHA + 验证任务存在**

```bash
git add database/migrations/025_lemeng64188_items_task.sql
git commit -m "feat(db): 64188 商品档案采集任务 + auth_config branch_id"
git push origin main
# GHA 绿后：
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT name, enabled, params FROM collect_tasks WHERE source_id='c0000000-0000-0000-0000-000000000001';\""
```
Expected: 「乐檬-64188-商品档案采集」enabled=true。

---

## Task 5: 采集 64188 + 验证跨品牌合并

**Files:** 无新文件

- [ ] **Step 1: 触发 64188 商品档案采集**

```bash
ssh ... "curl -s -X POST http://localhost:3000/api/admin/collect-items -H 'Content-Type: application/json' -d '{\"task_id\":\"c0000000-0000-0000-0000-000000000003\"}'"
```
Expected: `{"success":true,"verified":true,"total":...}`。

- [ ] **Step 2: 核查 dim_item 双品牌 + canonical_product 合并**

```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT system_book_code, COUNT(*) FROM dim_item GROUP BY 1;
SELECT COUNT(*) total, COUNT(*) FILTER (WHERE brand_count>1) cross_brand_items FROM canonical_product;
SELECT * FROM canonical_product WHERE item_code='FT030036';
\""
```
Expected: dim_item 两行（3120、64188）；`cross_brand_items > 0`（≈1024）；`FT030036`（瓜瓜乐蜜瓜）brand_count=2、brands={3120,64188}。

---

## Task 6: dim_branch（延后 · 商品档案之后单独做）— 原"明细自动发现"方案作废

> **用户方向调整（2026-07-10）**：门店表**单独采集**（乐檬门店/分支 API，同 dim_item 模式：采集覆盖 base、战区 ext 人工维护），**不再从明细 distinct 自动发现**。base 列须先看 branch API 真实结构再定（不臆想建表）。整体延后到商品档案落地之后单独做。下面原"明细自动发现"步骤作废、仅备查。

**Files:**
- Create: `database/migrations/026_dim_branch_discovery_function.sql`（PG 函数：从 DuckDB 拉明细 distinct 写 dim_branch base）
- Modify: `web/lib/scheduler.ts`（加一个调用该函数的调度任务）—— 或保守起见先只建函数 + 手动触发，调度后续接

> 明细在 OOS parquet、dim_branch 在 PG。最小实现：DuckDB 侧 `/query` 出 distinct (system_book_code 需从路径补)，写回 PG。但明细 parquet 无 system_book_code 列（在路径里）。**简化方案**：在 DuckDB `read_parquet` 时用 `filename` 拆出 company。MVP 用一个 web 调度任务，按品牌路径分别 distinct 后 upsert。

- [ ] **Step 1: 写 dim_branch 发现逻辑（web/lib/dim-branch-sync.ts）**

`web/lib/dim-branch-sync.ts`（新文件）：对每个品牌，调 DuckDB `/query` 取 distinct branch_num/code/name，经 PostgREST upsert dim_branch（仅 base 列，`ON CONFLICT DO UPDATE SET branch_code,branch_name` 不动战区）。
```ts
// web/lib/dim-branch-sync.ts
// 从销售明细 distinct 自动发现门店 base，写 dim_branch（不覆盖 war_zone/city/region）。
const DUCKDB = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_ANON_KEY = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

const BRANDS = [
  { code: '3120', path: 's3://lemeng-datasource/lemeng/retail_detail/3120/*/all.parquet' },
  { code: '64188', path: 's3://lemeng-datasource/lemeng/retail_detail/64188/*/all.parquet' },
];

async function q(sql: string) {
  const r = await fetch(`${DUCKDB}/query`, {
    method: 'POST',
    headers: { 'x-agent-key': AGENT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('duckdb /query failed: ' + JSON.stringify(j));
  return j.data as any[];
}

export async function syncDimBranch(): Promise<{ discovered: number }> {
  let discovered = 0;
  for (const b of BRANDS) {
    const rows = await q(
      `SELECT DISTINCT branch_num, branch_code, branch_name FROM read_parquet('${b.path}') WHERE branch_num IS NOT NULL`
    );
    const records = rows.map(r => ({
      system_book_code: b.code,
      branch_num: String(r.branch_num),
      branch_code: r.branch_code ?? null,
      branch_name: r.branch_name ?? null,
    }));
    if (records.length === 0) continue;
    // 用 RPC upsert_branch_base（迁移 026）：ON CONFLICT 只更 base 列、保留人工战区。
    // 不能用 PostgREST merge-duplicates（PK 上全列覆盖会冲掉 war_zone/city/region）。
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (INSFORGE_ANON_KEY) { headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`; headers['apikey'] = INSFORGE_ANON_KEY; }
    const res = await fetch(`${POSTGREST_URL}/rpc/upsert_branch_base`, {
      method: 'POST', headers, body: JSON.stringify({ _rows: records }),
    });
    if (!res.ok) throw new Error('upsert_branch_base failed: ' + await res.text());
    discovered += records.length;
  }
  return { discovered };
}
```

- [ ] **Step 2: 建配套 PG 函数 upsert_branch_base（只更 base 列）**

`database/migrations/026_dim_branch_discovery_function.sql`：
```sql
-- 026_dim_branch_discovery_function.sql
-- 门店 base 自动发现：只 upsert base 列，绝不覆盖 war_zone/city/region。
CREATE OR REPLACE FUNCTION upsert_branch_base(_rows jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_branch (system_book_code, branch_num, branch_code, branch_name)
  SELECT
    e->>'system_book_code', e->>'branch_num',
    NULLIF(e->>'branch_code',''), NULLIF(e->>'branch_name','')
  FROM jsonb_array_elements(_rows) e
  ON CONFLICT (system_book_code, branch_num) DO UPDATE SET
    branch_code = EXCLUDED.branch_code,
    branch_name = EXCLUDED.branch_name,
    updated_at = NOW();
END; $$;
GRANT EXECUTE ON FUNCTION upsert_branch_base(jsonb) TO authenticated;
COMMENT ON FUNCTION upsert_branch_base IS '门店 base 自动发现 upsert（只更 base 列，保留人工战区）';
```

- [ ] **Step 3: 接调度（web/lib/scheduler.ts 注册每日任务）**

在 scheduler 现有任务注册处加一个每日 04:00 调 `syncDimBranch()` 的任务（参照现有 collect_tasks 注册模式；或在 `instrumentation` 里加 node-cron）。具体注册代码参照 `web/lib/scheduler.ts` 现有 `runningTasks` + cron 模式。**保守起见 MVP 可先不接 cron，手动触发验证**（见 Step 4）。

- [ ] **Step 4: 提交 + GHA + 手动触发验证**

```bash
git add web/lib/dim-branch-sync.ts database/migrations/026_dim_branch_discovery_function.sql
git commit -m "feat(dim-branch): 门店 base 从明细自动发现 upsert（保留人工战区）"
git push origin main
# GHA 绿后，容器内手动跑一次：
ssh ... "docker exec deploy-web-1 node -e 'require(\"./lib/dim-branch-sync\").syncDimBranch().then(r=>console.log(r)).catch(e=>{console.error(e);process.exit(1)})'"
# 核查：
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT system_book_code, COUNT(*) FROM dim_branch GROUP BY 1;\""
```
Expected: dim_branch 两行，3120≈144、64188≈73（与明细 store 数吻合），war_zone/city/region 为 NULL（待人工填）。

---

## Task 7: 废弃 lemeng_items

**Files:**
- Create: `database/migrations/027_retire_lemeng_items.sql`
- Modify: 确认无代码引用（`grep -r lemeng_items web/ functions/ services/`）

- [ ] **Step 1: 确认无引用**

```bash
grep -rn "lemeng_items" web/ functions/ services/ --exclude-dir=node_modules --exclude-dir=.next
```
Expected: 仅 `database/migrations/011_lemeng_items.sql`、`012_fix_lemeng_items_auth.sql`（历史迁移，不动）。Task 2 已把 collect-items 的引用改掉。若仍有代码引用 → 先改掉再继续。

- [ ] **Step 2: 备份后降级为只读（保数据兜底）**

`database/migrations/027_retire_lemeng_items.sql`：
```sql
-- 027_retire_lemeng_items.sql
-- lemeng_items 已被 dim_item 取代。先撤销写权限保数据兜底，观察一周后再 DROP。
REVOKE INSERT, UPDATE, DELETE ON lemeng_items FROM authenticated, anon;
COMMENT ON TABLE lemeng_items IS 'DEPRECATED 2026-07: 已由 dim_item 取代，只读兜底，待删';
-- 一周后确认无误再加：DROP TABLE lemeng_items;
```

- [ ] **Step 3: 提交 + GHA + 验证**

```bash
git add database/migrations/027_retire_lemeng_items.sql
git commit -m "chore(db): lemeng_items 降级只读（已被 dim_item 取代）"
git push origin main
```

- [ ] **Step 4: 更新架构文档**

修改 `docs/architecture.md` §1.1 表清单：移除 `lemeng_items`，加 `dim_item / dim_item_ext / dim_branch / canonical_product / item_scenario_names`；§5 加一段 master data 说明（关联键 item_num、合并键 item_code、brand-scoped PK）。提交。

```bash
git add docs/architecture.md
git commit -m "docs(arch): 主数据 dim_item/dim_branch 取代 lemeng_items（报表体系 A 落地）"
git push origin main
```

---

## Definition of Done（全部 Task 完成后）

- [ ] `dim_item` 双品牌齐全（3120 + 64188），PK 无碰撞。
- [ ] `canonical_product` 视图 cross_brand_items ≈ 1024（与实测公共 item_code 数吻合）。
- [ ] `dim_branch` 两品牌门店 base 齐全，战区列空待人工。
- [ ] `lemeng_items` 只读、无代码引用。
- [ ] `docs/architecture.md` 已同步。
- [ ] PostgREST 能读 `dim_item`/`dim_branch`/`canonical_product`（HTTP 200）。

---

## 未覆盖（属其他子系统，本计划不做）

- **小表搬运进 DuckDB / 接 /compute 与 OpenClaw** → 子系统 C。
- **dim_item_ext / 战区 / 场景命名的管理 UI** → 后置（MVP 用 SQL 维护）。
- **明细 JOIN dim 的报表实际产出** → 子系统 C/D。
