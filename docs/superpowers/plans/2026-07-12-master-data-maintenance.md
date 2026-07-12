# 基础维表维护（Phase 1）· Plan A：门店维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 门店维护 CRUD——dim_branch 列表（385 行，base 只读）+ dim_branch_ext 行内编辑（custom_group/note）+ dim_region 战区映射（region→war_zone）+ 未映射区域预警，为报表战区维度铺路。

**Architecture:** admin 页 `/admin/branches`（3 tab）+ SECURITY DEFINER RPC + web 直连 PostgREST（`POSTGREST_URL || http://postgrest:3000`，同 D 子系统 admin 模式，因 INSFORGE_API_KEY 是 anon 角色）。新建 `branch_admin_v` 视图（dim_branch JOIN dim_region.war_zone JOIN dim_branch_ext）供列表查询；ext/region 编辑走 upsert RPC；未映射走 RPC。

**Tech Stack:** Next 16 / React 19 / shadcn/ui / Tailwind v4 / TanStack Table（可选，先用原生 table 照 admin 现状）/ PostgreSQL + PostgREST。

**Spec：** `docs/superpowers/specs/2026-07-12-master-data-maintenance-design.md` §三（门店维护）

---

## File Structure

- **Create** `database/migrations/051_branch_admin.sql` —— `branch_admin_v` 视图 + 4 个 SECURITY DEFINER RPC（列表/ ext upsert / region upsert / 未映射）+ GRANT anon+authenticated
- **Create** `web/app/api/admin/branches/route.ts` —— GET 门店列表（筛/分页）+ PATCH ext
- **Create** `web/app/api/admin/regions/route.ts` —— GET 区域映射列表 + POST upsert region
- **Create** `web/app/api/admin/regions/unmapped/route.ts` —— GET 未映射区域
- **Create** `web/app/admin/branches/page.tsx` —— 3 tab 页面（门店列表/区域战区映射/未映射预警）
- **Modify** `web/app/admin/layout.tsx` —— 侧栏加「门店维护」入口

---

## Task 1: 迁移 051 —— branch_admin_v 视图 + RPC + GRANT

**Files:** Create `database/migrations/051_branch_admin.sql`

- [ ] **Step 1: 写迁移文件**

```sql
-- 051_branch_admin.sql
-- 门店维护后台：branch_admin_v 视图(JOIN 战区+ext) + 4 个 SECURITY DEFINER RPC + GRANT
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（不用 CREATE OR REPLACE，CLAUDE.md 坑）；IF NOT EXISTS；GRANT 幂等

-- ===== 1. branch_admin_v：dim_branch JOIN dim_region(战区) JOIN dim_branch_ext(分组/备注) =====
DROP VIEW IF EXISTS branch_admin_v;
CREATE VIEW branch_admin_v AS
SELECT
  b.system_book_code, b.branch_num, b.branch_id, b.branch_code, b.branch_name,
  b.region_name, b.province, b.city, b.district, b.address, b.phone,
  b.enable, b.is_active,
  r.war_zone, r.sub_region,                                  -- 来自 dim_region
  e.custom_group, e.note,                                    -- 来自 dim_branch_ext
  CASE WHEN r.war_zone IS NULL AND b.region_name IS NOT NULL THEN true ELSE false END AS unmapped
FROM dim_branch b
LEFT JOIN dim_region r ON r.region_name = b.region_name
LEFT JOIN dim_branch_ext e ON e.system_book_code = b.system_book_code AND e.branch_num = b.branch_num
WHERE b.is_active = true;
ALTER VIEW branch_admin_v OWNER TO postgres;
ALTER VIEW branch_admin_v SET (security_invoker = true);
GRANT SELECT ON branch_admin_v TO authenticated, anon;

-- ===== 2. upsert_branch_ext：行内编辑 ext(custom_group/note)，SECURITY DEFINER 绕 RLS =====
CREATE OR REPLACE FUNCTION upsert_branch_ext(
  p_sbc TEXT, p_branch TEXT, p_group TEXT, p_note TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_branch_ext (system_book_code, branch_num, custom_group, note, updated_by, updated_at)
  VALUES (p_sbc, p_branch, p_group, p_note, p_by, NOW())
  ON CONFLICT (system_book_code, branch_num) DO UPDATE
    SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 3. upsert_region：dim_region upsert（region_name 主键），SECURITY DEFINER =====
CREATE OR REPLACE FUNCTION upsert_region(
  p_region TEXT, p_war_zone TEXT, p_sub TEXT, p_display TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_region (region_name, war_zone, sub_region, display_name, updated_at)
  VALUES (p_region, p_war_zone, p_sub, p_display, NOW())
  ON CONFLICT (region_name) DO UPDATE
    SET war_zone = EXCLUDED.war_zone, sub_region = EXCLUDED.sub_region, display_name = EXCLUDED.display_name, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 4. upsert_regions_batch：批量 upsert dim_region（CSV 导入用）=====
CREATE OR REPLACE FUNCTION upsert_regions_batch(p_rows JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    PERFORM upsert_region(r->>'region_name', r->>'war_zone', r->>'sub_region', r->>'display_name');
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'count', n);
END $$;

-- ===== 5. get_unmapped_regions：dim_branch 里有但 dim_region 没映射的 region_name =====
CREATE OR REPLACE FUNCTION get_unmapped_regions() RETURNS TABLE(region_name TEXT, branch_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT b.region_name, COUNT(*) AS branch_count
    FROM dim_branch b
    LEFT JOIN dim_region r ON r.region_name = b.region_name
    WHERE b.is_active = true AND b.region_name IS NOT NULL AND r.region_name IS NULL
    GROUP BY b.region_name ORDER BY branch_count DESC;
END $$;

GRANT EXECUTE ON FUNCTION upsert_branch_ext(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_region(TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_regions_batch(JSONB) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_unmapped_regions() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 051_branch_admin completed'; END $$;
```

- [ ] **Step 2: Commit**

```bash
git add database/migrations/051_branch_admin.sql
git commit -m "feat(admin): 051 门店维护-branch_admin_v视图+4 RPC(列表/ext/region/未映射)"
```

---

## Task 2: `/api/admin/branches` route（列表 + ext 编辑）

**Files:** Create `web/app/api/admin/branches/route.ts`

照 D 子系统 `web/app/api/admin/targets/route.ts` 模式：直连 PostgREST + SECURITY DEFINER RPC。

- [ ] **Step 1: 写 route**

```ts
// web/app/api/admin/branches/route.ts
// 门店维护：GET 列表(查 branch_admin_v，筛+分页) + PATCH ext(行内编辑)
// 直连 PostgREST（gateway 不代理 /rpc；同 D 子系统 targets route 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/branches?sbc=3120&war_zone=&region=&city=&q=&page=1&page_size=20
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const sbc = p.get('sbc') || '3120';
  const page = Number(p.get('page') || '1');
  const pageSize = Number(p.get('page_size') || '20');
  const and = [`system_book_code=eq.${sbc}`, `is_active=eq.true`];
  if (p.get('war_zone')) and.push(`war_zone=eq.${p.get('war_zone')}`);
  if (p.get('region')) and.push(`region_name=eq.${p.get('region')}`);
  if (p.get('city')) and.push(`city=eq.${p.get('city')}`);
  if (p.get('q')) and.push(`or=(branch_num.ilike.*${p.get('q')}*,branch_name.ilike.*${p.get('q')}*)`);
  const range = `${(page - 1) * pageSize}-${page * pageSize - 1}`;
  const r = await fetch(`${POSTGREST_URL}/branch_admin_v?select=*&${and.join('&')}&order=branch_num`, {
    headers: { ...headers, Range: range, Prefer: 'count=exact' },
  });
  const data = await r.json();
  const total = Number(r.headers.get('content-range')?.split('/')[1] || '0');
  return NextResponse.json({ data, total, page, pageSize });
}

// PATCH /api/admin/branches { system_book_code, branch_num, custom_group, note }
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  if (!b?.system_book_code || !b?.branch_num) return NextResponse.json({ ok: false, error: 'missing key' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_branch_ext`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_sbc: b.system_book_code, p_branch: b.branch_num, p_group: b.custom_group ?? '', p_note: b.note ?? '', p_by: b.by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
```

- [ ] **Step 2: tsc 检查**

Run: `cd web && npx tsc --noEmit`
Expected: 无错

- [ ] **Step 3: Commit**

```bash
git add web/app/api/admin/branches/route.ts
git commit -m "feat(admin): /api/admin/branches 门店列表+ext行内编辑 route"
```

---

## Task 3: `/api/admin/regions` + `/api/admin/regions/unmapped` route

**Files:** Create `web/app/api/admin/regions/route.ts`, `web/app/api/admin/regions/unmapped/route.ts`

- [ ] **Step 1: regions route（GET 列表 + POST upsert/batch）**

```ts
// web/app/api/admin/regions/route.ts
import { NextRequest, NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET 区域映射列表
export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/dim_region?select=*&order=region_name`, { headers });
  const data = await r.json();
  return NextResponse.json({ data });
}

// POST upsert 一条或批量 { region_name, war_zone, sub_region, display_name } 或 { rows: [...] }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (b.rows) {
    const r = await fetch(`${POSTGREST_URL}/rpc/upsert_regions_batch`, { method: 'POST', headers, body: JSON.stringify({ p_rows: b.rows }) });
    return NextResponse.json(await r.json().catch(() => ({ ok: false })));
  }
  if (!b.region_name) return NextResponse.json({ ok: false, error: 'missing region_name' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_region`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_region: b.region_name, p_war_zone: b.war_zone ?? '', p_sub: b.sub_region ?? '', p_display: b.display_name ?? '' }),
  });
  return NextResponse.json(await r.json().catch(() => ({ ok: false })));
}
```

- [ ] **Step 2: unmapped route**

```ts
// web/app/api/admin/regions/unmapped/route.ts
import { NextResponse } from 'next/server';
const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/rpc/get_unmapped_regions`, { method: 'POST', headers, body: '{}' });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}
```

- [ ] **Step 3: tsc + Commit**

```bash
cd web && npx tsc --noEmit && cd .. && git add web/app/api/admin/regions/ && git commit -m "feat(admin): /api/admin/regions 区域映射CRUD+未映射预警 route"
```

---

## Task 4: `/admin/branches` 页面（3 tab）

**Files:** Create `web/app/admin/branches/page.tsx`

照 admin 现有页风格（'use client' + useState/fetch + 原生 table + Tailwind）。3 tab：门店列表（ext 行内编辑）/ 区域→战区映射 / 未映射预警。

- [ ] **Step 1: 写页面**

```tsx
// web/app/admin/branches/page.tsx
// 门店维护：3 tab（门店列表 ext 行内编辑 / 区域战区映射 / 未映射预警）
'use client';
import { useState, useEffect } from 'react';

export default function BranchesPage() {
  const [tab, setTab] = useState<'list' | 'region' | 'unmapped'>('list');
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">门店维护</h1>
      <div className="flex gap-2 border-b mb-4">
        {([['list', '门店列表'], ['region', '区域→战区映射'], ['unmapped', '未映射区域预警']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm ${tab === k ? 'bg-blue-600 text-white rounded-t' : 'text-gray-600'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'list' && <BranchList />}
      {tab === 'region' && <RegionMap />}
      {tab === 'unmapped' && <Unmapped />}
    </div>
  );
}

// ===== 门店列表（base 只读 + ext 行内编辑）=====
function BranchList() {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ war_zone: '', region: '', city: '', q: '' });
  const [edit, setEdit] = useState<any>(null); // 当前编辑 ext 的行
  const pageSize = 20;

  const load = async () => {
    const q = new URLSearchParams({ sbc: '3120', page: String(page), page_size: String(pageSize), ...filter } as any);
    const r = await fetch(`/api/admin/branches?${q}`);
    const j = await r.json();
    setData(j.data || []); setTotal(j.total || 0);
  };
  useEffect(() => { load(); }, [page]);

  const saveExt = async () => {
    await fetch('/api/admin/branches', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_book_code: '3120', branch_num: edit.branch_num, custom_group: edit.custom_group, note: edit.note }) });
    setEdit(null); load();
  };

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <input placeholder="战区" value={filter.war_zone} onChange={e => setFilter({ ...filter, war_zone: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="区域" value={filter.region} onChange={e => setFilter({ ...filter, region: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="城市" value={filter.city} onChange={e => setFilter({ ...filter, city: e.target.value })} className="border px-2 py-1 text-sm rounded" />
        <input placeholder="搜索 门店号/名称" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} className="border px-2 py-1 text-sm rounded flex-1 min-w-[160px]" />
        <button onClick={() => { setPage(1); load(); }} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">查询</button>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['门店号', '名称', '区域', '战区', '城市', '启用', '分组(ext)', '备注(ext)', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={r.branch_num}>
              <td className="border p-2">{r.branch_num}</td>
              <td className="border p-2">{r.branch_name}</td>
              <td className="border p-2">{r.region_name}</td>
              <td className="border p-2">{r.war_zone || <span className="text-red-600">⚠ 未映射</span>}</td>
              <td className="border p-2">{r.city}</td>
              <td className="border p-2">{r.is_active ? '✅' : '❌'}</td>
              <td className="border p-2">{r.custom_group || '-'}</td>
              <td className="border p-2">{r.note || '-'}</td>
              <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-blue-600">编辑ext</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-sm text-gray-600">共 {total} 条 ·
        <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-2">上一页</button>
        第 {page} 页
        <button disabled={page * pageSize >= total} onClick={() => setPage(page + 1)} className="px-2">下一页</button>
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2">编辑 ext：{edit.branch_name}</h3>
            <label className="text-sm">自定义分组<input value={edit.custom_group || ''} onChange={e => setEdit({ ...edit, custom_group: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded" /></label>
            <label className="text-sm">备注<input value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} className="border w-full px-2 py-1 mb-3 rounded" /></label>
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-3 py-1 text-sm">取消</button><button onClick={saveExt} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 区域→战区映射（dim_region 行内编辑）=====
function RegionMap() {
  const [data, setData] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = async () => { const r = await fetch('/api/admin/regions'); const j = await r.json(); setData(j.data || []); };
  useEffect(() => { load(); }, []);
  const save = async () => {
    await fetch('/api/admin/regions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
    setEdit(null); load();
  };
  return (
    <div>
      <p className="text-sm text-gray-600 mb-2">改这里 → 所有该 region 的门店战区归属立即生效（报表战区维度由此算）。</p>
      <table className="w-full text-sm border-collapse">
        <thead><tr className="bg-gray-100">{['区域 region_name', '战区 war_zone', '子区域', '显示名', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r: any) => (
            <tr key={r.region_name}>
              <td className="border p-2">{r.region_name}</td>
              <td className="border p-2">{r.war_zone || <span className="text-red-600">⚠ 待补</span>}</td>
              <td className="border p-2">{r.sub_region}</td>
              <td className="border p-2">{r.display_name}</td>
              <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-blue-600">编辑</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-2">编辑映射：{edit.region_name}</h3>
            {[['war_zone', '战区'], ['sub_region', '子区域'], ['display_name', '显示名']].map(([k, label]) => (
              <label key={k} className="text-sm">{label}<input value={edit[k] || ''} onChange={e => setEdit({ ...edit, [k]: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded" /></label>
            ))}
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-3 py-1 text-sm">取消</button><button onClick={save} className="bg-blue-600 text-white px-3 py-1 text-sm rounded">保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 未映射预警 =====
function Unmapped() {
  const [data, setData] = useState<any[]>([]);
  const load = async () => { const r = await fetch('/api/admin/regions/unmapped'); const j = await r.json(); setData(j.data || []); };
  useEffect(() => { load(); }, []);
  return (
    <div>
      <p className="text-sm text-gray-600 mb-2">dim_branch 里有但 dim_region 没映射的区域（补上战区才能算战区报表）：</p>
      {data.length === 0 ? <p className="text-green-600">✅ 全部区域已映射</p> : (
        <table className="w-full text-sm border-collapse">
          <thead><tr className="bg-gray-100"><th className="border p-2 text-left">区域</th><th className="border p-2 text-left">门店数</th></tr></thead>
          <tbody>{data.map((r: any) => <tr key={r.region_name}><td className="border p-2">{r.region_name}</td><td className="border p-2">{r.branch_count}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: tsc + Commit**

```bash
cd web && npx tsc --noEmit && cd .. && git add web/app/admin/branches/page.tsx && git commit -m "feat(admin): /admin/branches 门店维护页(3 tab+ext行内编辑)"
```

---

## Task 5: admin 侧栏加「门店维护」入口

**Files:** Modify `web/app/admin/layout.tsx:38-49`

- [ ] **Step 1: 在侧栏「数据源」div 后、disabled 项前，加门店维护 + 目标管理（目标管理路由已有，补入口）**

定位锚点：`<div className="pt-4 border-t">`（disabled 项区块，约 line 46）。在它**之前**插入：

```tsx
            <div className="pt-2">
              <NavItem href="/admin/branches" icon="🏠">门店维护</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/targets" icon="🎯">目标管理</NavItem>
            </div>
```

（用 Edit 工具：old_string = `            <div className="pt-4 border-t">`，new_string = 上面的门店/目标 div + 原 `<div className="pt-4 border-t">`）

- [ ] **Step 2: Commit**

```bash
git add web/app/admin/layout.tsx
git commit -m "feat(admin): 侧栏加门店维护/目标管理入口(targets 去孤儿)"
```

---

## Task 6: 部署 + 验证

- [ ] **Step 1: push GHA（改了 web/database → GHA）**

```bash
git push origin main
gh run watch <run-id>
```
Expected: success

- [ ] **Step 2: 验证迁移生效（RPC + 视图）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) FROM branch_admin_v; SELECT proname FROM pg_proc WHERE proname IN ('upsert_branch_ext','upsert_region','upsert_regions_batch','get_unmapped_regions');\""
```
Expected: branch_admin_v 385 行；4 个 RPC 存在

- [ ] **Step 3: 验证门店列表 + ext 编辑**

```bash
curl -s "https://data.shanhaiyiguo.com/api/admin/branches?sbc=3120&page=1&page_size=3" | head -c 400
# ext 编辑
curl -s -X PATCH https://data.shanhaiyiguo.com/api/admin/branches -H 'Content-Type: application/json' -d '{"system_book_code":"3120","branch_num":"142","custom_group":"重点店","note":"测试"}'
```
Expected: 列表返回门店（含 war_zone/custom_group 字段）；ext 编辑返 {ok:true}

- [ ] **Step 4: 验证区域映射 + 未映射预警**

```bash
curl -s https://data.shanhaiyiguo.com/api/admin/regions | head -c 300
curl -s https://data.shanhaiyiguo.com/api/admin/regions/unmapped
```
Expected: regions 列表（19行）；unmapped 列出未映射区域（若有）

- [ ] **Step 5: 验证页面可访问**

打开 `https://data.shanhaiyiguo.com/admin/branches`（企微/浏览器，admin 登录），看 3 tab 能切、列表/编辑/映射/预警可用。

---

## Self-Review

- ✅ Spec 覆盖：spec §3.1（列表）→ Task 2+4；§3.2（region 映射）→ Task 1（RPC）+3+4；§3.3（未映射）→ Task 1（RPC）+3+4；§3.4（ext）→ Task 1（RPC）+2+4；侧栏入口 → Task 5。门店维护全覆盖。
- ✅ 无占位：迁移/route/page 完整代码。
- ✅ 类型一致：`upsert_branch_ext(p_sbc,p_branch,p_group,p_note,p_by)` / `upsert_region(p_region,p_war_zone,p_sub,p_display)` 定义与 route 调用一致。
- ✅ 幂等：迁移 DROP VIEW+CREATE / ON CONFLICT；CSV 批量用 `upsert_regions_batch`。
- ✅ 部署：改 web/database → GHA。

## 范围说明（Plan B 在后）

本 plan 只做**门店维护**（spec §三）。**目标分解**（spec §四，targets 改造总目标→分解+校验）是 Plan B，等本 plan 实现完再单独 plan（涉及 targets 加 parent_target_id/target_level + report_achievement_v 适配 branch_num='ALL' + 分解表+校验）。

## Execution Handoff

Plan A（门店维护）saved to `docs/superpowers/plans/2026-07-12-master-data-maintenance.md`。Two execution options:

1. **Subagent-Driven（推荐）** — 每 task 派 fresh subagent，task 间 review
2. **Inline** — 本 session 批量执行，checkpoint review

Which approach？（Plan B 目标分解的 plan 等本 plan 实现完再写，或你要现在就一起写也行）
