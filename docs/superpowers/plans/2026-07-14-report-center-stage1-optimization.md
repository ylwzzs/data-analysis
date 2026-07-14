# 报表中心阶段 1 优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阶段 1 优化报表中心——性能(getTrend 并行) + 视觉(rounded-lg/空状态/loading) + 64188 门店进销售排行(get_breakdown ALL + per-门店 brand + 重新分解)。

**Architecture:** 看板页取数改并行（getTrend 4 指标 Promise.all + outbound 双查并行）；DESIGN 一致（卡片圆角/空状态/加载骨架/tabular-nums）；64188 门店进销售排行靠迁移 062 重建 get_breakdown（ALL 返两品牌门店）+ upsert_target_breakdown（每门店 system_book_code 从 dim_branch 查）+ 前端去硬编码 sbc + 重新分解 id22。

**Tech Stack:** Next 16 App Router / React 19 / Tailwind v4 / PostgreSQL RPC（SECURITY DEFINER）/ @insforge/sdk（client.database.from）。

**Spec:** `docs/superpowers/specs/2026-07-14-report-center-stage1-optimization.md`

**已知坑（agent 须注意）：**
- SDK 用 `client.database.from(...)`（非 client.from）
- `getDeviceType()` async 无参
- 迁移 CREATE OR REPLACE FUNCTION 须显式 `SECURITY DEFINER`（不指定默认 INVOKER → permission denied，061 踩过）
- 本地 build 坑：SWC 错 `npm install @next/swc-darwin-arm64@16.2.9 --no-save`；Turbopack font 错 `rm -rf web/.next`
- push SOCKS5 断时 `git -c http.proxy= push` 绕过直连
- migrate 跑完须 restart postgrest 刷 schema（视图/RPC 改动）

---

## Task 1: 性能 — getTrend 4 指标并行 + outbound 双查并行

**Files:**
- Modify: `web/app/reports/targets/[id]/page.tsx:42-60`
- Modify: `web/lib/report-center/achievement.ts`（getTrend 内 outbound 双查）

- [ ] **Step 1: page.tsx getTrend 改 Promise.all 并行**

`page.tsx` L42-60 的 `for (const code of METRIC_ORDER) { await getTrend(...) }` 串行循环，改为：
```ts
  // 每个指标的趋势并行（outbound 走 delivery+wholesale 双查合并，失败降级空数组）
  const trendEntries = await Promise.all(METRIC_ORDER.map(async (code) => {
    const kr = kpi.find((k: any) => k.metric_code === code);
    if (!kr) return [code, []] as const;
    try {
      const t2 = await getTrend({
        system_book_code: t.system_book_code, branch_num: t.branch_num, category: t.category,
        start_date: t.start_date, end_date: t.end_date, target_value: kr.target_value, metric_code: code,
      });
      return [code, t2] as const;
    } catch {
      return [code, []] as const;
    }
  }));
  const trend: Record<string, any> = Object.fromEntries(trendEntries);
```

- [ ] **Step 2: achievement.ts getTrend outbound 双查并行**

`achievement.ts` getTrend 内，outbound 的 main + secondary 双查改并行。找到 `if (meta.secondaryTable && meta.secondaryValueCol)` 段，把 `const sec = await fetchDailySum(...)` 改为与 main 并行：
```ts
    const main = await fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn);
    let merged = main;
    if (meta.secondaryTable && meta.secondaryValueCol) {
      const sec = await fetchDailySum(client, meta.secondaryTable, meta.secondaryValueCol, target, meta.categoryIn);
      const byDate = new Map<string, number>();
      for (const d of main) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
      for (const d of sec) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
      merged = [...byDate.entries()].map(([date, value]) => ({ date, value }));
    }
```
改为 main/sec 并行：
```ts
    const [main, sec] = meta.secondaryTable && meta.secondaryValueCol
      ? await Promise.all([
          fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn),
          fetchDailySum(client, meta.secondaryTable, meta.secondaryValueCol, target, meta.categoryIn),
        ])
      : [await fetchDailySum(client, meta.trendTable, meta.trendValueCol, target, meta.categoryIn), []];
    let merged = main;
    if (sec.length) {
      const byDate = new Map<string, number>();
      for (const d of main) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
      for (const d of sec) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
      merged = [...byDate.entries()].map(([date, value]) => ({ date, value }));
    }
```

- [ ] **Step 3: build + commit**
```bash
cd web && npm run build 2>&1 | tail -10   # 遇 SWC/font 坑按已知坑修
git add web/app/reports/targets/\[id\]/page.tsx web/lib/report-center/achievement.ts
git commit -m "perf(report-center): getTrend 4指标并行+outbound双查并行(阶段1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 视觉 — 卡片 rounded-lg + 空状态 + tabular-nums

**Files:**
- Modify: `web/app/reports/targets/[id]/desktop.tsx`
- Modify: `web/app/reports/targets/[id]/mobile.tsx`
- Modify: `web/components/report-center/kpi-cards.tsx`
- Modify: `web/components/report-center/cross-table.tsx`

- [ ] **Step 1: desktop.tsx 卡片 rounded-md → rounded-lg + 空状态**

`desktop.tsx` L84/90 trend/rank 卡 `rounded-md` → `rounded-lg`。trend/rank 数据空时显示"暂无数据"：
```tsx
        <div className="col-span-2 rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-700">累计达成趋势 · {METRICS[focus].label}</h3>
          {focusTrend.length > 0 ? <LineChart data={focusTrend} /> : <div className="text-center text-slate-400 py-8 text-sm">暂无数据</div>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-700">{focusIsStore ? "门店" : "品类"}达成排行 · {METRICS[focus].label}</h3>
          {focusRank.length > 0 ? <RankChart data={focusRank} /> : <div className="text-center text-slate-400 py-8 text-sm">暂无数据</div>}
        </div>
```

- [ ] **Step 2: mobile.tsx 空状态 + tabular-nums**

`mobile.tsx` 趋势/排行卡数据空时显示"暂无数据"（同 desktop 模式）。卡片标题/数字补 `tabular-nums`（已有则保留）。

- [ ] **Step 3: kpi-cards.tsx + cross-table.tsx 空状态**

`kpi-cards.tsx`：rows 为空时显示"暂无指标数据"。`cross-table.tsx`：已有空兜底（"暂无门店数据"），确认保留。

- [ ] **Step 4: build + commit**
```bash
cd web && npm run build 2>&1 | tail -10
git add web/app/reports/targets/\[id\]/desktop.tsx web/app/reports/targets/\[id\]/mobile.tsx web/components/report-center/kpi-cards.tsx web/components/report-center/cross-table.tsx
git commit -m "style(report-center): 卡片rounded-lg+空状态+tabular-nums(阶段1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 视觉 — 看板 loading 骨架

**Files:**
- Create: `web/app/reports/targets/[id]/loading.tsx`

- [ ] **Step 1: 新建 loading.tsx（看板取数期间骨架，避免刷新闪空）**
```tsx
// web/app/reports/targets/[id]/loading.tsx
// 看板取数期间骨架（page.tsx Server Component 取数时显示，避免刷新闪空）
export default function Loading() {
  return (
    <div className="mx-auto max-w-7xl p-6 space-y-5">
      <div className="h-6 w-48 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-24 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />)}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
        <div className="h-72 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
      </div>
      <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-100" />
    </div>
  );
}
```

- [ ] **Step 2: build + commit**
```bash
cd web && npm run build 2>&1 | tail -10
git add web/app/reports/targets/\[id\]/loading.tsx
git commit -m "feat(report-center): 看板loading骨架(刷新不闪空,阶段1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 数据 — 迁移 062（get_breakdown + upsert_target_breakdown 支持全公司目标分两品牌门店）

**Files:**
- Create: `database/migrations/062_breakdown_all_brand.sql`

- [ ] **Step 1: 写迁移 062**

两个 RPC 都重建（CREATE OR REPLACE 显式 SECURITY DEFINER）：

```sql
-- 062_breakdown_all_brand.sql
-- 全公司目标(system_book_code='ALL')分解支持两品牌门店:
-- - get_breakdown: parent sbc='ALL' 时返两品牌全部门店(不只单品牌)
-- - upsert_target_breakdown: 每门店 system_book_code 从 dim_branch 查(按 branch_num 定品牌),不依赖单一 p_sbc
-- 幂等: CREATE OR REPLACE FUNCTION(显式 SECURITY DEFINER,防默认 INVOKER 致 permission denied,061 踩过)

-- 1. get_breakdown: ALL 时返两品牌门店
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER AS $function$
DECLARE v_sbc TEXT;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'branch_num', b.branch_num, 'branch_name', b.branch_name,
    'war_zone', b.first_level_region, 'group', e.custom_group,
    'system_book_code', b.system_book_code,
    'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value)
      FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
      WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num), '{}'::jsonb)
  ) ORDER BY b.first_level_region, b.branch_num), '[]'::jsonb)
  INTO v_sbc;
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99';
  RETURN COALESCE(v_sbc, '[]'::jsonb);
END $$;
```

> ⚠️ 上面的 PL/pgSQL 里 `SELECT ... INTO v_sbc FROM ...` 中间不能有 DECLARE 段干扰，实际写时把 `INTO v_sbc` 放对位置。完整正确版：
```sql
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'branch_num', b.branch_num, 'branch_name', b.branch_name,
    'war_zone', b.first_level_region, 'group', e.custom_group,
    'system_book_code', b.system_book_code,
    'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value)
      FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
      WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num), '{}'::jsonb)
  ) ORDER BY b.first_level_region, b.branch_num), '[]'::jsonb)
  INTO v_out
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99';
  RETURN v_out;
END $$;

-- 2. upsert_target_breakdown: 每门店 system_book_code 从 dim_branch 查(按 branch_num 定品牌),p_sbc 仅 fallback
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_branch TEXT; v_m TEXT; v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_branch := v_row->>'branch_num';
    -- 该门店的品牌(从 dim_branch 查),查不到 fallback p_sbc
    SELECT system_book_code INTO v_store_sbc FROM dim_branch WHERE branch_num=v_branch LIMIT 1;
    v_store_sbc := COALESCE(v_store_sbc, p_sbc);
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND branch_num=v_branch LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, created_by, created_at)
      SELECT t.name||'-'||v_branch, v_store_sbc, v_branch, t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id
      RETURNING id INTO v_sub;
    ELSE
      UPDATE targets SET system_book_code=v_store_sbc WHERE id=v_sub;
      DELETE FROM target_metric_values WHERE target_id=v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value)
      VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n := n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count',n);
END $$;

GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 062_breakdown_all_brand completed'; END $$;
```

- [ ] **Step 2: SSH 跑迁移 + restart postgrest 刷 schema**
```bash
cd /Users/Duo/Documents/MytechCode/data-analytics-platform
cat database/migrations/062_breakdown_all_brand.sql | ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1" 2>&1 | grep -iE "NOTICE|ERROR"
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```
预期：NOTICE 062 completed，无 ERROR。

- [ ] **Step 3: 验证 get_breakdown(22) 返两品牌门店 + upsert per-门店 brand**
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*), count(distinct system_book_code) FROM jsonb_to_recordset(get_breakdown(22)) AS x(system_book_code text, branch_num text);\""
```
预期：385 行（256+128 或实际 active 门店），2 个 system_book_code（3120+64188）。

- [ ] **Step 4: commit 迁移**
```bash
git add database/migrations/062_breakdown_all_brand.sql
git commit -m "feat(report-center): 迁移062 get_breakdown+upsert_target_breakdown支持全公司目标分两品牌门店(阶段1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 数据 — 前端 saveStore 去硬编码 sbc + route 默认 ALL

**Files:**
- Modify: `web/app/admin/targets/[id]/page.tsx:47`
- Modify: `web/app/api/admin/targets/breakdown/route.ts:28`

- [ ] **Step 1: `[id]/page.tsx` L47 saveStore 去硬编码 sbc**

`saveStore` 的 fetch body `sbc: '3120'` 改 `sbc: 'ALL'`（RPC 按 dim_branch 定门店品牌，sbc 仅 fallback）：
```ts
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: 'ALL', rows: payload }) });
```

- [ ] **Step 2: breakdown route POST p_sbc 默认 ALL**

`route.ts` L28 `p_sbc: b.sbc || '3120'` → `p_sbc: b.sbc || 'ALL'`：
```ts
    : JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || 'ALL', p_rows: b.rows, p_by: 'admin' });
```

- [ ] **Step 3: build + commit**
```bash
cd web && npm run build 2>&1 | tail -10
git add web/app/admin/targets/\[id\]/page.tsx web/app/api/admin/targets/breakdown/route.ts
git commit -m "feat(report-center): 分解页saveStore去硬编码sbc+route默认ALL(64188门店进销售排行,阶段1)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 部署 + 重新分解 id22 + 端到端验证

**Files:** 无（部署 + 验证）

- [ ] **Step 1: push 触发 GHA**
```bash
git push origin main   # SOCKS5 断则 git -c http.proxy= push
gh run watch <run-id>  # 预期 success（duckdb build 容错已在 deploy.sh）
```

- [ ] **Step 2: 验证分解页返两品牌门店**
- 登录 `/admin/targets/22` → 门店分解表应显示两品牌门店（3120 256 + 64188 128，按战区合并单元格）
- 若 id22 之前分解值在（3120 门店已分），保留；64188 门店行空白待填

- [ ] **Step 3: 重新分解 id22（用户操作，填 64188 门店目标）**
- 用户在分解页填 64188 门店销售/配送目标（或下载模板填上传）
- 点"保存门店分解"→ upsert_target_breakdown 每门店 system_book_code=该门店品牌

- [ ] **Step 4: 验证看板 sale 排行含 64188 门店**
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT system_book_code, count(distinct branch_num) FROM report_achievement_v WHERE parent_target_id=22 AND target_level='breakdown' AND target_type='store' GROUP BY 1;\""
```
预期：3120 + 64188 两品牌门店 breakdown。
- 打开 `/reports/targets/22` → 点 sale KPI → 门店排行应含 64188 门店
- 点 delivery KPI → 64188 门店 delivery "—"（无数据，正确，64188 无配送）

- [ ] **Step 5: 性能验证（首屏耗时）**
```bash
# 看板首屏（getTrend 并行后应明显快）
curl -s -o /dev/null -w "%{time_total}s\n" https://data.shanhaiyiguo.com/reports/targets/22
```

- [ ] **Step 6: 口径不变验证**
```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT metric_code, round(actual_value) FROM report_achievement_v WHERE target_id=22 AND target_level='total' ORDER BY metric_code;\""
```
预期：sale=1011万（双品牌）、delivery=3120、outbound=3120（口径铁律不变）。

- [ ] **Step 7: 更新 memory**

`frontend-presentation.md` 加阶段 1 完成（性能并行 + 视觉 + 64188 门店进销售排行）。

---

## 自审（writing-plans checklist）

**1. Spec coverage：**
- spec ④1 getTrend 并行 → Task 1 Step 1
- spec ④2 outbound 双查并行 → Task 1 Step 2
- spec ⑤1 卡片 rounded-lg → Task 2 Step 1
- spec ⑤2 空状态 + loading → Task 2（空状态）+ Task 3（loading）
- spec ⑤3 tabular-nums → Task 2 Step 2
- spec ⑥ get_breakdown ALL + upsert per-门店 brand + 前端 saveStore + 重新分解 → Task 4 + Task 5 + Task 6

**2. Placeholder scan：** 无 TBD/TODO，每步有具体代码/命令。

**3. Type 一致性：** getTrend 签名不变；get_breakdown/upsert_target_breakdown 签名不变（CREATE OR REPLACE 同签名）；breakdown route p_sbc 默认 ALL。

**4. 风险点：**
- 迁移 062 CREATE OR REPLACE 须显式 SECURITY DEFINER（061 踩过，plan 已标）
- get_breakdown 返字段加 `system_book_code`（前端分解页可能用，但不破坏现有 branch_num/branch_name/war_zone）
- upsert_target_breakdown 重建已存 breakdown 时 UPDATE system_book_code（64188 门店从 3120 改 64188）—— 重新分解前 id22 已存 256 门店（3120），重存时 system_book_code 按门店品牌更新（3120 门店保持 3120）
- recheck_breakdown_balance 不受影响（按 parent_id 聚合，不依赖 system_book_code）
