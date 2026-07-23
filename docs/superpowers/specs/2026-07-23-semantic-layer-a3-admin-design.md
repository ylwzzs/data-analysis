# 语义层 A3：语义层 Admin 页 设计 spec

**日期**：2026-07-23
**状态**：已确认，待实现
**前置**：A1 已落地（`metric_registry` + `dimensions`/`dimension_levels` + `validate_semantic_registry()` + `semantic_dictionary_v`）；A2 已落地（`metric_sources` + 生成器 + `report_store_sales_drill_v` + `_audit`，生产验证 rollup diff=0）
**关联**：语义层 A1/A2 spec；现有 admin 模式（items/branches route + middleware 鉴权）

---

## 1. 目标

建语义层 admin 可视化页 `/admin/semantic`——把 A1/A2 建的 registry/维度/生成视图/audit **可视化呈现**，提供「语义字典 + 健康仪表盘 + 维度层级树 + 指标依赖图」一页式管理视图。

A3 交付：单页 4 Tab 的只读 admin 页 + 4 个 API 路由。

### 非目标（YAGNI）
- 编辑 registry/dimensions（只读展示；编辑留后续或 DBA 改表）
- 注册 datasets（A1/A2 对象经 PostgREST 直查，admin 走 /api，不依赖 datasets 注册）
- 监控告警联动（健康面板人工查看，diff≠0 不自动告警）
- 权限 admin（角色/用户授权是第 3 步权限收尾，A3 不碰）

---

## 2. 三个已确认决策

1. **页面组织**：单页 `/admin/semantic` + 4 Tab 切换（非多子路由）。4 个面板共享"语义层"主题，一页紧凑看完。
2. **依赖图实现**：装 `@xyflow/react`（react-flow v12）画指标依赖图；维度层级树手写折叠 `<ul>`（不引库）。
3. **健康 Tab 内容**：rollup 自校验（`*_audit` diff）+ 配置校验（`validate_semantic_registry` RPC），合为「语义层健康仪表盘」。不含双轨对账（Phase 1 视图有重复 bug，双轨会持续 FAIL，是噪音）。

---

## 3. 架构与数据流

```
/admin/semantic (client page: 'use client' + useEffect fetch)
        ↓ fetch
/api/admin/semantic/* (route: 直连 PostgREST, POSTGREST_URL + INSFORGE_API_KEY 头)
        ↓ HTTP
PostgREST (semantic_dictionary_v / metric_registry / dimensions / *_audit / rpc/validate_semantic_registry)
```

**模式复用**（对齐现有 admin）：
- 页面纯 client（`'use client'` + `useEffect` fetch），不直连 PostgREST
- API route **直连 PostgREST**（`POSTGREST_URL` + `INSFORGE_API_KEY` 头），**不用** InsForge SDK（同 `web/app/api/admin/items/route.ts` 模式；gateway 不代理 `/rpc`）
- 鉴权：`web/middleware.ts` 拦 `/admin/*`，校验 `wecom_userid ∈ ADMIN_USERIDS`，A3 页面**自动受保护，零额外鉴权代码**

---

## 4. 文件结构

```
web/app/admin/semantic/
  page.tsx                      # 单页 + 4 Tab 容器（'use client'）
  components/
    DictionaryTab.tsx           # 字典（指标+维度清单表）
    HealthTab.tsx               # 健康（audit diff + validate 结果）
    DimensionTreeTab.tsx        # 维度层级树（手写折叠树）
    MetricGraphTab.tsx          # 指标依赖图（@xyflow/react）
web/app/api/admin/semantic/
  dictionary/route.ts           # GET → semantic_dictionary_v
  health/route.ts               # GET → 汇总所有 *_audit + 跑 validate RPC
  dimensions/route.ts           # GET → dimensions + dimension_levels（树数据）
  metrics/route.ts              # GET → metric_registry（依赖图 nodes/edges，route 内构造 edges）
```

侧边栏 `web/app/admin/layout.tsx` 加导航项「语义层」→ `/admin/semantic`（与 targets/items 平级）。

**新增依赖**：`@xyflow/react`（仅 web）。

---

## 5. 4 个 Tab 内容

### Tab 1 — 字典（DictionaryTab）
读 `semantic_dictionary_v`（A1 的 UNION ALL：指标 + 维度）。
- 列：`type`(metric/dimension) · `code` · `name` · `measure_type`(base/derived) · `unit` · `additive` · `cost_sensitive` · `enabled`
- 顶部切换「全部 / 指标 / 维度」筛选
- 指标行可展开看 `formula` + `depends_on`（derived 才有）

### Tab 2 — 健康（HealthTab）
「语义层健康仪表盘」，两区块 + 顶部汇总：
- **区块 A — rollup 自校验**：汇总所有生成视图的 `*_audit`。每行：视图名 · 各层 total · 各 `*_diff` · 状态徽章（diff=0 🟢 / diff>0 🔴）。
- **区块 B — 配置校验**：跑 `validate_semantic_registry()` RPC，展示异常行（base 定位失败 / derived 依赖缺失 / 维度 join_key 不存在）。0 行=健康。
- **顶部汇总**：「X 个视图 rollup 一致 / Y 个异常；配置校验通过 / N 项异常」

### Tab 3 — 维度层级树（DimensionTreeTab）
读 `dimensions` + `dimension_levels`，**手写折叠树**（递归 `<ul>`）。
- 每维度（branch/item）一棵树，按 `depth` + `parent_level` 串联
- 节点：`level_code` · `name_column` · `key_column`（关联键）
- 折叠/展开，默认展开第一层
- branch 示例：region → sub_region → store（3 层）

### Tab 4 — 指标依赖图（MetricGraphTab）
读 `metric_registry`，前端构造 react-flow nodes/edges。
- **节点**：base（深蓝方框）/ derived（琥珀方框）
- **边**：derived → depends_on 的每个指标（箭头指向依赖）
- 分层布局：base 左、derived 右
- 节点点击高亮其依赖链
- 当前 9 指标：6 base + 3 derived（margin → sale_profit+sale_amount；outbound_amount/profit → delivery+wholesale）

---

## 6. API 路由契约

4 个 GET，均直连 PostgREST。

### `GET /api/admin/semantic/dictionary`
```
PostgREST: GET /semantic_dictionary_v?order=type,code
返回: { data: [{type, code, name, measure_type, unit, additive, cost_sensitive, enabled, formula, depends_on}] }
```

### `GET /api/admin/semantic/dimensions`
```
PostgREST: GET /dimensions?order=dim_code  +  GET /dimension_levels?order=dim_code,depth
返回: {
  dimensions: [{dim_code, name, join_table, join_key, is_assessed_filter, enabled}],
  levels: [{dim_code, level_code, depth, key_column, name_column, parent_level}]
}
```
前端按 dim_code 分组、按 depth+parent_level 建树。

### `GET /api/admin/semantic/metrics`
```
PostgREST: GET /metric_registry?order=measure_type,metric_code
返回: {
  nodes: [{id:metric_code, measure_type, name, formula, additive, cost_sensitive}],
  edges: [{source:metric_code, target:dep}]
}
```
**edges 由 route 内构造**：遍历每个 derived 指标的 `depends_on` 数组，为每个依赖生成 `{source: derived, target: dep}`。

### `GET /api/admin/semantic/health`（关键）
**区块 A — rollup 自校验**：route **动态发现**所有 `*_audit` 视图（不硬编码），逐个查 diff。
```sql
-- 1) 发现有哪些 audit 视图
SELECT viewname FROM pg_views WHERE viewname LIKE 'report_%_v_audit';
-- 2) 对每个 audit 视图，反射 information_schema.columns 取 *_diff 列，查 MAX
```
返回: `{ audits: [{view, diffColumns:[{name, maxValue}], status}] }`
> 动态发现保证后续加生成视图（如品类下钻）自动进健康面板，免改 route。

**区块 B — 配置校验**：
```
PostgREST: POST /rpc/validate_semantic_registry
返回: { validations: [{...}] }  // 0 行 = 健康
```
> 走 `/rpc` 必须直连 PostgREST（gateway 不代理 `/rpc`）。

---

## 7. 视觉（遵循 DESIGN.md）

- 字体 DM Sans + 数字列 `tabular-nums`
- 主色深蓝 `#1E40AF`，中性 slate，达成三色（绿/琥珀/红）：健康徽章 🟢 一致 / 🔴 异常
- 原生 `<table>` + Tailwind（对齐 admin 页 items/branches 惯例，不强行套 shadcn Table）
- 依赖图节点：base=深蓝、derived=琥珀
- Tab 用顶部横排 button 组（轻量，非 shadcn Tabs）

---

## 8. 部署与边界

### 部署（GHA 完整部署）
- 改前端 `web/` + 新增依赖 `@xyflow/react` → 走 GHA（前端镜像重建）
- **不改 function/迁移**（A1/A2 对象已部署、PostgREST 可见）→ **不需重启 postgrest**
- 验证：前端打开 `/admin/semantic` 看 4 Tab 数据

### 边界
- 只读展示，不编辑
- 不注册 datasets
- 不接监控告警
- 不含权限 admin

---

## 9. 成功标准

- [ ] `/admin/semantic` 4 Tab 可切换、有数据（字典 11 行、健康全绿、树展开、图渲染 9 节点）
- [ ] 健康面板动态发现现有 1 个 audit 视图（store_sales_drill），diff=0
- [ ] validate RPC 返回 0 行（配置健康）
- [ ] 依赖图 9 节点 + margin/outbound 的依赖边正确
- [ ] 侧边栏有「语义层」入口，admin 鉴权生效（非 admin 访问被 middleware 重定向）

---

## 10. 现状约束（雷区）

1. admin 页纯 client + fetch `/api/admin/*`；API route 直连 PostgREST（非 SDK）
2. `/rpc/*` 必须直连 PostgREST，gateway 不代理（health route 注意）
3. middleware 已保护 `/admin/*`（ADMIN_USERIDS），无需额外鉴权
4. 不重启 postgrest（A3 无新视图/新表/新列）
5. `@xyflow/react` 是新增前端依赖，走 GHA 重建前端镜像
6. health route 动态发现 audit 视图——勿硬编码视图名（后续加视图免改）
