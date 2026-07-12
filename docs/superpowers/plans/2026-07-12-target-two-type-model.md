# 目标两类模型重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans 逐 Task 实现。Steps 用 `- [ ]` 跟踪。

**Goal:** 目标分两类——总部目标(出库金额/毛利 × 水果/标品耗材，不拆门店) + 门店目标(销售/配送，分解门店)。创建/管理范围，达成留 Phase 2。

**Architecture:** 复用 targets 的 total→breakdown(parent_target_id)，加 `target_type`(hq/store) + `category`(hq 品类轴)。spec：`docs/superpowers/specs/2026-07-12-target-two-type-model-design.md`，架构 §10.8。

**Tech Stack:** PostgreSQL 迁移 057 + Next.js App Router + PostgREST 直连 + SECURITY DEFINER RPC。

**关键坑（CLAUDE.md）：**
- `upsert_target_total` 改签名(加参数) → **必须 DROP FUNCTION 旧签名 + CREATE 新签名**（CREATE OR REPLACE 加参会生成重载，旧 7 参函数残留）
- UNIQUE 改造用 DO 块判断 conname（幂等）
- view 用 DROP+CREATE（非 CREATE OR REPLACE）
- 部署后 restart postgrest 刷 schema 缓存
- 改 migration+web → GHA 完整部署

---

## Task 1: 迁移 057（模型 + 指标 + 视图 + RPC）

**Files:** Create `database/migrations/057_target_two_type.sql`

- [ ] **Step 1: 写迁移文件**（内容如下，逐字）

```sql
-- 057_target_two_type.sql
-- 两类目标：targets 加 target_type/category + UNIQUE改造 + metric_definitions加3指标 + view加2列 + hq品类分解RPC
-- 幂等：ADD COLUMN IF NOT EXISTS；DO块改UNIQUE；INSERT ON CONFLICT；DROP+CREATE VIEW；DROP FUNCTION旧签名+CREATE新签名
-- ⚠️ upsert_target_total 加参数须 DROP 旧签名(7参) 再 CREATE 新签名(8参)，否则重载残留

-- ===== 1. targets 加列 =====
ALTER TABLE targets ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'store';
ALTER TABLE targets ADD COLUMN IF NOT EXISTS category TEXT;

-- ===== 2. UNIQUE 改造（加 target_type + category，避免 hq 多品类行/hq vs store 总目标冲突）=====
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_system_book_code_branch_num_start_date_end_date_key') THEN
    ALTER TABLE targets DROP CONSTRAINT targets_system_book_code_branch_num_start_date_end_date_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_type_branch_cat_key') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_type_branch_cat_key
      UNIQUE (system_book_code, target_type, branch_num, category, start_date, end_date);
  END IF;
END $$;

-- ===== 3. metric_definitions 加3指标（data_ready=false，达成Phase2接）=====
INSERT INTO metric_definitions (metric_code, name, source_dataset, value_column, unit, data_ready, enabled, description) VALUES
  ('outbound_amt', '出库金额', NULL, NULL, '元', false, true,
   '配送金额+批发销售金额(delivery_detail.out_money + wholesale_detail.wholesale_money)'),
  ('outbound_profit', '出库毛利', NULL, NULL, '元', false, true,
   '配送毛利+批发毛利(delivery_detail.profit_money + wholesale_detail.wholesale_profit)'),
  ('delivery', '配送', NULL, NULL, '元', false, true,
   '门店调入额(delivery_detail.out_money by response_branch_num)')
ON CONFLICT (metric_code) DO UPDATE SET name=EXCLUDED.name, unit=EXCLUDED.unit, enabled=EXCLUDED.enabled, description=EXCLUDED.description;

-- ===== 4. report_achievement_v 加 target_type/category 列（DROP+CREATE）=====
DROP VIEW IF EXISTS report_achievement_v;
CREATE VIEW report_achievement_v AS
SELECT
    t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
    t.system_book_code, t.branch_num, t.target_level, t.parent_target_id,
    t.target_type, t.category,
    b.branch_name, b.first_level_region AS war_zone, b.second_level_region AS region_l2, b.region_name, b.city,
    mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
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

-- ===== 5. upsert_target_total：DROP旧签名(7参)+CREATE新签名(8参,加 p_target_type)=====
DROP FUNCTION IF EXISTS upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT);
CREATE FUNCTION upsert_target_total(
  p_id BIGINT, p_name TEXT, p_sbc TEXT, p_start DATE, p_end DATE, p_metrics JSONB, p_target_type TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_id BIGINT; v_m JSONB;
BEGIN
  IF p_end < p_start THEN RETURN jsonb_build_object('ok',false,'error','周期结束<开始'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, target_type, created_by, created_at)
    VALUES (p_name, p_sbc, 'ALL', p_start, p_end, 'active', 'total', COALESCE(p_target_type,'store'), p_by, NOW()) RETURNING id INTO v_id;
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

-- ===== 6. upsert_hq_category_breakdown：总部品类分解 rows:[{category,metrics:{code:val}}]=====
CREATE OR REPLACE FUNCTION upsert_hq_category_breakdown(
  p_parent_id BIGINT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_cat TEXT; v_m TEXT; v_sub BIGINT; v_sbc TEXT; n INT:=0;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_cat := v_row->>'category';
    SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND category=v_cat LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, category, created_by, created_at)
      SELECT t.name||'-'||v_cat, v_sbc, 'ALL', t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, 'hq', v_cat, p_by, NOW()
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

-- ===== 7. get_hq_category_breakdown：返 [{category, metrics:{code:val}}] =====
CREATE OR REPLACE FUNCTION get_hq_category_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_out JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', t.category, 'metrics',
    COALESCE((SELECT jsonb_object_agg(mv.metric_code, mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id), '{}'::jsonb)
  ) ORDER BY t.category), '[]'::jsonb)
  INTO v_out
  FROM targets t
  WHERE t.parent_target_id=p_parent_id AND t.category IS NOT NULL;
  RETURN v_out;
END $$;

-- ===== 8. get_target_type：取目标类型(给 route 分派用，绕 RLS) =====
CREATE OR REPLACE FUNCTION get_target_type(p_id BIGINT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_t TEXT;
BEGIN
  SELECT target_type INTO v_t FROM targets WHERE id=p_id;
  RETURN v_t;
END $$;

GRANT EXECUTE ON FUNCTION upsert_target_total(BIGINT,TEXT,TEXT,DATE,DATE,JSONB,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_hq_category_breakdown(BIGINT,JSONB,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_hq_category_breakdown(BIGINT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_target_type(BIGINT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 057_target_two_type completed'; END $$;
```

- [ ] **Step 2: 不手动跑 prod SQL**（GHA migrate.sh 会跑）。直接 commit。
- [ ] **Step 3: commit**

```bash
git add database/migrations/057_target_two_type.sql
git commit -m "feat(target): 迁移057 两类目标模型(target_type/category+3指标+hq品类RPC)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: API（targets route 加 type + breakdown route 分派）

**Files:** Modify `web/app/api/admin/targets/route.ts` + `web/app/api/admin/targets/breakdown/route.ts`

- [ ] **Step 1: targets route POST 加 p_target_type**

`web/app/api/admin/targets/route.ts` 第 25 行 body 改为（加 `p_target_type`）：

```typescript
    body: JSON.stringify({ p_id: b.id ?? null, p_name: b.name, p_sbc: b.system_book_code || '3120', p_start: b.start_date, p_end: b.end_date, p_metrics: b.metrics, p_target_type: b.target_type || 'store', p_by: b.created_by || 'admin' }),
```

- [ ] **Step 2: breakdown route 改写（按 parent 类型分派 + 返 mode）**

整个文件 `web/app/api/admin/targets/breakdown/route.ts` 替换为：

```typescript
// web/app/api/admin/targets/breakdown/route.ts
// 目标分解：按 parent.target_type 分派(hq→品类 / store→门店)
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

async function parentType(pid: number): Promise<string> {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_target_type`, { method: 'POST', headers, body: JSON.stringify({ p_id: pid }) });
  return (await r.json()) || 'store';
}

// GET /api/admin/targets/breakdown?parent_id=X → {mode, rows, balance}
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  if (!pid) return NextResponse.json({ error: 'missing parent_id' }, { status: 400 });
  const mode = await parentType(Number(pid)) === 'hq' ? 'hq' : 'store';
  const br = mode === 'hq'
    ? await fetch(`${POSTGREST_URL}/rpc/get_hq_category_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json())
    : await fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json());
  const ck = await fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) }).then(r => r.json());
  return NextResponse.json({ mode, rows: br || [], balance: ck || {} });
}

// POST { parent_id, sbc?, rows } → 按 parent 类型分派
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b?.parent_id || !b?.rows) return NextResponse.json({ ok: false, error: '缺 parent_id/rows' }, { status: 400 });
  const mode = await parentType(Number(b.parent_id)) === 'hq' ? 'hq' : 'store';
  const url = mode === 'hq' ? `${POSTGREST_URL}/rpc/upsert_hq_category_breakdown` : `${POSTGREST_URL}/rpc/upsert_target_breakdown`;
  const body = mode === 'hq'
    ? JSON.stringify({ p_parent_id: Number(b.parent_id), p_rows: b.rows, p_by: 'admin' })
    : JSON.stringify({ p_parent_id: Number(b.parent_id), p_sbc: b.sbc || '3120', p_rows: b.rows, p_by: 'admin' });
  const r = await fetch(url, { method: 'POST', headers, body });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d);
}
```

- [ ] **Step 3: template route 补 delivery/outbound 指标映射**

`web/app/api/admin/targets/template/route.ts` 第 10 行（store 加 delivery 后，下载表头需本地化、上传需能解析「配送」列）：

```typescript
const METRIC_NAME: Record<string, string> = { sale: '销售总额', delivery: '配送', outbound_amt: '出库金额', outbound_profit: '出库毛利' };
```
> `CODE` 由 `METRIC_NAME` 自动反建，无需改。去掉 wholesale/purchase（消除隐患）。

- [ ] **Step 4: typecheck + commit**

```bash
cd web && npx tsc --noEmit && cd ..
git add web/app/api/admin/targets/route.ts web/app/api/admin/targets/breakdown/route.ts web/app/api/admin/targets/template/route.ts
git commit -m "feat(target): API targets route加target_type + breakdown按类型分派 + template指标映射补delivery

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 目标列表 + 两类新建 Form（page.tsx）

**Files:** Modify `web/app/admin/targets/page.tsx`（整体改写）

- [ ] **Step 1: 整体替换 page.tsx**

```tsx
// web/app/admin/targets/page.tsx
// 目标管理：两类目标(总部hq出库按品类 / 门店store销售配送) + 列表分两区 + 按类型新建
'use client';
import { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';

const HQ_METRICS = [
  { code: 'outbound_amt', name: '出库金额' },
  { code: 'outbound_profit', name: '出库毛利' },
];
const HQ_CATEGORIES = ['水果', '标品耗材'];
const STORE_METRICS = [
  { code: 'sale', name: '销售总额' },
  { code: 'delivery', name: '配送' },
];
const METRIC_NAME: Record<string, string> = {
  sale: '销售总额', delivery: '配送', outbound_amt: '出库金额', outbound_profit: '出库毛利',
};

export default function TargetsPage() {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState<null | 'hq' | 'store'>(null);
  const load = async () => {
    const r = await fetch('/api/admin/targets'); const j = await r.json();
    setList((j.data || []).filter((t: any) => t.target_level !== 'breakdown' || t.parent_target_id === null));
  };
  useEffect(() => { load(); }, []);

  const hq = list.filter(t => t.target_type === 'hq');
  const store = list.filter(t => t.target_type !== 'hq');

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">目标管理</h1>
      <div className="mb-4 flex gap-2">
        <button onClick={() => setForm('hq')} className="bg-primary text-white px-4 py-1 text-sm rounded-md">新建总部目标</button>
        <button onClick={() => setForm('store')} className="bg-primary text-white px-4 py-1 text-sm rounded-md">新建门店目标</button>
      </div>

      <h2 className="font-bold mb-2 mt-4">总部目标 <span className="text-xs text-gray-500 font-normal">（出库金额/毛利，按品类水果/标品耗材，不拆门店）</span></h2>
      <table className="w-full text-sm border-collapse tabular-nums mb-6">
        <thead><tr className="bg-gray-100">{['名称', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {hq.length === 0 && <tr><td colSpan={7} className="border p-2 text-gray-400 text-center">暂无总部目标</td></tr>}
          {hq.map(t => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{Number(t.target_value).toLocaleString()}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-primary">查看品类分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="font-bold mb-2">门店目标 <span className="text-xs text-gray-500 font-normal">（销售/配送，分解到门店）</span></h2>
      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-gray-100">{['名称', '品牌', '周期', '指标', '目标', '达成', '状态', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {store.length === 0 && <tr><td colSpan={8} className="border p-2 text-gray-400 text-center">暂无门店目标</td></tr>}
          {store.map(t => (
            <tr key={`${t.target_id}-${t.metric_code}`}>
              <td className="border p-2">{t.name}</td><td className="border p-2">{t.system_book_code}</td>
              <td className="border p-2">{t.start_date}~{t.end_date}</td>
              <td className="border p-2">{t.metric_name}</td><td className="border p-2">{Number(t.target_value).toLocaleString()}{t.unit}</td>
              <td className="border p-2">{t.achievement_rate != null ? (Number(t.achievement_rate) * 100).toFixed(0) + '%' : '-'}</td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2"><a href={`/admin/targets/${t.target_id}`} className="text-primary">分解</a></td>
            </tr>
          ))}
        </tbody>
      </table>

      {form === 'hq' && <HqForm onSaved={() => { setForm(null); load(); }} onClose={() => setForm(null)} />}
      {form === 'store' && <StoreForm onSaved={() => { setForm(null); load(); }} onClose={() => setForm(null)} />}
    </div>
  );
}

// 总部目标 form：名称+周期 + 2品类×2指标 网格 + 自动汇总
function HqForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m.code, '']))]))
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (cat: string, code: string, v: string) => setGrid(g => ({ ...g, [cat]: { ...g[cat], [code]: v } }));
  const sumOf = (code: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(grid[c]?.[code]) || 0), 0);

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    if (HQ_CATEGORIES.some(c => HQ_METRICS.some(m => !grid[c][m.code]))) { setErr('请填满 4 个目标值'); return; }
    setBusy(true);
    const totalMetrics = HQ_METRICS.map(m => ({ metric_code: m.code, target_value: sumOf(m.code) }));
    const r1 = await fetch('/api/admin/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, start_date: start, end_date: end, target_type: 'hq', metrics: totalMetrics }) });
    const j1 = await r1.json();
    if (!j1.ok) { setBusy(false); setErr(j1.error || '建总目标失败'); return; }
    const rows = HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m.code, Number(grid[c][m.code]) || 0])) }));
    const r2 = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: j1.target_id, rows }) });
    const j2 = await r2.json();
    setBusy(false);
    if (j2.ok) onSaved(); else setErr(j2.error || '品类分解失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建总部目标</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="col-span-1"><label className="text-xs text-gray-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月总部出库目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
        </div>

        <label className="text-xs text-gray-500">按品类填目标值（自动汇总=水果+标品耗材）</label>
        <table className="w-full text-sm border-collapse mt-1 mb-4 tabular-nums">
          <thead><tr className="bg-gray-100">
            <th className="border p-2 text-left font-normal">品类</th>
            {HQ_METRICS.map(m => <th key={m.code} className="border p-2 text-left font-normal">{m.name}(元)</th>)}
          </tr></thead>
          <tbody>
            {HQ_CATEGORIES.map(cat => (
              <tr key={cat}>
                <td className="border p-2">{cat}</td>
                {HQ_METRICS.map(m => <td key={m.code} className="border p-2"><input type="number" value={grid[cat][m.code]} onChange={e => set(cat, m.code, e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></td>)}
              </tr>
            ))}
            <tr className="bg-gray-50 font-medium">
              <td className="border p-2">合计</td>
              {HQ_METRICS.map(m => <td key={m.code} className="border p-2 text-right">{sumOf(m.code).toLocaleString()}</td>)}
            </tr>
          </tbody>
        </table>

        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-gray-300 px-4 py-1 text-sm rounded-md hover:bg-gray-50">取消</button>
          <button disabled={busy} onClick={submit} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">保存</button>
        </div>
      </div>
    </div>
  );
}

// 门店目标 form：现状明细表式（指标=行），指标=销售/配送
function StoreForm({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [rows, setRows] = useState<{ metric_code: string; target_value: string }[]>([{ metric_code: 'sale', target_value: '' }]);
  const [err, setErr] = useState('');
  const setRow = (i: number, patch: Partial<{ metric_code: string; target_value: string }>) => setRows(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const addRow = () => setRows([...rows, { metric_code: '', target_value: '' }]);
  const delRow = (i: number) => setRows(rows.filter((_, idx) => idx !== i));

  const submit = async () => {
    setErr('');
    if (!name || !start || !end) { setErr('请填名称和周期'); return; }
    const valid = rows.filter(r => r.metric_code && r.target_value);
    if (valid.length === 0) { setErr('至少填一个指标及其目标值'); return; }
    const dup = new Set(valid.map(r => r.metric_code));
    if (dup.size !== valid.length) { setErr('指标不能重复'); return; }
    const r = await fetch('/api/admin/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, start_date: start, end_date: end, target_type: 'store', metrics: valid.map(r => ({ metric_code: r.metric_code, target_value: Number(r.target_value) })) }),
    });
    const j = await r.json();
    if (j.ok) onSaved(); else setErr(j.error || '保存失败');
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-w-[92vw] max-h-[92vh] overflow-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="font-bold text-lg">新建门店目标</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="col-span-1"><label className="text-xs text-gray-500">目标名称</label><input value={name} onChange={e => setName(e.target.value)} placeholder="7月门店目标" className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">开始日期</label><input type="date" value={start} onChange={e => setStart(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
          <div><label className="text-xs text-gray-500">结束日期</label><input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border rounded-md w-full px-2 py-1 text-sm" /></div>
        </div>
        <label className="text-xs text-gray-500">指标明细 <span className="text-gray-400">（每行一个指标，可增删）</span></label>
        <table className="w-full text-sm border-collapse mt-1 mb-4">
          <thead><tr className="bg-gray-100">
            <th className="border p-2 text-left font-normal w-[45%]">指标</th>
            <th className="border p-2 text-left font-normal">目标值</th>
            <th className="border p-2 text-left font-normal w-12">操作</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="border p-1">
                  <select value={r.metric_code} onChange={e => setRow(i, { metric_code: e.target.value })} className="border rounded-md w-full px-2 py-1 text-sm bg-white">
                    <option value="">请选择...</option>
                    {STORE_METRICS.map(m => <option key={m.code} value={m.code}>{m.name}</option>)}
                  </select>
                </td>
                <td className="border p-1"><input type="number" value={r.target_value} onChange={e => setRow(i, { target_value: e.target.value })} placeholder="目标值" className="border rounded-md w-full px-2 py-1 text-sm text-right tabular-nums" /></td>
                <td className="border p-1 text-center"><button onClick={() => delRow(i)} className="text-gray-400 hover:text-red-600 inline-flex items-center justify-center"><Trash2 size={14} /></button></td>
              </tr>
            ))}
            <tr><td colSpan={3} className="border p-0"><button onClick={addRow} className="w-full py-2 text-sm text-primary hover:bg-primary/10 inline-flex items-center justify-center gap-1"><Plus size={14} /> 添加指标行</button></td></tr>
          </tbody>
        </table>
        {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={onClose} className="border border-gray-300 px-4 py-1 text-sm rounded-md hover:bg-gray-50">取消</button>
          <button onClick={submit} className="bg-primary text-white px-4 py-1 text-sm rounded-md hover:bg-primary/90">保存总目标</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd web && npx tsc --noEmit && cd ..
git add web/app/admin/targets/page.tsx
git commit -m "feat(target): 列表分两类 + 总部目标(品类2x2) + 门店目标(销售/配送) form

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 分解页按类型分派（[id]/page.tsx）

**Files:** Modify `web/app/admin/targets/[id]/page.tsx`（整体改写）

- [ ] **Step 1: 整体替换 [id]/page.tsx**

```tsx
// web/app/admin/targets/[id]/page.tsx
// 分解页：按 parent 类型分派——hq 品类2行grid / store 门店批量编辑(战区合并+下载上传)
'use client';
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Download, Upload, CheckCircle } from 'lucide-react';
import { useParams } from 'next/navigation';

const HQ_METRICS = ['outbound_amt', 'outbound_profit'];
const HQ_CATEGORIES = ['水果', '标品耗材'];
const METRIC_NAME: Record<string, string> = { sale: '销售总额', delivery: '配送', outbound_amt: '出库金额', outbound_profit: '出库毛利' };

export default function BreakdownPage() {
  const { id } = useParams<{ id: string }>();
  const [mode, setMode] = useState<'store' | 'hq'>('store');
  const [rows, setRows] = useState<any[]>([]);          // store: [{branch_num,...}] / hq: [{category,metrics}]
  const [balance, setBalance] = useState<any>({});
  const [metrics, setMetrics] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [hqGrid, setHqGrid] = useState<Record<string, Record<string, string>>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    const r = await fetch(`/api/admin/targets/breakdown?parent_id=${id}`); const j = await r.json();
    setMode(j.mode || 'store');
    setBalance(j.balance || {});
    if (j.mode === 'hq') {
      setMetrics(HQ_METRICS);
      const saved: Record<string, any> = Object.fromEntries((j.rows || []).map((x: any) => [x.category, x.metrics]));
      setHqGrid(Object.fromEntries(HQ_CATEGORIES.map(c => [c, Object.fromEntries(HQ_METRICS.map(m => [m, saved[c]?.[m] ?? '']))])));
    } else {
      setRows(j.rows || []);
      setMetrics(Object.keys(j.balance || {}).length ? Object.keys(j.balance) : (j.rows?.[0]?.metrics ? Object.keys(j.rows[0].metrics) : ['sale']));
    }
  };
  useEffect(() => { load(); }, []);

  // ===== store 门店分解 =====
  const setCell = (branch_num: string, m: string, v: string) => setRows(rs => rs.map(r => r.branch_num === branch_num ? { ...r, metrics: { ...r.metrics, [m]: v } } : r));
  const sumOf = (m: string) => rows.reduce((s, r) => s + (Number(r.metrics?.[m]) || 0), 0);
  const saveStore = async () => {
    const diffs = metrics.filter(m => (Number(balance[m]?.total) || 0) - sumOf(m) !== 0);
    if (diffs.length && !confirm(`有 ${diffs.length} 个指标分解与总目标有差额，确认保存？`)) return;
    const payload = rows.map(r => ({ branch_num: r.branch_num, metrics: Object.fromEntries(metrics.map(m => [m, Number(r.metrics?.[m] || 0)])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), sbc: '3120', rows: payload }) });
    const j = await r.json();
    if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); load(); } else alert('失败:' + JSON.stringify(j));
  };
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await fetch('/api/admin/targets/template', { method: 'POST', body: fd });
      const j = await r.json();
      if (j.rows) {
        const byBn = Object.fromEntries(j.rows.map((x: any) => [x.branch_num, x.metrics]));
        setRows(rs => rs.map(rw => byBn[rw.branch_num] ? { ...rw, metrics: { ...rw.metrics, ...byBn[rw.branch_num] } } : rw));
        alert(`已导入 ${j.count} 条，请核对后点「保存分解」`);
      } else { alert('解析失败：' + (j.error || JSON.stringify(j))); }
    } catch (err) { alert('解析失败：' + String(err)); }
    e.target.value = '';
  };
  const sorted = [...rows].sort((a, b) => (a.war_zone || '').localeCompare(b.war_zone || '') || (a.region_l2 || '').localeCompare(b.region_l2 || ''));
  const spanOf = (keyFn: (r: any) => string) => {
    const spans = new Array(sorted.length).fill(0);
    for (let i = 0; i < sorted.length;) { let j = i + 1; while (j < sorted.length && keyFn(sorted[j]) === keyFn(sorted[i])) j++; spans[i] = j - i; i = j; }
    return spans;
  };
  const wzSpans = spanOf(r => r.war_zone || '');
  const l2Spans = spanOf(r => (r.war_zone || '') + '|' + (r.region_l2 || ''));

  // ===== hq 品类分解 =====
  const setHq = (cat: string, m: string, v: string) => setHqGrid(g => ({ ...g, [cat]: { ...g[cat], [m]: v } }));
  const hqSum = (m: string) => HQ_CATEGORIES.reduce((s, c) => s + (Number(hqGrid[c]?.[m]) || 0), 0);
  const saveHq = async () => {
    const payload = HQ_CATEGORIES.map(c => ({ category: c, metrics: Object.fromEntries(HQ_METRICS.map(m => [m, Number(hqGrid[c]?.[m]) || 0])) }));
    const r = await fetch('/api/admin/targets/breakdown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent_id: Number(id), rows: payload }) });
    const j = await r.json();
    if (j.ok) { setSaved(true); setTimeout(() => setSaved(false), 2000); load(); } else alert('失败:' + JSON.stringify(j));
  };

  return (
    <div className="p-4">
      <a href="/admin/targets" className="text-primary text-sm inline-flex items-center gap-1"><ArrowLeft size={14} /> 返回目标列表</a>
      <h1 className="text-xl font-bold my-2">{mode === 'hq' ? '总部目标·品类分解' : '门店目标·门店分解'}</h1>

      {mode === 'hq' ? (
        <>
          <div className="mb-4 flex items-center gap-2">
            <button onClick={saveHq} className="bg-primary text-white px-4 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90">保存分解</button>
            {saved && <span className="text-green-600 text-sm inline-flex items-center gap-1"><CheckCircle size={14} /> 已保存</span>}
          </div>
          <table className="text-sm border-collapse tabular-nums">
            <thead><tr className="bg-gray-100">
              <th className="border p-2 text-left">品类</th>
              {HQ_METRICS.map(m => <th key={m} className="border p-2 text-left w-40">{METRIC_NAME[m]}(元)</th>)}
            </tr></thead>
            <tbody>
              {HQ_CATEGORIES.map(cat => (
                <tr key={cat}>
                  <td className="border p-2">{cat}</td>
                  {HQ_METRICS.map(m => <td key={m} className="border p-2"><input type="number" value={hqGrid[cat]?.[m] ?? ''} onChange={e => setHq(cat, m, e.target.value)} className="border rounded-md px-2 py-1 w-36 text-sm text-right tabular-nums" /></td>)}
                </tr>
              ))}
              <tr className="bg-gray-50 font-medium">
                <td className="border p-2">合计 / 总目标</td>
                {HQ_METRICS.map(m => <td key={m} className="border p-2 text-right">{hqSum(m).toLocaleString()} / {Number(balance[m]?.total || 0).toLocaleString()}</td>)}
              </tr>
            </tbody>
          </table>
        </>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            <a href={`/api/admin/targets/template?parent_id=${id}`} download className="inline-flex items-center gap-1.5 border border-primary text-primary px-4 py-1 text-sm rounded-md hover:bg-primary/5"><Download size={14} /> 下载模板</a>
            <input type="file" accept=".xlsx,.xls" ref={fileInputRef} onChange={handleImport} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 border border-primary text-primary px-4 py-1 text-sm rounded-md hover:bg-primary/5"><Upload size={14} /> 导入分解</button>
            <button onClick={saveStore} className="bg-primary text-white px-4 py-1 text-sm rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90">保存分解</button>
            {saved && <span className="text-green-600 text-sm inline-flex items-center gap-1"><CheckCircle size={14} /> 已保存</span>}
          </div>
          <table className="text-sm border-collapse tabular-nums">
            <thead><tr className="bg-gray-100">
              <th className="border p-2 text-left w-32">战区(一级)</th>
              <th className="border p-2 text-left w-28">二级区域</th>
              <th className="border p-2 text-left">门店号</th>
              <th className="border p-2 text-left">门店名</th>
              {metrics.map(m => <th key={m} className="border p-2 text-left w-28">{METRIC_NAME[m] || m}</th>)}
            </tr></thead>
            <tbody>
              {sorted.map((r, i) => (
                <tr key={r.branch_num}>
                  {wzSpans[i] > 0 && <td rowSpan={wzSpans[i]} className="border p-2 bg-primary/10 align-top font-medium">{r.war_zone || '-'}</td>}
                  {l2Spans[i] > 0 && <td rowSpan={l2Spans[i]} className="border p-2 align-top text-gray-600">{r.region_l2 || '-'}</td>}
                  <td className="border p-2">{r.branch_num}</td>
                  <td className="border p-2">{r.branch_name}</td>
                  {metrics.map(m => (
                    <td key={m} className="border p-2"><input type="number" value={r.metrics?.[m] ?? ''} onChange={e => setCell(r.branch_num, m, e.target.value)} className="border rounded-md px-1 w-24 text-sm text-right tabular-nums" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd web && npx tsc --noEmit && cd ..
git add web/app/admin/targets/[id]/page.tsx
git commit -m "feat(target): 分解页按类型分派(hq品类grid/store门店grid)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 部署 + restart postgrest + 验证

- [ ] **Step 1: push（遇 403 见 memory github-push-403-local-proxy，重试或 -c http.proxy=）**

```bash
git push origin main
```

- [ ] **Step 2: 监控 GHA**

```bash
gh run watch <run-id>
```
预期 quality + deploy 双 ✓。注意：eslint `Unexpected any` annotation 不阻断。

- [ ] **Step 3: restart postgrest（057 视图/RPC 刷 schema 缓存）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 4: 验证迁移落库**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT metric_code,name,data_ready FROM metric_definitions ORDER BY metric_code;\" -c \"SELECT conname FROM pg_constraint WHERE conname='targets_type_branch_cat_key';\" -c \"SELECT proname FROM pg_proc WHERE proname IN ('upsert_target_total','upsert_hq_category_breakdown','get_hq_category_breakdown','get_target_type') ORDER BY proname;\""
```
预期：metric_definitions 含 outbound_amt/outbound_profit/delivery；新 UNIQUE 约束存在；4 个 RPC 存在。

- [ ] **Step 5: 验证旧函数不残留（upsert_target_total 只 1 个签名）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT proname, oidvectortypes(proargtypes) AS args FROM pg_proc WHERE proname='upsert_target_total';\""
```
预期：**仅 1 行**（8 参）。若 2 行（7参+8参）= DROP 旧签名没生效，需排查。

- [ ] **Step 6: 端到端（页面）**
- `/admin/targets` 显示两区（总部/门店），两个新建按钮
- 新建总部目标：填 7月 + 出库金额(水果60万/标品40万) + 出库毛利(...) → 保存 → 列表出现 + 「查看品类分解」可进、显示 2 品类行 + 合计=总
- 新建门店目标：填 7月 + 销售/配送 → 保存 → 分解到门店（现状不变 + 配送列）
- DB 验证：`SELECT id,name,target_type,category FROM targets WHERE target_type='hq' ORDER BY id DESC LIMIT 3;` 看到 hq 总目标(category NULL)+2 品类分解(水果/标品耗材)

- [ ] **Step 7: 零破坏回归**
- 现有 sale 门店目标仍正常（target_type 默认 'store' 兼容）
- report_achievement_v sale 达成率仍算（LATERAL 未动）

---

## Self-Review 记录

- **spec 覆盖**：§4.1模型→Task1；§4.2指标→Task1；§4.3视图→Task1；§4.4RPC→Task1；§5 API→Task2；§6.1列表/§6.2HQform/§6.3Storeform→Task3；§6.3分解页→Task4；§8部署→Task5；§9成功标准→Task5验证。✓ 全覆盖。
- **签名一致**：`upsert_target_total(8参)` ↔ route POST `p_target_type` ↔ page `target_type:'hq'/'store'`；`upsert_hq_category_breakdown(p_parent_id,p_rows,p_by)` ↔ breakdown route hq 分支 ↔ HqForm `rows:[{category,metrics}]`；`get_hq_category_breakdown` 返 `[{category,metrics}]` ↔ [id] page hq 分支读。✓
- **坑**：upsert_target_total DROP旧签名(Step1注释⚠️+Step5验证只1行)；UNIQUE DO块幂等；view DROP+CREATE；restart postgrest；GHA部署。✓
- **旧数据兼容**：target_type DEFAULT 'store'（旧 targets 自动标 store）；report_achievement_v sale LATERAL 未动。✓
