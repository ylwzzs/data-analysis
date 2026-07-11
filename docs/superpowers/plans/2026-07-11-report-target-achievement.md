# 报表体系 D：目标与达成率 Implementation Plan（Plan 2 · 主体）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**前置依赖：** Plan 1（`2026-07-11-report-c-brand-patch.md`）必须先完成——本 plan 的 `report_achievement_v` 视图 LATERAL JOIN `report_daily_sales.system_book_code`，补丁前该列不存在。

**Goal:** 建 4 表（metric_definitions/targets/target_metric_values/target_snapshots）+ 三态达成率视图 + close_target 固化函数 + scheduler 固化任务 + CSV 导入/后台 UI + 三出口（问数/推送/看板）。

**Architecture:** 目标=时间段+门店+多指标+状态（active 实时/closed 固化）。达成率视图 `report_achievement_v` security_invoker 走双表 branch_nums RLS，三态（active+sale 实时算 / active+not_ready / closed 读 snapshot）。固化靠 PG 函数 `close_target`（SECURITY DEFINER）+ scheduler 定时（end_date 次日）+ UI 手动。指标定义层 metric_definitions（开发维护口径，MVP sale ready + purchase 占位）。

**Tech Stack:** PostgreSQL（迁移 046：表/视图/函数/RLS/注册）、Next.js（scheduler/route/UI）、InsForge SDK（createClient service 写）、GHA 部署（改 database/ + web/）。

**对应 spec:** `docs/superpowers/specs/2026-07-11-report-target-achievement-design.md` §4-§7。

---

## 背景事实（Explore 调研确认，必读）

- **scheduler 模板**：`web/lib/scheduler.ts` 的 `registerCarryDimsJob`（487-509 行）= JOB_KEY + cron.validate + 防重入 + try/finally；注册三连在 50-53 行（ensureSchedulerInitialized 内）。`triggerCompute`（134-171）调 /compute + 写 `compute_logs`。新固化任务照搬。
- **datasets 注册**：031 表结构 + 032 注册 report_daily_sales_v 模式（UPDATE 原表 exposed=false + INSERT datasets/dataset_columns）。注册后 agent-query `loadRegistry()` 60s 缓存自动感知。
- **RLS policy**：015 的 branch_nums JSONB policy（`current_setting('request.jwt.claims.branch_nums')::jsonb`）。targets/snapshots 照抄。**已知局限**：branch_nums claim 不含品牌，而 branch_num 跨品牌重叠 127——同 branch_num 两品牌都可见。MVP 照抄（用户 branch_nums 为其管辖店，影响有限），后续 claim 带品牌再收紧。
- **report_*_v 最终态**：security_invoker=true + 基表 GRANT SELECT + 040 execute_sql_rls regex 黑名单强制走 _v。achievement 视图同模式（无成本列，不需 CASE 脱敏）。
- **admin route 模式**：`web/app/api/admin/collect-lemeng/route.ts`——`createClient({baseUrl, anonKey: INSFORGE_API_KEY})` service 身份写库绕 RLS，JSON body，无鉴权（全站通病，spec §8）。
- **C4 模板真相**：template_key 仅存表，cron 触发时 LLM 现场写 SQL（create_scheduled_report 拼提示词 message）。**无服务端模板执行器**。D 推送 MVP 走 SKILL.md 指引（LLM 查 report_achievement_v），确定性执行器列后续。
- **derive_war_zone(region_name)**：029 已存在 IMMUTABLE 函数，achievement 视图直接调。`branch_full` 视图（029:86）也有现成 war_zone 列。
- **compute_logs**（033）：可复用记固化任务日志（triggered_by='target_close'）。
- 迁移编号：**046**（Plan 1 用 045）。

---

## File Structure

- **Create:** `database/migrations/046_report_targets.sql` — 4 表 + close_target 函数 + report_achievement_v 视图 + datasets 注册 + RLS/GRANT（一个迁移，幂等）。
- **Modify:** `web/lib/scheduler.ts` — 加 `registerTargetCloseJob()` + 注册调用。
- **Create:** `web/app/api/admin/targets/route.ts` — CRUD REST。
- **Create:** `web/app/api/admin/targets/import/route.ts` — CSV 导入。
- **Create:** `web/app/admin/targets/page.tsx` — 后台 UI（录入+列表+固化+看板）。
- **Modify:** `openclaw/data-query-plugin/skills/retail-query/SKILL.md` — 目标/达成率路由指引。

---

## Task 1: 迁移 046 — 4 表建表 + seed + RLS + GRANT

**Files:**
- Create: `database/migrations/046_report_targets.sql`

- [ ] **Step 1: 建 metric_definitions + seed**

````sql
-- 046_report_targets.sql
-- 报表体系 D：目标与达成率（spec §4）
-- 依赖 045（report_* 含 system_book_code）

-- ===== metric_definitions：指标定义层（开发维护口径）=====
CREATE TABLE IF NOT EXISTS metric_definitions (
    metric_code    TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    source_dataset TEXT,
    value_column   TEXT,
    unit           TEXT,
    data_ready     BOOLEAN NOT NULL DEFAULT false,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    description    TEXT,
    created_at     TIMESTAMPTZ DEFAULT now()
);

INSERT INTO metric_definitions (metric_code, name, source_dataset, value_column, unit, data_ready, enabled, description) VALUES
  ('sale', '销售目标', 'report_daily_sales', 'total_sale', '元', true, true, '销售额达成（SUM report_daily_sales.total_sale 按门店+日期段）'),
  ('purchase', '拿货目标', NULL, NULL, '件', false, true, '配送明细拿货量（数据源待接入，接入后翻 data_ready=true 并扩展视图）')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, source_dataset=EXCLUDED.source_dataset, value_column=EXCLUDED.value_column,
  unit=EXCLUDED.unit, enabled=EXCLUDED.enabled, description=EXCLUDED.description;
````

- [ ] **Step 2: 建 targets + target_metric_values + target_snapshots**

````sql
-- ===== targets：目标主表（时间段+门店+状态）=====
CREATE TABLE IF NOT EXISTS targets (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT NOT NULL,
    system_book_code TEXT NOT NULL,
    branch_num       TEXT NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    closed_at        TIMESTAMPTZ,
    note             TEXT,
    created_by       TEXT,
    created_at       TIMESTAMPTZ DEFAULT now(),
    updated_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT target_dates CHECK (end_date >= start_date),
    UNIQUE (system_book_code, branch_num, start_date, end_date)
);
CREATE INDEX IF NOT EXISTS idx_targets_status_dates ON targets(status, end_date);

DROP TRIGGER IF EXISTS update_targets_updated_at ON targets;
CREATE TRIGGER update_targets_updated_at
    BEFORE UPDATE ON targets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ===== target_metric_values：目标挂的各指标目标值 =====
CREATE TABLE IF NOT EXISTS target_metric_values (
    target_id    BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code  TEXT NOT NULL REFERENCES metric_definitions(metric_code),
    target_value NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (target_id, metric_code)
);

-- ===== target_snapshots：已结束目标的固化实际值 =====
CREATE TABLE IF NOT EXISTS target_snapshots (
    target_id        BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    metric_code      TEXT NOT NULL,
    actual_value     NUMERIC(14,2),
    achievement_rate NUMERIC(6,2),
    data_status      TEXT,
    snapshot_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (target_id, metric_code)
);
````

- [ ] **Step 3: RLS + GRANT（照抄 015 branch_nums policy）**

````sql
-- targets 行级（店长看自己店目标）；已知局限：branch_nums claim 不含品牌
ALTER TABLE targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS targets_rls_branch_nums ON targets;
CREATE POLICY targets_rls_branch_nums ON targets
  FOR SELECT TO authenticated
  USING (
    current_setting('request.jwt.claims.branch_nums', true) IS NULL
    OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
    OR branch_num = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb)))
  );

-- target_snapshots 同策略（随目标可见性）
ALTER TABLE target_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS snapshots_rls_branch_nums ON target_snapshots;
CREATE POLICY snapshots_rls_branch_nums ON target_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM targets WHERE targets.id = target_snapshots.target_id AND (
      current_setting('request.jwt.claims.branch_nums', true) IS NULL
      OR current_setting('request.jwt.claims.branch_nums', true)::jsonb ? '*'
      OR targets.branch_num = ANY(ARRAY(SELECT jsonb_array_elements_text(current_setting('request.jwt.claims.branch_nums', true)::jsonb)))
    ))
  );

-- 读权限给 authenticated；写由 service（close_target DEFINER）/ admin route（service key）负责
GRANT SELECT ON metric_definitions TO authenticated;
GRANT SELECT ON targets TO authenticated;
GRANT SELECT ON target_metric_values TO authenticated;
GRANT SELECT ON target_snapshots TO authenticated;
````

- [ ] **Step 4: Commit**

```bash
git add database/migrations/046_report_targets.sql
git commit -m "feat(report-d): 046 目标4表(metric_definitions/targets/values/snapshots)+seed+RLS"
```

---

## Task 2: 迁移 046 续 — close_target 固化函数

**Files:**
- Modify: `database/migrations/046_report_targets.sql`（追加）

- [ ] **Step 1: 追加 close_target 函数（SECURITY DEFINER，service 身份算 actual 固化）**

````sql
-- ===== close_target：固化目标实际值 → snapshot → status=closed（幂等，可重固化）=====
-- 自动（scheduler，end_date 次日）或手动（UI 提前结束）触发
CREATE OR REPLACE FUNCTION close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t_rec RECORD;
    v_actual NUMERIC(14,2);
    v_days_have INTEGER;
    v_total_days INTEGER;
    v_dstatus TEXT;
    v_metric TEXT;
    v_tval NUMERIC(14,2);
BEGIN
    SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;
    IF t_rec.status = 'closed' AND t_rec.closed_at IS NOT NULL AND t_rec.closed_at < t_rec.end_date THEN
      NULL; -- 允许重固化（复盘补数）
    END IF;
    v_total_days := t_rec.end_date - t_rec.start_date + 1;
    FOR v_metric IN SELECT metric_code FROM target_metric_values WHERE target_id = p_target_id LOOP
        SELECT target_value INTO v_tval FROM target_metric_values WHERE target_id=p_target_id AND metric_code=v_metric;
        IF v_metric = 'sale' THEN
            SELECT COALESCE(SUM(total_sale),0), COUNT(DISTINCT biz_date)
              INTO v_actual, v_days_have
              FROM report_daily_sales
             WHERE system_book_code = t_rec.system_book_code
               AND branch_num = t_rec.branch_num
               AND biz_date BETWEEN t_rec.start_date AND t_rec.end_date;
            v_dstatus := CASE WHEN v_days_have = 0 THEN 'missing'
                              WHEN v_days_have < v_total_days THEN 'partial' ELSE 'complete' END;
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, v_actual,
                    CASE WHEN v_tval > 0 THEN round((v_actual / v_tval)::numeric, 4) ELSE NULL END,
                    v_dstatus, now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET
              actual_value=EXCLUDED.actual_value, achievement_rate=EXCLUDED.achievement_rate,
              data_status=EXCLUDED.data_status, snapshot_at=now();
        ELSE
            -- not-ready 指标（如 purchase 未接入）占位
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, NULL, NULL, 'not_ready', now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET data_status='not_ready', snapshot_at=now();
        END IF;
    END LOOP;
    UPDATE targets SET status='closed', closed_at=now(), updated_at=now() WHERE id = p_target_id;
    RETURN jsonb_build_object('ok', true, 'target_id', p_target_id, 'metrics',
      (SELECT jsonb_agg(jsonb_build_object('metric', metric_code, 'actual', actual_value, 'rate', achievement_rate, 'status', data_status))
       FROM target_snapshots WHERE target_id = p_target_id));
END $$;

GRANT EXECUTE ON FUNCTION close_target(BIGINT) TO authenticated;
````

- [ ] **Step 2: Commit**

```bash
git add database/migrations/046_report_targets.sql
git commit -m "feat(report-d): 046 close_target 固化函数(SECURITY DEFINER, sale ready/purchase not_ready)"
```

---

## Task 3: 迁移 046 续 — report_achievement_v 三态视图

**Files:**
- Modify: `database/migrations/046_report_targets.sql`（追加）

- [ ] **Step 1: 追加 report_achievement_v（DROP+CREATE，spec §4.5）**

````sql
-- ===== report_achievement_v：达成率三态视图（active+sale实时 / active+not_ready / closed读snapshot）=====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num,
    b.branch_name,
    derive_war_zone(b.region_name) AS war_zone,
    b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready,
    mv.target_value,
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
    CASE WHEN mv.target_value > 0 AND t.status='closed' THEN sn.achievement_rate
         WHEN mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
         THEN round((COALESCE(sa.sale_actual,0) / mv.target_value)::numeric, 4)
         ELSE NULL END AS achievement_rate,
    CASE WHEN t.status='active' AND mv.target_value > 0 AND md.metric_code='sale' AND md.data_ready
              AND (LEAST(current_date, t.end_date) - t.start_date + 1) > 0
         THEN round((COALESCE(sa.sale_actual,0) / (
              mv.target_value * (LEAST(current_date, t.end_date) - t.start_date + 1)::numeric
              / (t.end_date - t.start_date + 1)))::numeric, 4)
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
) sa ON md.metric_code = 'sale';

ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker = true);
GRANT SELECT ON report_achievement_v TO authenticated;

-- ===== 注册 report_achievement_v 到数据字典（问数出口，照 032 模式）=====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
  ('report_achievement_v','目标达成率(三态)','pg_table','report_achievement_v','summary', TRUE, TRUE, 'start_date', 'YYYY-MM-DD', FALSE, TRUE,
   '目标达成率：active实时/closed读snapshot/not_ready；含 target/actual/achievement_rate/progress_rate')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  exposed=EXCLUDED.exposed, description=EXCLUDED.description;

INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
  ('report_achievement_v','target_id','BIGINT','标识',FALSE,NULL,'目标ID',1),
  ('report_achievement_v','name','TEXT','标识',FALSE,NULL,'目标名称',2),
  ('report_achievement_v','status','TEXT','状态',FALSE,NULL,'active/closed',3),
  ('report_achievement_v','start_date','DATE','日期',FALSE,NULL,'周期起',4),
  ('report_achievement_v','end_date','DATE','日期',FALSE,NULL,'周期止',5),
  ('report_achievement_v','system_book_code','TEXT','维度',FALSE,'dim_branch.system_book_code','品牌',6),
  ('report_achievement_v','branch_num','TEXT','维度',FALSE,'dim_branch.branch_num','门店',7),
  ('report_achievement_v','war_zone','TEXT','维度',FALSE,NULL,'战区(roll-up)',8),
  ('report_achievement_v','region_name','TEXT','维度',FALSE,NULL,'区域',9),
  ('report_achievement_v','city','TEXT','维度',FALSE,NULL,'城市',10),
  ('report_achievement_v','metric_code','TEXT','指标',FALSE,'metric_definitions.metric_code','指标code',11),
  ('report_achievement_v','metric_name','TEXT','指标',FALSE,NULL,'指标名',12),
  ('report_achievement_v','target_value','DECIMAL','金额',FALSE,NULL,'目标值',13),
  ('report_achievement_v','actual_value','DECIMAL','金额',FALSE,NULL,'实际值',14),
  ('report_achievement_v','achievement_rate','DECIMAL','比率',FALSE,NULL,'累计达成率(actual/target)',15),
  ('report_achievement_v','progress_rate','DECIMAL','比率',FALSE,NULL,'进度对齐(按已过天数折算)',16),
  ('report_achievement_v','data_status','TEXT','状态',FALSE,NULL,'complete/partial/missing/not_ready',17)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type, description=EXCLUDED.description;

DO $$ BEGIN RAISE NOTICE 'Migration 046_report_targets applied'; END $$;
````

- [ ] **Step 2: Commit**

```bash
git add database/migrations/046_report_targets.sql
git commit -m "feat(report-d): 046 report_achievement_v 三态达成率视图(security_invoker)"
```

---

## Task 4: 部署迁移 046 + restart postgrest + 验证

- [ ] **Step 1: 推送触发 GHA**

```bash
git push origin main
gh run watch <run-id>
```
预期：GHA 5 steps 全绿，045+046 都跑过。

- [ ] **Step 2: restart postgrest（新表/视图刷 schema 缓存）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: 验证表/函数/视图就位**

Run:
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT count(*) FROM metric_definitions;  -- 预期 2（sale/purchase）
SELECT proname FROM pg_proc WHERE proname='close_target';  -- 预期 1 行
SELECT count(*) FROM information_schema.views WHERE table_name='report_achievement_v';  -- 预期 1
\""
```

---

## Task 5: scheduler 加 registerTargetCloseJob（定时固化）

**Files:**
- Modify: `web/lib/scheduler.ts`

- [ ] **Step 1: 加 registerTargetCloseJob（照搬 registerCarryDimsJob 模式，调 close_target RPC）**

在 `registerCarryDimsJob` 函数后追加（约 510 行后）：
```ts
function registerTargetCloseJob() {
  const JOB_KEY = "__target_close";
  if (scheduledJobs.has(JOB_KEY)) return;
  const CRON = "10 5 * * *";  // 每天 05:10（C1 daily compute 之后，end_date 次日确保当天数据采全）
  if (!cron.validate(CRON)) return;
  const job = cron.schedule(CRON, async () => {
    if (runningTasks.has(JOB_KEY)) return;
    runningTasks.add(JOB_KEY);
    try {
      console.log("[scheduler] ⏰ 目标固化定时触发（end_date<today 的 active 目标）");
      // service 身份调 close_target：取所有到期 active 目标，逐个 close
      const resp = await fetch(`${INSFORGE_API_BASE}/rpc/get_due_targets`, {
        method: "POST",
        headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const due: { id: number }[] = await resp.json().catch(() => []);
      for (const t of due) {
        const cr = await fetch(`${INSFORGE_API_BASE}/rpc/close_target`, {
          method: "POST",
          headers: { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p_target_id: t.id }),
        });
        const data = await cr.json().catch(() => ({}));
        console.log(`[scheduler] close_target(${t.id}):`, data);
      }
    } catch (e: any) {
      console.error("[scheduler] target_close 异常:", e.message);
    } finally {
      runningTasks.delete(JOB_KEY);
    }
  }, { timezone: "Asia/Shanghai" });
  scheduledJobs.set(JOB_KEY, job);
  console.log("[scheduler] 注册目标固化兜底 (10 5 * * *, Asia/Shanghai)");
}
```

- [ ] **Step 2: 加 get_due_targets RPC（迁移 047，给 scheduler 取到期目标）**

Create: `database/migrations/047_target_close_rpc.sql`
```sql
-- 047_target_close_rpc.sql
-- 取 end_date < today 的 active 目标 id（scheduler 定时固化用，SECURITY DEFINER 绕 RLS 取全量到期）
CREATE OR REPLACE FUNCTION get_due_targets() RETURNS TABLE(id BIGINT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM targets WHERE status = 'active' AND end_date < current_date ORDER BY id;
$$;
GRANT EXECUTE ON FUNCTION get_due_targets() TO authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 047_target_close_rpc applied'; END $$;
```

- [ ] **Step 3: 注册调用（scheduler.ts 50-53 行的注册三连后加一行）**

在 `registerMonitorJobs();` 后加：
```ts
  registerMonitorJobs();
  registerTargetCloseJob();   // D：目标固化兜底
```

- [ ] **Step 4: Commit**

```bash
git add database/migrations/047_target_close_rpc.sql web/lib/scheduler.ts
git commit -m "feat(report-d): scheduler registerTargetCloseJob + get_due_targets RPC(每日05:10固化)"
```

---

## Task 6: targets CRUD + CSV 导入 route

**Files:**
- Create: `web/app/api/admin/targets/route.ts`
- Create: `web/app/api/admin/targets/import/route.ts`

- [ ] **Step 1: CRUD route（照 collect-lemeng 模式，createClient service 写）**

Create `web/app/api/admin/targets/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// GET: 列表（带指标值 JOIN）
export async function GET() {
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data, error } = await client.database
    .from('report_achievement_v')
    .select('*')
    .order('end_date', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

// POST: 新建目标（含 metric_values）
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, system_book_code, branch_num, start_date, end_date, note, created_by, metrics } = body;
  if (!name || !system_book_code || !branch_num || !start_date || !end_date || !metrics?.length) {
    return NextResponse.json({ error: 'missing fields (name/system_book_code/branch_num/start_date/end_date/metrics)' }, { status: 400 });
  }
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const { data: t, error: te } = await client.database
    .from('targets').upsert({ name, system_book_code, branch_num, start_date, end_date, note, created_by },
      { onConflict: 'system_book_code,branch_num,start_date,end_date' }).select();
  if (te || !t?.length) return NextResponse.json({ error: te?.message || 'upsert target failed' }, { status: 500 });
  const targetId = t[0].id;
  const rows = metrics.map((m: { metric_code: string; target_value: number }) =>
    ({ target_id: targetId, metric_code: m.metric_code, target_value: m.target_value }));
  const { error: me } = await client.database.from('target_metric_values').upsert(rows, { onConflict: 'target_id,metric_code' });
  if (me) return NextResponse.json({ error: me.message }, { status: 500 });
  return NextResponse.json({ success: true, target_id: targetId });
}
```

- [ ] **Step 2: CSV 导入 route（解析 CSV + 校验 + upsert + 错误报告）**

Create `web/app/api/admin/targets/import/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// 模板列: name,system_book_code,branch_num,start_date,end_date,target_sale[,target_purchase]
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File;
  if (!file) return NextResponse.json({ error: 'no file' }, { status: 400 });
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return NextResponse.json({ error: 'empty csv' }, { status: 400 });
  const header = lines[0].split(',').map(h => h.trim());
  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  // 校验 branch_num 存在
  const { data: branches } = await client.database.from('dim_branch').select('system_book_code,branch_num').eq('is_active', true);
  const branchSet = new Set((branches || []).map((b: any) => `${b.system_book_code}|${b.branch_num}`));
  let imported = 0; const errors: { row: number; reason: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const row: Record<string, string> = {};
    header.forEach((h, idx) => row[h] = cols[idx] ?? '');
    try {
      const { name, system_book_code, branch_num, start_date, end_date } = row;
      if (!name || !system_book_code || !branch_num || !start_date || !end_date) throw new Error('缺必填字段');
      if (!branchSet.has(`${system_book_code}|${branch_num}`)) throw new Error(`门店 ${system_book_code}/${branch_num} 不在 dim_branch`);
      if (end_date < start_date) throw new Error('end_date < start_date');
      const { data: t, error } = await client.database.from('targets')
        .upsert({ name, system_book_code, branch_num, start_date, end_date },
          { onConflict: 'system_book_code,branch_num,start_date,end_date' }).select();
      if (error || !t?.length) throw new Error(error?.message || 'upsert failed');
      const mv: { target_id: number; metric_code: string; target_value: number }[] = [];
      for (const h of header) {
        const m = h.match(/^target_(.+)$/);
        if (m && row[h]) mv.push({ target_id: t[0].id, metric_code: m[1], target_value: Number(row[h]) });
      }
      if (mv.length) {
        const { error: me } = await client.database.from('target_metric_values').upsert(mv, { onConflict: 'target_id,metric_code' });
        if (me) throw new Error(me.message);
      }
      imported++;
    } catch (e: any) { errors.push({ row: i + 1, reason: e.message }); }
  }
  return NextResponse.json({ imported, failed: errors.length, errors });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/api/admin/targets/route.ts web/app/api/admin/targets/import/route.ts
git commit -m "feat(report-d): targets CRUD + CSV 导入 route(service 身份,逐行校验)"
```

---

## Task 7: 后台 UI（录入 + 列表 + 固化 + 看板）

**Files:**
- Create: `web/app/admin/targets/page.tsx`

- [ ] **Step 1: 写 UI 页（最小可用：列表 + 新建表单 + 提前固化按钮 + 导入入口）**

Create `web/app/admin/targets/page.tsx`（参考现有 `web/app/admin/sources/page.tsx` 布局风格）:
```tsx
'use client';
import { useState, useEffect } from 'react';

export default function TargetsPage() {
  const [data, setData] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const load = async () => {
    const r = await fetch('/api/admin/targets'); setData((await r.json()).data || []);
  };
  useEffect(() => { load(); }, []);
  const closeTarget = async (id: number) => {
    if (!confirm(`提前结束并固化目标 ${id}？`)) return;
    await fetch('/api/admin/targets/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    load();
  };
  return (
    <div className="p-4">
      <h1>目标与达成率</h1>
      <button onClick={() => setShowForm(!showForm)}>新建目标</button>
      <button onClick={load}>刷新</button>
      {showForm && <TargetForm onSaved={() => { setShowForm(false); load(); }} />}
      <table className="w-full mt-4">
        <thead><tr><th>名称</th><th>品牌/店</th><th>战区</th><th>周期</th><th>指标</th><th>目标</th><th>实际</th><th>达成</th><th>进度</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={`${r.target_id}-${r.metric_code}`}>
              <td>{r.name}</td><td>{r.system_book_code}/{r.branch_num}</td><td>{r.war_zone}</td>
              <td>{r.start_date}~{r.end_date}</td><td>{r.metric_name}</td>
              <td>{r.target_value}{r.unit}</td>
              <td>{r.actual_value ?? '-'}</td>
              <td>{r.achievement_rate != null ? (r.achievement_rate * 100).toFixed(1) + '%' : '-'}</td>
              <td>{r.progress_rate != null ? (r.progress_rate * 100).toFixed(1) + '%' : '-'}</td>
              <td>{r.status}</td>
              <td>{r.status === 'active' && <button onClick={() => closeTarget(r.target_id)}>提前结束</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TargetForm({ onSaved }: { onSaved: () => void }) {
  const [f, setF] = useState({ name: '', system_book_code: '3120', branch_num: '', start_date: '', end_date: '', target_sale: '' });
  const submit = async () => {
    await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f, metrics: [{ metric_code: 'sale', target_value: Number(f.target_sale) }], created_by: 'admin' }) });
    onSaved();
  };
  return (
    <div className="border p-2 my-2">
      <input placeholder="名称" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
      <select value={f.system_book_code} onChange={e => setF({ ...f, system_book_code: e.target.value })}>
        <option value="3120">3120</option><option value="64188">64188</option>
      </select>
      <input placeholder="branch_num" value={f.branch_num} onChange={e => setF({ ...f, branch_num: e.target.value })} />
      <input type="date" value={f.start_date} onChange={e => setF({ ...f, start_date: e.target.value })} />
      <input type="date" value={f.end_date} onChange={e => setF({ ...f, end_date: e.target.value })} />
      <input placeholder="销售目标" value={f.target_sale} onChange={e => setF({ ...f, target_sale: e.target.value })} />
      <button onClick={submit}>保存</button>
    </div>
  );
}
```

- [ ] **Step 2: close route（UI 提前固化转发 close_target RPC）**

Create `web/app/api/admin/targets/close/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
export async function POST(req: NextRequest) {
  const { id } = await req.json();
  const r = await fetch(`${process.env.INSFORGE_API_BASE!}/rpc/close_target`, {
    method: 'POST',
    headers: { apikey: process.env.INSFORGE_API_KEY!, Authorization: `Bearer ${process.env.INSFORGE_API_KEY!}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_target_id: id }),
  });
  return NextResponse.json(await r.json().catch(() => ({})));
}
```

- [ ] **Step 3: Commit**

```bash
git add web/app/admin/targets/page.tsx web/app/api/admin/targets/close/route.ts
git commit -m "feat(report-d): 后台目标 UI(列表+新建+提前固化)+close route"
```

---

## Task 8: C4 推送 + 问数路由（SKILL.md 指引，MVP）

> 现状无服务端模板执行器（cron 触发 LLM 现场写 SQL）。MVP 改 SKILL.md 加目标类路由指引，让 LLM 查 report_achievement_v。确定性模板执行器列后续（spec §13 风险）。

**Files:**
- Modify: `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

- [ ] **Step 1: SKILL.md 加目标/达成率路由段**

在 SKILL.md 路由规则段追加：
```markdown
## 目标与达成率（report_achievement_v）
- 用户问"达成率/目标进度/谁没达标/复盘"→ 查 `report_achievement_v`（每目标×指标一行，含 target_value/actual_value/achievement_rate/progress_rate/status/data_status）。
- 多层级汇总（战区/品牌）：`SELECT war_zone, SUM(actual_value)/SUM(target_value) FROM report_achievement_v WHERE metric_code='sale' AND status='active' GROUP BY war_zone`。
- status=active 看实时进度（progress_rate 跑赢进度）；status=closed 看复盘（achievement_rate 固化值）。
- data_status=not_ready 表示该指标数据源未接入（如拿货），actual 不可用，如实告知。
- 定时推送「目标进度」：scheduled_reports mode=sql，query_intent 写明周期+层级（如"本周各战区销售达成率"），LLM 查 report_achievement_v + push_report。
```

- [ ] **Step 2: 部署 SKILL（清 Deno 缓存，属 plugin 改）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 3: Commit**

```bash
git add openclaw/data-query-plugin/skills/retail-query/SKILL.md
git commit -m "feat(report-d): SKILL.md 加目标/达成率路由指引(report_achievement_v)"
```

---

## Task 9: 端到端验证

- [ ] **Step 1: 录测试目标（UI 或直 SQL）**

UI 新建：3120/某店/本月/销售目标=100000。或 SQL：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
INSERT INTO targets(name,system_book_code,branch_num,start_date,end_date,created_by)
VALUES('测试7月','3120','<某活跃branch_num>','2026-07-01','2026-07-31','admin');
INSERT INTO target_metric_values(target_id,metric_code,target_value)
SELECT id,'sale',100000 FROM targets WHERE name='测试7月';
\""
```

- [ ] **Step 2: 验证 active 实时达成率**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT name,metric_code,target_value,actual_value,achievement_rate,progress_rate,status,data_status
FROM report_achievement_v WHERE name='测试7月';
\""
```
预期：actual_value=本月累计该店 sale，achievement_rate=actual/100000，progress_rate=按已过天数折算，status=active，data_status=partial（月中）。

- [ ] **Step 3: 验证手动固化 + closed 读 snapshot**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"
SELECT close_target((SELECT id FROM targets WHERE name='测试7月'));
SELECT target_id,metric_code,actual_value,achievement_rate,data_status FROM target_snapshots WHERE target_id=(SELECT id FROM targets WHERE name='测试7月');
SELECT name,status,actual_value FROM report_achievement_v WHERE name='测试7月';
\""
```
预期：close_target 返 ok+metrics；snapshot 有 sale 行（actual+rate+complete/partial）；视图 status=closed，actual_value=固化值。

- [ ] **Step 4: 验证权限裁剪（店长只见自己店）**

用某店长 wecom_id 的 claim 查视图（branch_nums 限定），确认只返其门店行。

- [ ] **Step 5: 验证三出口**

- 问数：企微问"测试7月达成率"→ LLM 查 report_achievement_v 返回。
- 推送：建 mode=sql scheduled_report，query_intent"测试7月销售达成"，cron 触发后推送。
- 看板：UI 列表显示达成率。

---

## 完成标志

- 4 表 + close_target + report_achievement_v 就位，迁移 046/047 幂等。
- 录入测试目标 → active 实时达成率正确 → 手动/自动固化 → closed 读 snapshot 正确。
- 三出口（问数/推送/看板）一致 + 权限裁剪通过。
- 部署：GHA（改 database/ + web/）+ restart postgrest + 清 Deno 缓存（SKILL）。
- 已知遗留：拿货达成率（等配送明细接入）、确定性模板执行器（C4 MVP 走 LLM）、admin 鉴权（同现状）。
