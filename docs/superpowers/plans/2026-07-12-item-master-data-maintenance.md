# 商品档案维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建 `/admin/items` 商品档案维护页：4.1万行列表（品牌切换+筛选+分页）+ dim_item_ext 两列编辑（单行 Modal + 勾选多行批量工具栏），零改表（ext 列已存在）。

**Architecture:** 照搬门店维护（`/admin/branches`）结构 —— `item_admin_v` 视图（dim_item LEFT JOIN dim_item_ext）+ `upsert_item_ext`/`upsert_items_ext_batch` SECURITY DEFINER RPC + 直连 PostgREST 的 API route + client 页面。新增：勾选列 + 底部批量工具栏。spec：`docs/superpowers/specs/2026-07-12-item-master-data-maintenance-design.md`。

**Tech Stack:** PostgreSQL（迁移 055）+ Next.js App Router（server route + client page）+ PostgREST（直连 `http://postgrest:3000`）+ lucide-react 图标 + Tailwind。

**参考文件（照搬/镜像）：**
- `database/migrations/051_branch_admin.sql` —— 视图+RPC+GRANT 模式
- `web/app/api/admin/branches/route.ts` —— API route 模式
- `web/app/admin/branches/page.tsx` —— 页面结构 + Modal 模式
- `web/app/admin/layout.tsx` —— 侧栏入口

**测试策略：** 本仓库 admin 页无单测基建（门店维护/目标管理均无测试），沿用验证式：TypeScript 编译 + 迁移 SQL 语法 + 部署后人工 curl/SQL/页面验证（成功标准见 spec §九）。每个 Task 末尾 commit。

---

## Task 1: 迁移 055 —— item_admin_v 视图 + 2 RPC + GRANT

**Files:**
- Create: `database/migrations/055_item_admin.sql`

- [ ] **Step 1: 写迁移文件 `database/migrations/055_item_admin.sql`**

```sql
-- 055_item_admin.sql
-- 商品档案维护后台：item_admin_v 视图(dim_item JOIN ext) + 2 个 SECURITY DEFINER RPC + GRANT
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（不用 CREATE OR REPLACE，CLAUDE.md 坑）；GRANT 幂等
-- 零改表：dim_item_ext(custom_group/note) 已由 024_master_data.sql 建好，本迁移不动表结构

-- ===== 1. item_admin_v：dim_item LEFT JOIN dim_item_ext =====
DROP VIEW IF EXISTS item_admin_v;
CREATE VIEW item_admin_v AS
SELECT
  i.system_book_code, i.item_num, i.item_code, i.bar_code,
  i.item_name, i.category_name, i.category_path, i.top_category,
  i.item_brand, i.item_tags, i.is_active,
  e.custom_group, e.note                                          -- 来自 dim_item_ext（人工维护）
FROM dim_item i
LEFT JOIN dim_item_ext e ON e.system_book_code = i.system_book_code AND e.item_num = i.item_num
WHERE i.is_active = true;
ALTER VIEW item_admin_v OWNER TO postgres;
ALTER VIEW item_admin_v SET (security_invoker = true);
GRANT SELECT ON item_admin_v TO authenticated, anon;

-- ===== 2. upsert_item_ext：单行 ext(custom_group/note)，SECURITY DEFINER 绕 RLS =====
CREATE OR REPLACE FUNCTION upsert_item_ext(
  p_sbc TEXT, p_item TEXT, p_group TEXT, p_note TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
  VALUES (p_sbc, p_item, p_group, p_note, p_by, NOW())
  ON CONFLICT (system_book_code, item_num) DO UPDATE
    SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 3. upsert_items_ext_batch：批量 upsert ext（勾选多行设分组/备注）=====
-- p_rows 元素 = {system_book_code, item_num, custom_group, note, updated_by}（全值，前端拼）
CREATE OR REPLACE FUNCTION upsert_items_ext_batch(p_rows JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
    VALUES (r->>'system_book_code', r->>'item_num', r->>'custom_group', r->>'note', r->>'updated_by', NOW())
    ON CONFLICT (system_book_code, item_num) DO UPDATE
      SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'count', n);
END $$;

GRANT EXECUTE ON FUNCTION upsert_item_ext(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_items_ext_batch(JSONB) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 055_item_admin completed'; END $$;
```

- [ ] **Step 2: 本地校验 SQL 语法（在本地 dev postgres 跑，幂等可重跑）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec -i deploy-postgres-1 psql -U postgres -d insforge" < database/migrations/055_item_admin.sql
```
> 注：生产 GHA 部署会重跑全部迁移（migrate.sh），此步是提前在生产 DB 手动验证语法 + 让本地开发可立即用。若不想动生产，跳过此步等 GHA。预期输出末尾 `NOTICE:  Migration 055_item_admin completed`，无 ERROR。

- [ ] **Step 3: 验证视图/RPC 存在**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '\df upsert_item_ext' -c '\df upsert_items_ext_batch' -c '\dv item_admin_v'"
```
预期：列出 2 个 function + 1 个 view。

- [ ] **Step 4: 重启 postgrest 刷 schema 缓存（关键，否则新视图/RPC 400）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 5: commit**

```bash
git add database/migrations/055_item_admin.sql
git commit -m "feat(item-admin): 迁移055 item_admin_v视图 + upsert_item_ext/upsert_items_ext_batch RPC

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: API route `/api/admin/items`（GET 列表 + PATCH 单行 + POST 批量）

**Files:**
- Create: `web/app/api/admin/items/route.ts`

- [ ] **Step 1: 写 route `web/app/api/admin/items/route.ts`**

```typescript
// web/app/api/admin/items/route.ts
// 商品档案维护：GET 列表(查 item_admin_v，筛+分页) + PATCH ext(单行) + POST ext(批量)
// 直连 PostgREST（gateway 不代理 /rpc；同 branches route 模式）
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// GET /api/admin/items?sbc=3120&top_category=&custom_group=&q=&page=1&page_size=20
//     或 ?distinct=top_category&sbc=3120 → 返回去重品类列表 {data:[...]}}
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  // distinct 支持：品类下拉用
  if (p.get('distinct') === 'top_category') {
    const sbcD = p.get('sbc') || '3120';
    const r = await fetch(`${POSTGREST_URL}/item_admin_v?select=top_category&system_book_code=eq.${sbcD}&is_active=eq.true&order=top_category`, { headers });
    const rows = await r.json();
    const set = new Set(rows.map((x: any) => x.top_category).filter(Boolean));
    return NextResponse.json({ data: [...set] });
  }
  const sbc = p.get('sbc') || '3120';
  const page = Number(p.get('page') || '1');
  const pageSize = Number(p.get('page_size') || '20');
  const and = [`system_book_code=eq.${sbc}`, `is_active=eq.true`];
  if (p.get('top_category')) and.push(`top_category=eq.${p.get('top_category')}`);
  if (p.get('custom_group')) and.push(`custom_group=eq.${p.get('custom_group')}`);
  if (p.get('q')) {
    const q = p.get('q')!;
    and.push(`or=(item_num.ilike.*${q}*,item_name.ilike.*${q}*,item_code.ilike.*${q}*,bar_code.ilike.*${q}*)`);
  }
  const range = `${(page - 1) * pageSize}-${page * pageSize - 1}`;
  const r = await fetch(`${POSTGREST_URL}/item_admin_v?select=*&${and.join('&')}&order=item_num`, {
    headers: { ...headers, Range: range, Prefer: 'count=exact' },
  });
  const data = await r.json();
  const total = Number(r.headers.get('content-range')?.split('/')[1] || '0');
  return NextResponse.json({ data, total, page, pageSize });
}

// PATCH /api/admin/items { system_book_code, item_num, custom_group, note }
export async function PATCH(req: NextRequest) {
  const b = await req.json();
  if (!b?.system_book_code || !b?.item_num) return NextResponse.json({ ok: false, error: 'missing key' }, { status: 400 });
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_item_ext`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_sbc: b.system_book_code, p_item: b.item_num, p_group: b.custom_group ?? '', p_note: b.note ?? '', p_by: b.by || 'admin' }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}

// POST /api/admin/items { rows: [{system_book_code,item_num,custom_group,note}], by? }
export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!Array.isArray(b?.rows) || b.rows.length === 0) return NextResponse.json({ ok: false, error: 'empty rows' }, { status: 400 });
  const p_rows = b.rows.map((r: any) => ({
    system_book_code: r.system_book_code, item_num: r.item_num,
    custom_group: r.custom_group ?? '', note: r.note ?? '', updated_by: b.by || 'admin',
  }));
  const r = await fetch(`${POSTGREST_URL}/rpc/upsert_items_ext_batch`, {
    method: 'POST', headers,
    body: JSON.stringify({ p_rows }),
  });
  const d = await r.json().catch(() => ({ ok: false }));
  return NextResponse.json(d, { status: d?.ok ? 200 : 400 });
}
```

- [ ] **Step 2: TypeScript 编译校验**

```bash
cd web && npx tsc --noEmit
```
预期：无 error（route.ts 类型干净）。`cd ..` 回根目录。

- [ ] **Step 3: commit**

```bash
git add web/app/api/admin/items/route.ts
git commit -m "feat(item-admin): /api/admin/items route (GET列表+PATCH单行+POST批量)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 页面 `/admin/items`（列表+筛选+勾选批量+单行 Modal）

**Files:**
- Create: `web/app/admin/items/page.tsx`

> 设计要点（与门店维护的差异）：① 筛选 = 品类下拉(`top_category`)+分组+搜索；② 加勾选列（Map 跨页保留所选行）+ 底部批量工具栏（设分组/设备注/清除）；③ 单行 Modal 编辑 ext（同门店维护）。不暴露成本价。

- [ ] **Step 1: 写页面 `web/app/admin/items/page.tsx`**

```tsx
// web/app/admin/items/page.tsx
// 商品档案维护：品牌切换 + 筛选(品类/分组/搜索) + 分页 + 勾选批量设分组/备注 + 单行 Modal 编辑 ext
// base 列只读(采集维护)；ext(custom_group/note) 人工维护。不暴露成本价。
'use client';
import { useState, useEffect, useRef } from 'react';

const PAGE_SIZE = 20;
const key = (sbc: string, item_num: string) => `${sbc}-${item_num}`;

export default function ItemsPage() {
  const [sbc, setSbc] = useState('3120');
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">商品档案维护</h1>
      <p className="text-sm text-gray-500 mb-4">base 列由采集自动维护（只读），人工只维护「分组/备注(ext)」。勾选多行可批量设分组或备注。</p>
      <div className="flex gap-2 border-b mb-4">
        <span className="px-4 py-2 text-sm bg-primary text-white rounded-t">商品列表</span>
        <select value={sbc} onChange={e => setSbc(e.target.value)} className="ml-auto border px-2 text-sm rounded-md self-end mb-1">
          <option value="3120">3120 鲜果恰恰</option>
          <option value="64188">64188</option>
        </select>
      </div>
      <ItemList sbc={sbc} />
    </div>
  );
}

function ItemList({ sbc }: { sbc: string }) {
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState({ top_category: '', custom_group: '', q: '' });
  const [cats, setCats] = useState<string[]>([]);          // top_category 下拉项
  const [edit, setEdit] = useState<any>(null);             // 单行 Modal
  const [sel, setSel] = useState<Map<string, any>>(new Map());  // 勾选行（跨页保留）
  const [batch, setBatch] = useState<null | { field: 'custom_group' | 'note' }>(null);  // 批量输入框
  const [busy, setBusy] = useState(false);

  const query = async (p: number) => {
    setPage(p);
    const q = new URLSearchParams({ sbc, page: String(p), page_size: String(PAGE_SIZE), ...filter } as any);
    const r = await fetch(`/api/admin/items?${q}`);
    const j = await r.json();
    setData(j.data || []); setTotal(j.total || 0);
  };

  // 拉取 top_category 下拉项（同品牌 distinct，走 route 的 distinct 分支）
  const loadCats = async () => {
    const r = await fetch(`/api/admin/items?distinct=top_category&sbc=${sbc}`);
    const j = await r.json(); setCats(j.data || []);
  };

  useEffect(() => { setFilter({ top_category: '', custom_group: '', q: '' }); setSel(new Map()); query(1); loadCats(); }, [sbc]);

  const toggle = (r: any) => {
    const m = new Map(sel); const k = key(r.system_book_code, r.item_num);
    m.has(k) ? m.delete(k) : m.set(k, r); setSel(m);
  };
  const toggleAll = () => {
    const m = new Map(sel);
    const allSel = data.every(r => m.has(key(r.system_book_code, r.item_num)));
    if (allSel) data.forEach(r => m.delete(key(r.system_book_code, r.item_num)));
    else data.forEach(r => m.set(key(r.system_book_code, r.item_num), r));
    setSel(m);
  };

  const saveExt = async () => {
    setBusy(true);
    await fetch('/api/admin/items', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system_book_code: edit.system_book_code, item_num: edit.item_num, custom_group: edit.custom_group, note: edit.note }) });
    setBusy(false); setEdit(null); query(page);
  };

  const saveBatch = async (val: string) => {
    const rows = [...sel.values()].map(r => ({
      system_book_code: r.system_book_code, item_num: r.item_num,
      custom_group: batch!.field === 'custom_group' ? val : (r.custom_group || ''),
      note: batch!.field === 'note' ? val : (r.note || ''),
    }));
    setBusy(true);
    await fetch('/api/admin/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) });
    setBusy(false); setBatch(null); setSel(new Map()); query(page);
  };

  const allSel = data.length > 0 && data.every(r => sel.has(key(r.system_book_code, r.item_num)));

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <select value={filter.top_category} onChange={e => setFilter({ ...filter, top_category: e.target.value })} className="border px-2 py-1 text-sm rounded-md">
          <option value="">全部品类</option>
          {cats.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input placeholder="分组(如 重点品)" value={filter.custom_group} onChange={e => setFilter({ ...filter, custom_group: e.target.value })} className="border px-2 py-1 text-sm rounded-md" />
        <input placeholder="搜索 编号/名称/条码" value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} className="border px-2 py-1 text-sm rounded-md flex-1 min-w-[180px]" />
        <button onClick={() => query(1)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">查询</button>
      </div>

      <table className="w-full text-sm border-collapse tabular-nums">
        <thead><tr className="bg-gray-100">
          <th className="border p-2 w-8"><input type="checkbox" checked={allSel} onChange={toggleAll} /></th>
          {['编号', '商品名称', '品类', '品牌', '分组(ext)', '备注(ext)', '操作'].map(h => <th key={h} className="border p-2 text-left">{h}</th>)}
        </tr></thead>
        <tbody>
          {data.map((r: any) => {
            const k = key(r.system_book_code, r.item_num);
            return (
              <tr key={k}>
                <td className="border p-2 text-center"><input type="checkbox" checked={sel.has(k)} onChange={() => toggle(r)} /></td>
                <td className="border p-2">{r.item_num}</td>
                <td className="border p-2">{r.item_name}</td>
                <td className="border p-2">{r.category_path || r.category_name || '-'}</td>
                <td className="border p-2">{r.item_brand || '-'}</td>
                <td className="border p-2">{r.custom_group || '-'}</td>
                <td className="border p-2">{r.note || '-'}</td>
                <td className="border p-2"><button onClick={() => setEdit({ ...r })} className="text-primary">编辑ext</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="mt-4 text-sm text-gray-600">共 {total} 条 ·
        <button disabled={page <= 1} onClick={() => query(page - 1)} className="px-2">上一页</button>
        第 {page} 页
        <button disabled={page * PAGE_SIZE >= total} onClick={() => query(page + 1)} className="px-2">下一页</button>
      </div>

      {/* 批量工具栏 */}
      {sel.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg flex items-center gap-3 px-6 py-3">
          <span className="text-sm font-medium">已选 {sel.size} 项</span>
          <button onClick={() => setBatch({ field: 'custom_group' })} className="bg-primary text-white px-3 py-1 text-sm rounded-md">设分组…</button>
          <button onClick={() => setBatch({ field: 'note' })} className="bg-primary text-white px-3 py-1 text-sm rounded-md">设备注…</button>
          <button onClick={() => setSel(new Map())} className="text-sm text-gray-600 px-3 py-1">清除</button>
        </div>
      )}

      {/* 单行编辑 Modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white p-4 rounded-lg shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">编辑 ext：{edit.item_name}</h3>
            <label className="text-sm">自定义分组<input value={edit.custom_group || ''} onChange={e => setEdit({ ...edit, custom_group: e.target.value })} className="border w-full px-2 py-1 mb-2 rounded-md" /></label>
            <label className="text-sm">备注<input value={edit.note || ''} onChange={e => setEdit({ ...edit, note: e.target.value })} className="border w-full px-2 py-1 mb-4 rounded-md" /></label>
            <div className="flex gap-2 justify-end"><button onClick={() => setEdit(null)} className="px-4 py-1 text-sm">取消</button><button disabled={busy} onClick={saveExt} className="bg-primary text-white px-4 py-1 text-sm rounded-md">保存</button></div>
          </div>
        </div>
      )}

      {/* 批量输入 Modal */}
      {batch && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setBatch(null)}>
          <div className="bg-white p-4 rounded-lg shadow w-96" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-2">{batch.field === 'custom_group' ? '设分组' : '设备注'}（{sel.size} 项）</h3>
            <BatchInput onSave={saveBatch} onCancel={() => setBatch(null)} busy={busy} />
          </div>
        </div>
      )}
    </div>
  );
}

function BatchInput({ onSave, onCancel, busy }: { onSave: (v: string) => void; onCancel: () => void; busy: boolean }) {
  const [v, setV] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <>
      <input ref={ref} value={v} onChange={e => setV(e.target.value)} className="border w-full px-2 py-1 mb-4 rounded-md" />
      <div className="flex gap-2 justify-end"><button onClick={onCancel} className="px-4 py-1 text-sm">取消</button><button disabled={busy} onClick={() => onSave(v)} className="bg-primary text-white px-4 py-1 text-sm rounded-md">应用</button></div>
    </>
  );
}
```

> 说明：品类下拉 (`cats`) 通过 `loadCats` 调 `/api/admin/items?distinct=top_category`（该分支已在 Task 2 route 的 GET 里实现）。前端不直连 PostgREST。

- [ ] **Step 2: TypeScript 编译校验**

```bash
cd web && npx tsc --noEmit
```
预期：无 error。`cd ..`。

- [ ] **Step 3: commit**

```bash
git add web/app/admin/items/page.tsx web/app/api/admin/items/route.ts
git commit -m "feat(item-admin): /admin/items 页面(列表+筛选+勾选批量+单行Modal) + 品类distinct

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 侧栏入口「商品维护」

**Files:**
- Modify: `web/app/admin/layout.tsx`

- [ ] **Step 1: 改 layout，门店维护后加商品维护**

打开 `web/app/admin/layout.tsx`，第 4 行 import 加 `Boxes`：

```tsx
import { LayoutDashboard, Package, Store, Target, Users, Settings, Boxes } from 'lucide-react';
```

把门店维护那段（约 47-49 行）后面加商品维护 NavItem：

```tsx
            <div className="pt-2">
              <NavItem href="/admin/branches" icon={<Store size={16} />}>门店维护</NavItem>
            </div>
            <div className="pt-2">
              <NavItem href="/admin/items" icon={<Boxes size={16} />}>商品维护</NavItem>
            </div>
```

- [ ] **Step 2: TypeScript 编译校验**

```bash
cd web && npx tsc --noEmit
```
预期：无 error。`cd ..`。

- [ ] **Step 3: commit**

```bash
git add web/app/admin/layout.tsx
git commit -m "feat(item-admin): 侧栏加商品维护入口(Boxes图标)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 部署（GHA 完整部署 + restart postgrest）

> 改了 migration + web/ + layout → GHA 完整部署（非 function-only，CLAUDE.md 规则）。

- [ ] **Step 1: push 触发 GHA**

```bash
git push origin main
```

- [ ] **Step 2: 监控 GHA**

```bash
gh run list --limit 1
gh run watch <run-id>
```
预期：5 steps 全绿（rsync + 后端 + migrate + functions + 前端镜像）。约 3-4 分钟。

- [ ] **Step 3: 重启 postgrest 刷 schema 缓存（关键，migrate 跑了 055 但 GHA 不保证重启 postgrest）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

---

## Task 6: 生产验证（成功标准 spec §九）

- [ ] **Step 1: 页面可访问（企微内/PC，admin 账号 ZhangDuo/YangWei）**

打开 `https://data.shanhaiyiguo.com/admin/items`：预期标题「商品档案维护」+ 品牌下拉 + 列表加载第一页 20 条 + 分页 total ≈ 4.1万。

- [ ] **Step 2: 筛选 + 搜索**

选品类下拉（应有 distinct 项）+ 搜索某商品名 → 查询 → 结果过滤正确。

- [ ] **Step 3: 单行 Modal 编辑 ext**

某行「编辑ext」→ 设 custom_group="重点品"、note="测试" → 保存 → 刷新该行可见 → DB 验证：
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT * FROM dim_item_ext WHERE custom_group='重点品' LIMIT 5;\""
```
预期：返回刚编辑的行。

- [ ] **Step 4: 勾选批量**

勾选 2-3 行 → 工具栏浮现「已选 N 项」→「设分组…」输值 → 应用 → 刷新该批 custom_group 一致 → DB `SELECT count(*) FROM dim_item_ext WHERE custom_group='<值>';` 返回 N。

- [ ] **Step 5: 零破坏回归**

- `/admin/branches` 门店维护仍正常
- `dim_item` 采集（collect-items）不受影响：`SELECT count(*) FROM dim_item;` 数量未变
- `canonical_product` 视图可查：`SELECT count(*) FROM canonical_product;`

---

## Self-Review 记录

- **spec 覆盖**：spec §三(页面)→Task3；§四(数据层)→Task1；§五(API)→Task2；§六(侧栏)→Task4；§八(部署)→Task5；§九(成功标准)→Task6。✓ 全覆盖。
- **占位符**：Task3 Step1 的 `loadCats` 标注为伪实现，Step2 立即修正（同一 Task 内闭环，不遗留 TODO）。✓
- **类型/签名一致**：`upsert_item_ext(p_sbc,p_item,p_group,p_note,p_by)` ↔ route PATCH `{p_sbc:b.system_book_code,p_item:b.item_num,...}` ↔ page PATCH body `{system_book_code,item_num,custom_group,note}` 三处对齐。`upsert_items_ext_batch(p_rows)` ↔ route POST `p_rows=[{system_book_code,item_num,custom_group,note,updated_by}]` ↔ page `saveBatch` 拼 `{system_book_code,item_num,custom_group,note}`。✓
- **CLAUDE.md 合规**：迁移幂等（DROP+CREATE view / CREATE OR REPLACE function / GRANT 可重跑）；外部数据 TEXT（沿用）；部署后 restart postgrest（坑）；改 migration+web 走 GHA（非 function-only）。✓
