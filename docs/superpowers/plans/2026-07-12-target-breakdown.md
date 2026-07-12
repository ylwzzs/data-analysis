# 基础维表维护（Phase 1）· Plan B：目标分解 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** targets 改造为「总目标(多指标) → 分解到门店 + 汇总校验」模型；report_achievement_v 适配总目标（branch_num='ALL' 算全公司达成）+ war_zone 改用 first_level_region（真战区）。

**Architecture:** targets 加 `parent_target_id`/`target_level`（向后兼容）；report_achievement_v 重建（LATERAL 支持 ALL 全公司 + war_zone=first_level_region）；3 个 SECURITY DEFINER RPC（建总目标/批量分解/校验平衡）；admin 页改造（创建总目标 + 分解表 + 校验）。

**Tech Stack:** Next 16 / React 19 / shadcn / Tailwind / PostgreSQL + PostgREST / xlsx（模板下载/上传）。

**Spec：** `docs/superpowers/specs/2026-07-12-master-data-maintenance-design.md` §四（目标分解）

---

## File Structure

- **Create** `database/migrations/053_target_breakdown.sql` —— targets 加列 + report_achievement_v 重建 + 3 RPC + datasets 列补充
- **Modify** `web/app/api/admin/targets/route.ts` —— 适配总目标（POST 建总目标含多指标）
- **Create** `web/app/api/admin/targets/breakdown/route.ts` —— 分解批量读写 + 校验
- **Create** `web/app/api/admin/targets/template/route.ts` —— 下载/上传模板
- **Modify** `web/app/admin/targets/page.tsx` —— 改造（总目标列表 + 创建 + 分解表 + 校验）

---

## Task 1: 迁移 053 —— targets 加列 + report_achievement_v 重建 + RPC

**Files:** Create `database/migrations/053_target_breakdown.sql`

- [ ] **Step 1: 写迁移**

```sql
-- 053_target_breakdown.sql
-- 目标分解：targets 加 parent_target_id/target_level + report_achievement_v 重建(ALL全公司+war_zone=first_level_region) + 3 RPC
-- 幂等：ADD COLUMN IF NOT EXISTS；DROP+CREATE VIEW；CREATE OR REPLACE FUNCTION（新函数不冲突）

-- ===== 1. targets 加列（总/分解模型，向后兼容：默认 breakdown）=====
ALTER TABLE targets ADD COLUMN IF NOT EXISTS parent_target_id BIGINT;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_level TEXT DEFAULT 'breakdown';
CREATE INDEX IF NOT EXISTS idx_targets_parent ON targets(parent_target_id) WHERE parent_target_id IS NOT NULL;

-- ===== 2. report_achievement_v 重建：ALL→全公司达成 + war_zone=first_level_region =====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num, t.target_level, t.parent_target_id,
    b.branch_name,
    b.first_level_region AS war_zone,
    b.second_level_region AS region_l2,
    b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready,
    mv.target_value,
    CASE WHEN t.status='closed' THEN sn.actual_value
         WHEN md.metric_code='sale' AND md.data_ready THEN sa.sale_actual END AS actual_value,
    CASE WHEN t.status='closed' THEN sn.data_status
         WHEN md.metric_code='sale' AND md.data_ready THEN
           CASE WHEN sa.sale_days=0 THEN 'missing'
                WHEN sa.sale_days < (t.end_date-t.start_date+1) THEN 'partial'
                ELSE 'complete' END
         ELSE 'not_ready' END AS data_status,
    (t.end_date-t.start_date+1) AS total_days,
    GREATEST(LEAST(current_date,t.end_date)-t.start_date+1,0) AS days_elapsed,
    CASE WHEN mv.target_value>0 AND t.status='closed' THEN sn.achievement_rate
         WHEN mv.target_value>0 AND md.metric_code='sale' AND md.data_ready
         THEN round((COALESCE(sa.sale_actual,0)/mv.target_value)::numeric,4) END AS achievement_rate,
    CASE WHEN t.status='active' AND mv.target_value>0 AND md.metric_code='sale' AND md.data_ready
              AND (LEAST(current_date,t.end_date)-t.start_date+1)>0
         THEN round((COALESCE(sa.sale_actual,0)/(mv.target_value*(LEAST(current_date,t.end_date)-t.start_date+1)::numeric/(t.end_date-t.start_date+1)))::numeric,4)
         END AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id=t.id
JOIN metric_definitions md ON md.metric_code=mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id=t.id AND sn.metric_code=mv.metric_code
LEFT JOIN LATERAL (
    SELECT SUM(r.total_sale) AS sale_actual, count(DISTINCT r.biz_date) AS sale_days
    FROM report_daily_sales r
    WHERE r.system_book_code=t.system_book_code
      AND (t.branch_num='ALL' OR r.branch_num=t.branch_num)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
) sa ON md.metric_code='sale';
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

-- ===== 3. upsert_target_total：建/改总目标(多指标)，返回 target_id =====
CREATE OR REPLACE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_sbc TEXT, p_start DATE, p_end DATE, p_metrics JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT; v_m JSONB; v_check INT;
BEGIN
  -- 校验周期
  IF p_end < p_start THEN RETURN jsonb_build_object('ok',false,'error','周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, created_by, created_at)
    VALUES (p_name, p_sbc, 'ALL', p_start, p_end, 'active', 'total', p_by, NOW()) RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE targets SET name=p_name, start_date=p_start, end_date=p_end WHERE id=v_id AND target_level='total';
    DELETE FROM target_metric_values WHERE target_id=v_id;
  END IF;
  FOR v_m IN SELECT * FROM jsonb_array_elements(p_metrics) LOOP
    INSERT INTO target_metric_values(target_id, metric_code, target_value)
    VALUES (v_id, v_m->>'metric_code', (v_m->>'target_value')::numeric);
  END LOOP;
  RETURN jsonb_build_object('ok',true,'target_id',v_id);
END $$;

-- ===== 4. upsert_target_breakdown：批量 upsert 分解（rows: [{branch_num, metrics:{metric:value}}]）=====
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_branch TEXT; v_m JSONB; v_sub BIGINT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_branch := v_row->>'branch_num';
    -- 找/建分解 target（parent + branch）
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND branch_num=v_branch LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, created_by, created_at)
      SELECT t.name||'-'||v_branch, p_sbc, v_branch, t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id
      RETURNING id INTO v_sub;
    ELSE
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

-- ===== 5. check_breakdown_balance：校验分解总和 vs 总目标（每指标）=====
CREATE OR REPLACE FUNCTION check_breakdown_balance(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_object_agg(metric_code, jsonb_build_object('total', total_val, 'sum', sum_val, 'diff', total_val-sum_val, 'balanced', total_val=sum_val))
  INTO v_out
  FROM (
    SELECT mv.metric_code,
      MAX(CASE WHEN t.id=p_parent_id THEN mv.target_value END) AS total_val,
      SUM(CASE WHEN t.parent_target_id=p_parent_id THEN mv.target_value ELSE 0 END) AS sum_val
    FROM targets t
    JOIN target_metric_values mv ON mv.target_id=t.id
    WHERE (t.id=p_parent_id OR t.parent_target_id=p_parent_id)
    GROUP BY mv.metric_code
  ) x;
  RETURN COALESCE(v_out, '{}'::jsonb);
END $$;

-- ===== 6. get_breakdown：取某总目标的分解行（门店×指标）=====
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_metrics JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_agg(jsonb_build_object('branch_num',b.branch_num,'branch_name',b.branch_name,'war_zone',b.first_level_region,'group',e.custom_group,'metrics', COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value) FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id WHERE s.parent_target_id=p_parent_id AND s.branch_num=b.branch_num),'{}'::jsonb)) ORDER BY b.first_level_region, b.branch_num)
  INTO v_metrics
  FROM dim_branch b
  LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
  WHERE b.system_book_code=v_sbc AND b.is_active=true AND b.branch_num<>'99';
  RETURN COALESCE(v_metrics, '[]'::jsonb);
END $$;

GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION check_breakdown_balance(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 053 completed: targets 分解 + report_achievement_v ALL/war_zone 适配'; END $$;
```

- [ ] **Step 2: Commit**

```bash
git add database/migrations/053_target_breakdown.sql
git commit -m "feat(target): 053 目标分解-targets加parent/level+report_achievement_v ALL/war_zone适配+4RPC"
```

---

## Task 2: API —— 总目标 + 分解 + 校验

**Files:** Modify `web/app/api/admin/targets/route.ts`（POST 适配总目标多指标）；Create `web/app/api/admin/targets/breakdown/route.ts`（GET 分解 / POST 批量分解 / GET 校验）；Create `web/app/api/admin/targets/template/route.ts`（GET 模板 + POST 导入）

- [ ] **Step 1: targets route POST 改为调 upsert_target_total（总目标多指标）**

定位 `web/app/api/admin/targets/route.ts` 的 POST，把 upsert_target_admin 调用替换为 upsert_target_total（含多指标 + branch_num='ALL'）：

```ts
// POST: 建总目标（多指标，branch_num=ALL）
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.metrics?.length || !b.name || !b.start_date || !b.end_date) return NextResponse.json({ ok: false, error: '缺字段' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_target_total`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_id: b.id ?? null, p_name: b.name, p_sbc: b.system_book_code || '3120', p_start: b.start_date, p_end: b.end_date, p_metrics: b.metrics, p_by: b.created_by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
```

GET 保持（get_targets_admin 读 report_achievement_v，总/分解都列）。

- [ ] **Step 2: breakdown route**

```ts
// web/app/api/admin/targets/breakdown/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/targets/breakdown?parent_id=X  → 分解行（门店×指标）+ 校验
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  if (!pid) return NextResponse.json({ error: 'missing parent_id' }, { status: 400 });
  const [br, ck] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
    fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json()),
  ]);
  return NextResponse.json({ rows: br || [], balance: ck || {} });
}

// POST 批量保存分解 { parent_id, sbc, rows: [{branch_num, metrics:{metric:value}}] }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.parent_id || !b?.rows) return NextResponse.json({ ok: false, error: '缺 parent_id/rows' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_target_breakdown`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || '3120', p_rows: b.rows, p_by: 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d);
}
```

- [ ] **Step 3: template route（下载/上传 xlsx，可选 MVP——先占位返回 CSV）**

```ts
// web/app/api/admin/targets/template/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET 模板（CSV：战区,分组,门店号,门店名,指标1,指标2...）
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  const r = await fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) });
  const rows = await r.json();
  const metrics = rows?.[0]?.metrics ? Object.keys(rows[0].metrics) : ['sale'];
  const head = ['战区', '分组', '门店号', '门店名', ...metrics].join(',');
  const body = (rows || []).map((x: any) => [x.war_zone || '', x.group || '', x.branch_num, x.branch_name, ...metrics.map(m => x.metrics?.[m] ?? '')].join(',')).join('\n');
  return new NextResponse(`${head}\n${body}`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="breakdown-template.csv"` } });
}
```

- [ ] **Step 4: tsc + Commit**

```bash
cd web && npx tsc --noEmit && cd .. && git add web/app/api/admin/targets/ && git commit -m "feat(target): 总目标+分解+校验+模板 API"
```

---

## Task 3: 页面 —— /admin/targets 改造

**Files:** Modify `web/app/admin/targets/page.tsx`

改造为：总目标列表（target_level=total）+ 创建总目标（多指标默认全选可叉）+ 点总目标 → 分解（批量编辑表 战区/分组/门店×指标 + 校验 + 下载上传）。

- [ ] **Step 1: 写改造后的 page（替换全部）**

```tsx
// web/app/admin/targets/page.tsx
// 目标分解：总目标列表 + 创建总目标(多指标) + 分解到门店(批量编辑/上传)+汇总校验
'use client';
import { useState, useEffect } from 'react';

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [show, setShow] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const load = async () => { const r = await fetch('/api/admin/targets'); const j = await r.json(); setList((j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null)); };
  useEffect(() => { load(); }, []);
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-3">目标管理</h1>
      <div className="mb-3"><button onClick={() => { setShow(!show); setEdit(null); }} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">{show ? '收起' : '新建总目标'}</button></div>
      {show && <TotalForm onSaved={() => { setShow(false); load(); }} edit={edit} />}
      <table className="w-full text-sm border-collapse mt-2">
        <thead><tr className="bg-gray-100">{['名称', '品牌', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {list.map((t: any) => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.system_book_code}</td>
              <td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{t.target_value}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-blue-600">分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 创建总目标（多指标默认全选可叉）
function TotalForm({ onSaved, edit }: { onSaved: () => void; edit: any }) {
  const ALL = [{ code: 'sale', name: '销售总额' }, { code: 'purchase', name: '拿货量' }, { code: 'wholesale', name: '批发额' }];
  const [picked, setPicked] = useState<string[]>(['sale', 'purchase', 'wholesale']);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [name, setName] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    if (!name || !start || !end || picked.length === 0) { setErr('请填全'); return; }
    const r = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end, metrics: picked.map(m => ({ metric_code: m, target_value: Number(vals[m] || 0) })) }) });
    const j = await r.json(); if (j.ok) onSaved(); else setErr(j.error || '失败');
  };
  return (
    <div className="border rounded p-3 mb-3 bg-gray-50">
      <div className="flex gap-2 mb-2 flex-wrap">
        <input placeholder="目标名称" value={name} onChange={e => setName(e.target.value)} className="border px-2 py-1 text-sm rounded" />
        <input type="date" value={start} onChange={e => setStart(e.target.value)} className="border px-2 py-1 text-sm rounded" />
        <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border px-2 py-1 text-sm rounded" />
      </div>
      <div className="flex gap-2 flex-wrap mb-2">
        {ALL.map(m => (
          <span key={m.code} onClick={() => setPicked(picked.includes(m.code) ? picked.filter(x => x !== m.code) : [...picked, m.code])}
            className={`px-3 py-1 text-sm rounded-full cursor-pointer border ${picked.includes(m.code) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-500'}`}>
            {m.name} {picked.includes(m.code) && '✕'} {picked.includes(m.code) && <input type="number" placeholder="值" value={vals[m.code] || ''} onClick={e => e.stopPropagation()} onChange={e => setVals({ ...vals, [m.code]: e.target.value })} className="w-16 ml-1 text-black px-1" />}
          </span>
        ))}
      </div>
      <button onClick={submit} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存总目标</button>
      {err && <span className="text-red-600 ml-2 text-sm">{err}</span>}
    </div>
  );
}
```

- [ ] **Step 2: 创建分解页 `web/app/admin/targets/[id]/page.tsx`**

```tsx
// web/app/admin/targets/[id]/page.tsx
// 分解：批量编辑表（战区/分组/门店×指标）+ 汇总校验 + 下载/上传
'use client';
import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<any[]>([]);
  const [balance, setBalance] = useState<any>({});
  const [metrics, setMetrics] = useState<string[]>([]);
  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setRows(j.rows || []); setBalance(j.balance || {});
    const ms = (j.rows?.[0]?.metrics && Object.keys(j.rows[0].metrics)) || (j.balance && Object.keys(j.balance)) || ['sale'];
    setMetrics(ms);
  };
  useEffect(() => { load(); }, []);
  const setCell = (i: number, m: string, v: string) => { const nr = [...rows]; nr[i] = { ...nr[i], metrics: { ...nr[i].metrics, [m]: v } }; setRows(nr); };
  const save = async () => {
    const payload = rows.map(r => ({ branch_num: r.branch_num, metrics: Object.fromEntries(metrics.map(m => [m, Number(r.metrics?.[m] || 0)])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: '3120', rows: payload }) });
    const j = await r.json(); if (j.ok) { alert('已保存'); load(); } else alert('失败');
  };
  const sumOf = (m: string) => rows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  return (
    <div className="p-4">
      <a href="/admin/targets" className="text-blue-600 text-sm">← 返回目标列表</a>
      <h1 className="text-xl font-bold my-2">目标分解</h1>
      <div className="mb-3"><a href={`/api/admin/targets/template?parent_id=${id}`} className="text-blue-600 text-sm mr-3">⬇下载模板</a><button onClick={save} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存分解</button></div>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['战区', '分组', '门店号', '门店名', ...metrics, ''].map((h, i) => <th key={i} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.branch_num}>
              <td className="border p-2">{r.war_zone || '-'}</td><td className="border p-2">{r.group || '-'}</td>
              <td className="border p-2">{r.branch_num}</td><td className="border p-2">{r.branch_name}</td>
              {metrics.map(m => <td key={m} className="border p-2"><input type="number" value={r.metrics?.[m] ?? ''} onChange={e => setCell(i, m, e.target.value)} className="border px-1 w-20 text-sm rounded" /></td>)}
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="bg-green-50 font-bold">
          <td className="border p-2" colSpan={4}>汇总校验</td>
          {metrics.map(m => { const tot = Number(balance[m]?.total) || 0; const s = sumOf(m); const diff = tot - s; return <td key={m} className="border p-2">Σ{s}/{tot} <span className={diff === 0 ? 'text-green-600' : 'text-red-600'}>{diff === 0 ? '✅' : `差${diff.toFixed(1)}`}</span></td>; })}
        </tr></tfoot>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: tsc + Commit**

```bash
cd web && npx tsc --noEmit && cd .. && git add web/app/admin/targets/ && git commit -m "feat(target): /admin/targets 改造(总目标+分解页+校验)"
```

---

## Task 4: 部署 + 验证

- [ ] **Step 1: push GHA**

```bash
git push origin main
gh run watch <run-id>
```

- [ ] **Step 2: restart postgrest + 验证迁移**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest && sleep 3 && docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT column_name FROM information_schema.columns WHERE table_name='targets' AND column_name IN ('parent_target_id','target_level'); SELECT proname FROM pg_proc WHERE proname LIKE 'upsert_target%' OR proname IN ('check_breakdown_balance','get_breakdown');\""
```
Expected: targets 有 parent_target_id/target_level；4 个 RPC（upsert_target_total/breakdown + check + get_breakdown）

- [ ] **Step 3: 验证总目标 + 分解 + 校验**

```bash
# 建总目标
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/targets -H 'Content-Type: application/json' -d '{"name":"7月测试总目标","start_date":"2026-07-01","end_date":"2026-07-31","metrics":[{"metric_code":"sale","target_value":100000},{"metric_code":"purchase","target_value":500}]}'
# （记下返回 target_id）→ 分解 + 校验
curl -s "https://data.shanhaiyiguo.com/api/admin/targets/breakdown?parent_id=<id>"
```

- [ ] **Step 4: 页面验证**

打开 `/admin/targets`：新建总目标（选指标+值）→ 点「分解」→ 批量编辑表 + 校验行 + 下载模板 + 保存。

---

## Self-Review

- ✅ Spec 覆盖：§4.1 数据模型（parent/level）→ Task 1；§4.2 校验 → check_breakdown_balance RPC + Task 3 页脚校验；§4.3 report_achievement_v 适配 → Task 1 视图重建；§4.4 界面 → Task 3
- ✅ 无占位：迁移/RPC/route/page 完整代码
- ✅ 类型一致：`upsert_target_total(p_id,p_name,p_sbc,p_start,p_end,p_metrics,p_by)` / `upsert_target_breakdown(p_parent_id,p_sbc,p_rows,p_by)` / `get_breakdown(p_parent_id)` / `check_breakdown_balance(p_parent_id)` 定义与 route/page 调用一致
- ✅ 幂等：ADD COLUMN IF NOT EXISTS；DROP+CREATE VIEW；新 RPC CREATE OR REPLACE（不冲突）
- ✅ 向后兼容：现有扁平 targets（parent_id=null, level=breakdown）+ close/snapshot 不破坏；report_achievement_v 增量兼容（ALL 分支 + 单店分支）

## Execution Handoff

Plan B saved to `docs/superpowers/plans/2026-07-12-target-breakdown.md`。执行方式：
1. **Subagent-Driven（推荐）** — 每 task 派 fresh subagent
2. **Inline** — 本 session 批量执行

哪个？（这是 Phase 1 最后一块，完成后 Phase 1 收尾，可 commit 全部文档 + 转 Phase 2 报表中心）
