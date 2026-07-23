# 语义层 A3 Admin 页 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建语义层 admin 可视化页 `/admin/semantic`（单页 4 Tab：字典 / 健康 / 维度层级树 / 指标依赖图），只读呈现 A1/A2 的 registry/维度/生成视图/audit。

**Architecture:** 复用现有 admin 模式——client page（`'use client'` + `useEffect` fetch）→ `/api/admin/semantic/*` route（直连 PostgREST，`POSTGREST_URL` + `INSFORGE_API_KEY` 头，同 items route）→ PostgREST。middleware 已保护 `/admin/*`（ADMIN_USERIDS），零额外鉴权。

**Tech Stack:** Next.js App Router（client components）、原生 `<table>` + Tailwind、`@xyflow/react`（依赖图）、vitest（health 纯函数单测）

## Global Constraints

- 复用 admin API route 模式：**直连 PostgREST**（`POSTGREST_URL` + `INSFORGE_API_KEY` 头），**不用** InsForge SDK；`/rpc/*` 必须直连 PostgREST（gateway 不代理）
- 视觉遵循 DESIGN.md：DM Sans + 数字列 `tabular-nums`、主色深蓝 `#1E40AF`、原生 `<table>` + Tailwind（对齐 items/branches admin 惯例，不套 shadcn Table）
- middleware 已保护 `/admin/*`，**不写额外鉴权代码**
- **不改 function/迁移**（A1/A2 对象已部署、PostgREST 可见）→ **部署后不重启 postgrest**
- 项目 admin 页无单测惯例；**仅 health 动态发现纯函数写 vitest 单测**（TDD），其余 route/tab 靠 `npm run build` + 部署端到端验证
- npm 安装用 npmmirror 镜像加速（项目约定）
- 关键列名 verbatim（勿臆造）：`semantic_dictionary_v.kind`（非 type）；`validate_semantic_registry()` 返回单列 `issue`；audit diff 列以 `_diff` 结尾（health 动态识别，不硬编码）

## Scope
**包含**：单页 4 Tab + 4 个 API route + `@xyflow/react` 依赖图 + health 动态发现 audit + vitest 单测
**不含**：编辑功能、datasets 注册、监控告警、权限 admin

---

## File Structure

| 文件 | 职责 |
|---|---|
| `web/app/admin/layout.tsx`（改） | 侧边栏加「语义层」导航项 |
| `web/app/admin/semantic/page.tsx` | 单页 + 4 Tab 容器 |
| `web/app/admin/semantic/components/DictionaryTab.tsx` | 字典（指标+维度清单表） |
| `web/app/admin/semantic/components/HealthTab.tsx` | 健康（audit diff + validate） |
| `web/app/admin/semantic/components/DimensionTreeTab.tsx` | 维度层级树（手写折叠树） |
| `web/app/admin/semantic/components/MetricGraphTab.tsx` | 指标依赖图（react-flow） |
| `web/app/api/admin/semantic/dictionary/route.ts` | GET → semantic_dictionary_v |
| `web/app/api/admin/semantic/dimensions/route.ts` | GET → dimensions + dimension_levels |
| `web/app/api/admin/semantic/metrics/route.ts` | GET → metric_registry（route 内构造 edges） |
| `web/app/api/admin/semantic/health/route.ts` | GET → 动态发现 audit + validate RPC |
| `web/lib/semantic/health.ts` | 纯函数：parseAuditViewNames + computeAuditStats |
| `web/lib/semantic/__tests__/health.test.ts` | health 纯函数单测 |

---

## Task 1: 基础设施（依赖 + 侧边栏 + page 骨架）

**Files:**
- Create: `web/app/admin/semantic/page.tsx`
- Create: `web/app/admin/semantic/components/DictionaryTab.tsx`（占位）
- Create: `web/app/admin/semantic/components/HealthTab.tsx`（占位）
- Create: `web/app/admin/semantic/components/DimensionTreeTab.tsx`（占位）
- Create: `web/app/admin/semantic/components/MetricGraphTab.tsx`（占位）
- Modify: `web/app/admin/layout.tsx`（加导航项）
- Modify: `web/package.json`（+ `@xyflow/react`）

**Interfaces:**
- Consumes: 现有 `web/app/admin/layout.tsx` 的 `NavItem`
- Produces: `/admin/semantic` 路由 + 4 个占位组件（后续 task 填充实现）

- [ ] **Step 1: 装 @xyflow/react**
```bash
cd web && npm install @xyflow/react --registry https://registry.npmmirror.com
```
Expected: `added N packages`，`web/package.json` 出现 `"@xyflow/react"`。

- [ ] **Step 2: layout.tsx 加「语义层」导航项**

修改 `web/app/admin/layout.tsx`。在第 4 行 import 加 `Layers` 图标：
```tsx
import { LayoutDashboard, Package, Store, Target, Users, Settings, Boxes, Layers } from 'lucide-react';
```
在 targets 块（约第 54-56 行 `<NavItem href="/admin/targets"...>目标管理</NavItem>` 的 `</div>` 之后、`<div className="pt-4 border-t">` 之前）插入：
```tsx
            <div className="pt-2">
              <NavItem href="/admin/semantic" icon={<Layers size={16} />}>语义层</NavItem>
            </div>
```

- [ ] **Step 3: 创建 4 个占位组件**

每个占位组件都是最小实现（后续 task 替换）：

`web/app/admin/semantic/components/DictionaryTab.tsx`:
```tsx
'use client';
export default function DictionaryTab() {
  return <div className="text-gray-400 text-sm">加载中…</div>;
}
```
`web/app/admin/semantic/components/HealthTab.tsx`:
```tsx
'use client';
export default function HealthTab() {
  return <div className="text-gray-400 text-sm">加载中…</div>;
}
```
`web/app/admin/semantic/components/DimensionTreeTab.tsx`:
```tsx
'use client';
export default function DimensionTreeTab() {
  return <div className="text-gray-400 text-sm">加载中…</div>;
}
```
`web/app/admin/semantic/components/MetricGraphTab.tsx`:
```tsx
'use client';
export default function MetricGraphTab() {
  return <div className="text-gray-400 text-sm">加载中…</div>;
}
```

- [ ] **Step 4: 创建 page.tsx（Tab 容器）**

`web/app/admin/semantic/page.tsx`:
```tsx
'use client';
import { useState } from 'react';
import DictionaryTab from './components/DictionaryTab';
import HealthTab from './components/HealthTab';
import DimensionTreeTab from './components/DimensionTreeTab';
import MetricGraphTab from './components/MetricGraphTab';

const TABS = [
  { key: 'dict', label: '字典' },
  { key: 'health', label: '健康' },
  { key: 'tree', label: '维度层级' },
  { key: 'graph', label: '依赖图' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function SemanticPage() {
  const [tab, setTab] = useState<TabKey>('dict');
  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">语义层</h1>
      <div className="flex gap-1 border-b mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm rounded-t ${tab === t.key ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'dict' && <DictionaryTab />}
      {tab === 'health' && <HealthTab />}
      {tab === 'tree' && <DimensionTreeTab />}
      {tab === 'graph' && <MetricGraphTab />}
    </div>
  );
}
```

- [ ] **Step 5: build 验证 + commit**
```bash
cd web && npm run build
```
Expected: build 成功（无 TS 错误）。
```bash
cd .. && git add web/app/admin/semantic web/app/admin/layout.tsx web/package.json web/package-lock.json
git commit -m "feat(web): semantic admin page scaffold + sidebar entry (A3)"
```

---

## Task 2: dictionary route + DictionaryTab

**Files:**
- Create: `web/app/api/admin/semantic/dictionary/route.ts`
- Modify: `web/app/admin/semantic/components/DictionaryTab.tsx`（替换占位）

**Interfaces:**
- Consumes: PostgREST `semantic_dictionary_v`（列：`kind, code, name, description, formula, measure_type, additive, cost_sensitive, unit`）
- Produces: `GET /api/admin/semantic/dictionary` → `{ data: Row[] }`

- [ ] **Step 1: 写 dictionary route**

`web/app/api/admin/semantic/dictionary/route.ts`:
```ts
// 语义字典：读 semantic_dictionary_v（指标+维度 UNION ALL，A1）
// 直连 PostgREST（同 items route 模式）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/semantic_dictionary_v?order=kind,code`, { headers });
  const data = await r.json();
  return NextResponse.json({ data });
}
```

- [ ] **Step 2: 写 DictionaryTab 组件**

替换 `web/app/admin/semantic/components/DictionaryTab.tsx`:
```tsx
'use client';
import { Fragment, useState, useEffect } from 'react';

type Row = {
  kind: string;
  code: string;
  name: string;
  description: string | null;
  formula: string | null;
  measure_type: string;
  additive: boolean;
  cost_sensitive: boolean | null;
  unit: string | null;
};

export default function DictionaryTab() {
  const [data, setData] = useState<Row[]>([]);
  const [filter, setFilter] = useState<'all' | 'metric' | 'dimension'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/semantic/dictionary')
      .then((r) => r.json())
      .then((j) => setData(j.data || []));
  }, []);

  const rows = data.filter((r) => filter === 'all' || r.kind === filter);

  return (
    <div>
      <div className="flex gap-2 mb-3">
        {(['all', 'metric', 'dimension'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 text-sm rounded-md ${filter === f ? 'bg-primary text-white' : 'border'}`}
          >
            {f === 'all' ? '全部' : f === 'metric' ? '指标' : '维度'}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500 self-center">{rows.length} 项</span>
      </div>
      <table className="w-full text-sm border">
        <thead className="bg-gray-50">
          <tr className="text-left">
            <th className="px-2 py-1">类型</th>
            <th className="px-2 py-1">code</th>
            <th className="px-2 py-1">名称</th>
            <th className="px-2 py-1">分类</th>
            <th className="px-2 py-1">可加</th>
            <th className="px-2 py-1">成本敏感</th>
            <th className="px-2 py-1">单位</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Fragment key={r.code}>
              <tr
                className="border-t hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpanded(expanded === r.code ? null : r.code)}
              >
                <td className="px-2 py-1">{r.kind === 'metric' ? '指标' : '维度'}</td>
                <td className="px-2 py-1 font-mono">{r.code}</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.measure_type}</td>
                <td className="px-2 py-1">{r.additive ? '是' : '否'}</td>
                <td className="px-2 py-1">{r.cost_sensitive ? '是' : '-'}</td>
                <td className="px-2 py-1">{r.unit || '-'}</td>
              </tr>
              {expanded === r.code && (
                <tr className="border-t bg-gray-50">
                  <td colSpan={7} className="px-2 py-2 text-xs text-gray-600">
                    <div><b>说明：</b>{r.description || '-'}</div>
                    <div><b>公式：</b>{r.formula || '-'}</div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: build + commit**
```bash
cd web && npm run build
```
Expected: build 成功。
```bash
cd .. && git add web/app/api/admin/semantic/dictionary web/app/admin/semantic/components/DictionaryTab.tsx
git commit -m "feat(web): semantic dictionary route + tab (A3)"
```

---

## Task 3: dimensions route + DimensionTreeTab

**Files:**
- Create: `web/app/api/admin/semantic/dimensions/route.ts`
- Modify: `web/app/admin/semantic/components/DimensionTreeTab.tsx`（替换占位）

**Interfaces:**
- Consumes: PostgREST `dimensions`（`dim_code, name, join_table, join_key, is_assessed_filter, enabled`）+ `dimension_levels`（`dim_code, level_code, level_name, depth, key_column, name_column, parent_level`）
- Produces: `GET /api/admin/semantic/dimensions` → `{ dimensions: Dim[], levels: Level[] }`

- [ ] **Step 1: 写 dimensions route**

`web/app/api/admin/semantic/dimensions/route.ts`:
```ts
// 维度 + 层级（建树数据）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const [dimensions, levels] = await Promise.all([
    fetch(`${POSTGREST_URL}/dimensions?order=dim_code`, { headers }).then((r) => r.json()),
    fetch(`${POSTGREST_URL}/dimension_levels?order=dim_code,depth`, { headers }).then((r) => r.json()),
  ]);
  return NextResponse.json({ dimensions, levels });
}
```

- [ ] **Step 2: 写 DimensionTreeTab 组件（手写折叠树）**

替换 `web/app/admin/semantic/components/DimensionTreeTab.tsx`:
```tsx
'use client';
import { useState, useEffect } from 'react';

type Dim = {
  dim_code: string;
  name: string;
  join_table: string;
  join_key: string;
  is_assessed_filter: boolean;
  enabled: boolean;
};
type Level = {
  dim_code: string;
  level_code: string;
  level_name: string;
  depth: number;
  key_column: string;
  name_column: string;
  parent_level: string | null;
};

export default function DimensionTreeTab() {
  const [dims, setDims] = useState<Dim[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/admin/semantic/dimensions')
      .then((r) => r.json())
      .then((j) => {
        setDims(j.dimensions || []);
        setLevels(j.levels || []);
      });
  }, []);

  const treeOf = (dimCode: string) => {
    const ls = levels.filter((l) => l.dim_code === dimCode);
    const childrenOf = (parent: string | null) =>
      ls.filter((l) => l.parent_level === parent);
    const render = (parent: string | null, depth: number): JSX.Element[] =>
      childrenOf(parent).map((l) => {
        const key = `${dimCode}/${l.level_code}`;
        const isCollapsed = collapsed.has(key);
        const kids = render(l.level_code, depth + 1);
        return (
          <li key={key}>
            <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 16 }}>
              {kids.length > 0 ? (
                <button
                  onClick={() => {
                    const s = new Set(collapsed);
                    s.has(key) ? s.delete(key) : s.add(key);
                    setCollapsed(s);
                  }}
                  className="text-xs w-4"
                >
                  {isCollapsed ? '▶' : '▼'}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <span className="font-medium">{l.level_name}</span>
              <span className="text-xs text-gray-400 font-mono">{l.level_code}</span>
              <span className="text-xs text-gray-500">
                键:{l.key_column} 名:{l.name_column}
              </span>
            </div>
            {!isCollapsed && kids.length > 0 && <ul>{kids}</ul>}
          </li>
        );
      });
    return render(null, 0);
  };

  return (
    <div className="space-y-6">
      {dims.map((d) => (
        <div key={d.dim_code}>
          <h3 className="font-bold mb-2">
            {d.name} <span className="text-xs text-gray-400 font-mono">{d.dim_code}</span>
          </h3>
          <div className="text-xs text-gray-500 mb-1">
            维表:{d.join_table} · JOIN键:{d.join_key} {d.is_assessed_filter ? '· 考核白名单' : ''}
          </div>
          <ul className="text-sm">{treeOf(d.dim_code)}</ul>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: build + commit**
```bash
cd web && npm run build
```
Expected: build 成功。
```bash
cd .. && git add web/app/api/admin/semantic/dimensions web/app/admin/semantic/components/DimensionTreeTab.tsx
git commit -m "feat(web): semantic dimensions route + tree tab (A3)"
```

---

## Task 4: metrics route + MetricGraphTab

**Files:**
- Create: `web/app/api/admin/semantic/metrics/route.ts`
- Modify: `web/app/admin/semantic/components/MetricGraphTab.tsx`（替换占位）

**Interfaces:**
- Consumes: PostgREST `metric_registry`（`metric_code, name, measure_type, formula, depends_on(JSONB), additive, cost_sensitive`）
- Produces: `GET /api/admin/semantic/metrics` → `{ nodes: {id,name,measure_type,formula,additive,cost_sensitive}[], edges: {source,target}[] }`（edges 由 route 遍历 derived 的 depends_on 构造）

- [ ] **Step 1: 写 metrics route（route 内构造 edges）**

`web/app/api/admin/semantic/metrics/route.ts`:
```ts
// 指标依赖图数据：metric_registry → nodes + edges（derived → depends_on）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/metric_registry?order=measure_type,metric_code`, { headers });
  const rows: any[] = await r.json();
  const nodes = rows.map((m) => ({
    id: m.metric_code,
    name: m.name,
    measure_type: m.measure_type,
    formula: m.formula,
    additive: m.additive,
    cost_sensitive: m.cost_sensitive,
  }));
  const edges: { source: string; target: string }[] = [];
  for (const m of rows) {
    if (m.measure_type === 'derived' && Array.isArray(m.depends_on)) {
      for (const dep of m.depends_on) edges.push({ source: m.metric_code, target: dep });
    }
  }
  return NextResponse.json({ nodes, edges });
}
```

- [ ] **Step 2: 写 MetricGraphTab 组件（react-flow）**

替换 `web/app/admin/semantic/components/MetricGraphTab.tsx`:
```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

type NodeData = {
  id: string;
  name: string;
  measure_type: string;
  formula: string | null;
  additive: boolean;
  cost_sensitive: boolean;
};

export default function MetricGraphTab() {
  const [nodes0, setNodes] = useState<NodeData[]>([]);
  const [edges0, setEdges] = useState<{ source: string; target: string }[]>([]);
  const [hl, setHl] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/admin/semantic/metrics')
      .then((r) => r.json())
      .then((j) => {
        setNodes(j.nodes || []);
        setEdges(j.edges || []);
      });
  }, []);

  const rfNodes: Node[] = useMemo(() => {
    const bases = nodes0.filter((n) => n.measure_type === 'base');
    const derived = nodes0.filter((n) => n.measure_type === 'derived');
    const mk = (n: NodeData, x: number, y: number): Node => ({
      id: n.id,
      position: { x, y },
      data: {
        label: (
          <div
            className={`px-2 py-1 rounded text-xs ${n.measure_type === 'base' ? 'bg-blue-600 text-white' : 'bg-amber-500 text-white'}`}
          >
            <div className="font-bold">{n.name}</div>
            <div className="opacity-75 font-mono">
              {n.id}
              {n.cost_sensitive ? ' · 成本' : ''}
            </div>
          </div>
        ),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    });
    const baseNodes = bases.map((n, i) => mk(n, 0, i * 70));
    const derivedNodes = derived.map((n, i) => mk(n, 420, i * 70));
    return [...baseNodes, ...derivedNodes];
  }, [nodes0]);

  const rfEdges: Edge[] = edges0.map((e, i) => ({
    id: `e${i}`,
    source: e.source,
    target: e.target,
    animated: true,
  }));

  const onNodeClick = (_: unknown, node: Node) => {
    const chain = new Set<string>([node.id]);
    const visitUp = (id: string) =>
      edges0
        .filter((e) => e.source === id)
        .forEach((e) => {
          if (!chain.has(e.target)) {
            chain.add(e.target);
            visitUp(e.target);
          }
        });
    const visitDown = (id: string) =>
      edges0
        .filter((e) => e.target === id)
        .forEach((e) => {
          if (!chain.has(e.source)) {
            chain.add(e.source);
            visitDown(e.source);
          }
        });
    visitUp(node.id);
    visitDown(node.id);
    setHl(chain);
  };

  const opacityOf = (id: string) => (hl.size > 0 && !hl.has(id) ? 0.25 : 1);
  const rfNodesStyled = rfNodes.map((n) => ({ ...n, style: { opacity: opacityOf(n.id) } }));

  return (
    <div style={{ height: 500 }}>
      <ReactFlow nodes={rfNodesStyled} edges={rfEdges} onNodeClick={onNodeClick} fitView>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      <p className="text-xs text-gray-500 mt-2">
        蓝=base（事实表聚合），琥珀=derived（运算）。点击节点高亮依赖链。
      </p>
    </div>
  );
}
```

- [ ] **Step 3: build + commit**
```bash
cd web && npm run build
```
Expected: build 成功（确认 `@xyflow/react` import 解析）。
```bash
cd .. && git add web/app/api/admin/semantic/metrics web/app/admin/semantic/components/MetricGraphTab.tsx
git commit -m "feat(web): semantic metric dependency graph (A3)"
```

---

## Task 5: health route（含纯函数 + 单测）+ HealthTab

**Files:**
- Create: `web/lib/semantic/health.ts`
- Create: `web/lib/semantic/__tests__/health.test.ts`
- Create: `web/app/api/admin/semantic/health/route.ts`
- Modify: `web/app/admin/semantic/components/HealthTab.tsx`（替换占位）

**Interfaces:**
- Consumes: PostgREST 根 OpenAPI（发现 `report_*_v_audit`）+ 各 audit 视图行 + `rpc/validate_semantic_registry`（返回 `[{issue}]`）
- Produces: `GET /api/admin/semantic/health` → `{ audits: {view, diffColumns:[{name,maxValue}], status, totals}[], validations: [{issue}] }`
- 纯函数 `parseAuditViewNames(openapi)` / `computeAuditStats(rows)` 可独立单测

**设计要点**：PostgREST **不暴露 pg_views 系统目录**，所以动态发现 audit 视图用 PostgREST 根 OpenAPI（`GET /` 返回 `{definitions:{<表>:...}, paths:{"/<表>:{}}}`），keys 过滤 `report_*_v_audit`。diff 列以 `_diff` 结尾、totals 以 `_total` 结尾，computeAuditStats 动态识别（不硬编码列名）。

- [ ] **Step 1: 写失败测试**

`web/lib/semantic/__tests__/health.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseAuditViewNames, computeAuditStats } from '../health';

describe('parseAuditViewNames', () => {
  it('extracts report_*_v_audit from definitions', () => {
    const openapi = {
      definitions: {
        report_store_sales_drill_v_audit: {},
        report_store_sales_drill_v: {},
        org_users: {},
      },
    };
    expect(parseAuditViewNames(openapi)).toEqual(['report_store_sales_drill_v_audit']);
  });
  it('falls back to paths, strips leading slash, dedups', () => {
    const openapi = { paths: { '/report_a_v_audit': {}, '/report_b_v_audit': {}, '/org_users': {} } };
    expect(parseAuditViewNames(openapi)).toEqual(['report_a_v_audit', 'report_b_v_audit']);
  });
  it('merges definitions + paths', () => {
    const openapi = {
      definitions: { report_a_v_audit: {} },
      paths: { '/report_b_v_audit': {} },
    };
    expect(parseAuditViewNames(openapi)).toEqual(['report_a_v_audit', 'report_b_v_audit']);
  });
  it('returns empty when none', () => {
    expect(parseAuditViewNames({ definitions: { org_users: {} } })).toEqual([]);
  });
});

describe('computeAuditStats', () => {
  it('finds _diff columns, computes max abs, sums _total', () => {
    const rows = [
      { region_total: 100, store_total: 100, region_vs_store_diff: 0, region_vs_sub_region_diff: 0.5 },
      { region_total: 200, store_total: 199, region_vs_store_diff: 1, region_vs_sub_region_diff: 0 },
    ];
    const s = computeAuditStats(rows);
    expect(s.status).toBe('warn');
    expect(s.diffColumns.find((d) => d.name === 'region_vs_store_diff')?.maxValue).toBe(1);
    expect(s.totals.region_total).toBe(300);
    expect(s.totals.store_total).toBe(299);
  });
  it('ok when all diffs < 0.01', () => {
    const rows = [{ region_total: 5, store_total: 5, region_vs_store_diff: 0.001 }];
    expect(computeAuditStats(rows).status).toBe('ok');
  });
  it('warn when any diff >= 0.01', () => {
    const rows = [{ region_total: 5, store_total: 4, region_vs_store_diff: 1 }];
    expect(computeAuditStats(rows).status).toBe('warn');
  });
  it('empty rows → ok, no diffColumns', () => {
    const s = computeAuditStats([]);
    expect(s.status).toBe('ok');
    expect(s.diffColumns).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑确认失败**
```bash
cd web && npx vitest run lib/semantic/__tests__/health.test.ts
```
Expected: FAIL（`Cannot find module '../health'`）。

- [ ] **Step 3: 实现 health.ts 纯函数**

`web/lib/semantic/health.ts`:
```ts
// health route 的纯函数：动态发现 audit 视图 + 计算 rollup 差异
// 抽出来便于单测（不依赖 PostgREST/网络）

// 从 PostgREST 根 OpenAPI 提取所有 report_*_v_audit 视图名
export function parseAuditViewNames(openapi: any): string[] {
  const fromDefs = openapi?.definitions ? Object.keys(openapi.definitions) : [];
  const fromPaths = openapi?.paths
    ? Object.keys(openapi.paths).map((p) => p.replace(/^\//, ''))
    : [];
  const names = new Set<string>([...fromDefs, ...fromPaths]);
  return [...names].filter((n) => /^report_.+_v_audit$/.test(n)).sort();
}

// 对一个 audit 视图的所有行：找 *_diff 列算 max(|值|)，*_total 列求和
export function computeAuditStats(rows: any[]): {
  diffColumns: { name: string; maxValue: number }[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
} {
  if (!rows.length) return { diffColumns: [], status: 'ok', totals: {} };
  const allKeys = Object.keys(rows[0]);
  const diffKeys = allKeys.filter((k) => k.endsWith('_diff'));
  const totalKeys = allKeys.filter((k) => k.endsWith('_total'));
  const diffColumns = diffKeys.map((name) => ({
    name,
    maxValue: Math.max(...rows.map((r) => Math.abs(Number(r[name]) || 0))),
  }));
  const totals: Record<string, number> = {};
  for (const tk of totalKeys) totals[tk] = rows.reduce((s, r) => s + (Number(r[tk]) || 0), 0);
  const status = diffColumns.every((d) => d.maxValue < 0.01) ? 'ok' : 'warn';
  return { diffColumns, status, totals };
}
```

- [ ] **Step 4: 跑确认通过**
```bash
cd web && npx vitest run lib/semantic/__tests__/health.test.ts
```
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 写 health route**

`web/app/api/admin/semantic/health/route.ts`:
```ts
// 语义层健康：A) 动态发现所有 audit 视图算 rollup diff  B) 跑 validate_semantic_registry
import { NextResponse } from 'next/server';
import { parseAuditViewNames, computeAuditStats } from '@/lib/semantic/health';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  // A: 动态发现 audit 视图（PostgREST 根 OpenAPI）
  const rootRes = await fetch(`${POSTGREST_URL}/`, { headers });
  const openapi = await rootRes.json();
  const auditViews = parseAuditViewNames(openapi);
  const audits = [];
  for (const view of auditViews) {
    const r = await fetch(`${POSTGREST_URL}/${view}?limit=1000`, { headers });
    const rows = await r.json();
    audits.push({ view, ...computeAuditStats(rows) });
  }

  // B: 配置校验（/rpc 必须直连 PostgREST，gateway 不代理）
  const vRes = await fetch(`${POSTGREST_URL}/rpc/validate_semantic_registry`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const validationsRaw = await vRes.json();
  const validations = Array.isArray(validationsRaw) ? validationsRaw : [];

  return NextResponse.json({ audits, validations });
}
```

- [ ] **Step 6: 写 HealthTab 组件**

替换 `web/app/admin/semantic/components/HealthTab.tsx`:
```tsx
'use client';
import { useState, useEffect } from 'react';

type DiffCol = { name: string; maxValue: number };
type Audit = {
  view: string;
  diffColumns: DiffCol[];
  status: 'ok' | 'warn';
  totals: Record<string, number>;
};

const viewName = (v: string) => v.replace(/^report_/, '').replace(/_v_audit$/, '');

export default function HealthTab() {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [validations, setValidations] = useState<{ issue: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/semantic/health')
      .then((r) => r.json())
      .then((j) => {
        setAudits(j.audits || []);
        setValidations(j.validations || []);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="text-gray-400 text-sm">加载中…</div>;

  const auditBad = audits.filter((a) => a.status === 'warn').length;
  const valBad = validations.length;

  return (
    <div className="space-y-6">
      <div className="flex gap-4 text-sm">
        <span
          className={`px-3 py-1 rounded ${auditBad === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
        >
          {auditBad === 0
            ? `✓ ${audits.length} 个视图 rollup 一致`
            : `✗ ${auditBad}/${audits.length} 个视图 rollup 异常`}
        </span>
        <span
          className={`px-3 py-1 rounded ${valBad === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}
        >
          {valBad === 0 ? '✓ 配置校验通过' : `✗ ${valBad} 项配置异常`}
        </span>
      </div>

      <div>
        <h3 className="font-bold mb-2">Rollup 自校验</h3>
        {audits.length === 0 ? (
          <p className="text-sm text-gray-400">暂无生成视图</p>
        ) : (
          <table className="w-full text-sm border">
            <thead className="bg-gray-50">
              <tr className="text-left">
                <th className="px-2 py-1">视图</th>
                <th className="px-2 py-1">差异列（最大偏差）</th>
                <th className="px-2 py-1">状态</th>
              </tr>
            </thead>
            <tbody>
              {audits.map((a) => (
                <tr key={a.view} className="border-t">
                  <td className="px-2 py-1 font-mono">{viewName(a.view)}</td>
                  <td className="px-2 py-1 tabular-nums">
                    {a.diffColumns.map((d) => (
                      <span
                        key={d.name}
                        className={`mr-3 ${d.maxValue < 0.01 ? 'text-gray-500' : 'text-red-600 font-bold'}`}
                      >
                        {d.name.replace(/_diff$/, '').replace(/_/g, ' ')}: {d.maxValue.toFixed(2)}
                      </span>
                    ))}
                  </td>
                  <td className="px-2 py-1">{a.status === 'ok' ? '🟢' : '🔴'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h3 className="font-bold mb-2">配置校验（validate_semantic_registry）</h3>
        {valBad === 0 ? (
          <p className="text-sm text-green-700">✓ 全部通过</p>
        ) : (
          <ul className="text-sm space-y-1">
            {validations.map((v, i) => (
              <li key={i} className="text-red-600">✗ {v.issue}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: build + 单测 + commit**
```bash
cd web && npx vitest run lib/semantic/__tests__/health.test.ts && npm run build
```
Expected: 单测 PASS + build 成功。
```bash
cd .. && git add web/lib/semantic web/app/api/admin/semantic/health web/app/admin/semantic/components/HealthTab.tsx
git commit -m "feat(web): semantic health panel (dynamic audit discovery + validate) (A3)"
```

---

## Task 6: 生产部署 + 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 推送触发 GHA**
```bash
git push origin main
```

- [ ] **Step 2: 等 GHA（前端镜像重建）**
```bash
gh run watch --exit-status
```
Expected: 5 steps 全绿。**不重启 postgrest**（A3 无新视图/表/列）。

- [ ] **Step 3: 端到端验证（前端打开 /admin/semantic，admin 账号登录）**

逐 Tab 核对（企微 admin 客户端打开 `https://data.shanhaiyiguo.com/admin/semantic`）：
- **字典**：11 行（9 指标 + 2 维度）；切「指标/维度」筛选生效；点行展开看说明+公式
- **健康**：顶部 2 个绿徽章（rollup 一致 + 配置通过）；rollup 表 1 行（store_sales_drill，diff≈0.00 🟢）；配置校验「全部通过」
- **维度层级**：2 棵树（branch 3 层 region→sub_region→store / item 1 层）；折叠展开生效
- **依赖图**：9 节点（6 蓝 base + 3 琥珀 derived）；margin→sale_profit+sale_amount、outbound→delivery+wholesale 边正确；点击节点高亮依赖链

- [ ] **Step 4: 健康数据抽查（可选，SSH 直查对照）**
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT MAX(region_vs_store_diff) FROM report_store_sales_drill_v_audit;\""
```
Expected: `0.00`（与前端健康面板一致）。

---

## Self-Review

### 1. Spec Coverage（对照 A3 spec §5-§9）
| spec 要求 | task |
|---|---|
| 单页 4 Tab | Task 1 ✅ |
| 字典（semantic_dictionary_v + 筛选 + 展开） | Task 2 ✅ |
| 健康（audit rollup + validate RPC） | Task 5 ✅ |
| 维度层级树（手写折叠） | Task 3 ✅ |
| 指标依赖图（@xyflow/react） | Task 4 ✅ |
| 4 个 API route（直连 PostgREST） | Task 2/3/4/5 ✅ |
| 侧边栏入口 + middleware 鉴权 | Task 1 ✅（鉴权复用 middleware，零额外代码） |
| health 动态发现 audit（免改 route） | Task 5 ✅（PostgREST 根 OpenAPI） |
| 部署（GHA，不重启 postgrest） | Task 6 ✅ |
| 成功标准（11 行/全绿/树/9 节点） | Task 6 Step 3 ✅ |

### 2. Placeholder Scan
✅ 无 TBD/TODO；所有 route/tab 代码 verbatim 完整；占位组件仅在 Task 1 临时存在，后续 task 替换。

### 3. Type Consistency
✅ `semantic_dictionary_v` 列名 verbatim（`kind` 非 type；`formula`/`description` 可空）
✅ `dimension_levels` 列名 verbatim（`level_name`/`key_column`/`name_column`/`parent_level`）
✅ `metric_registry.depends_on` JSONB → route 内 `Array.isArray` + 遍历构造 edges
✅ `validate_semantic_registry()` 返回 `[{issue}]`，route 做数组兜底
✅ audit diff 列以 `_diff` 结尾、totals 以 `_total` 结尾 → computeAuditStats 动态识别（不硬编码 `region_vs_store_diff`）
✅ health route import 纯函数 `@/lib/semantic/health`，路径与文件结构一致

### 4. spec 偏差（计划已修正）
- spec §5 字典说"展开看 formula + depends_on"：dictionary_v **无 depends_on 列**，计划改为展开看 `description + formula`（depends_on 在依赖图 Tab 看，职责更清晰）
- spec §6 health 用 `pg_views`：PostgREST **不暴露系统目录**，计划改用 PostgREST 根 OpenAPI（`GET /` definitions/paths keys）
- spec §7 audit 示例列名 `region_vs_sub_diff`：实际生成 `region_vs_sub_region_diff`，但 health 动态识别不依赖具体名（无影响）

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-23-semantic-layer-a3-admin.md`.**
