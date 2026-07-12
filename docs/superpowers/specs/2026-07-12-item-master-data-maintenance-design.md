# 商品档案维护 设计 spec

> 日期：2026-07-12 ｜ 子系统：前端呈现前置——基础维表维护（Phase 1 第二批）
> 上游 spec：`2026-07-12-master-data-maintenance-design.md`（§十一 后续路线第 1 项）
> brainstorming 产物，下一步转 writing-plans。

## 一、背景

门店维护 + 目标分解（Phase 1 第一批）已完成。商品档案维护是第一批明确后置的第二批：
- `dim_item` 4.1万行（3120 卖出 ~2214 个 item_code、64188 ~2597、1025 公共码），PK=`(system_book_code, item_num)`，品牌隔离
- `dim_item_ext` 已建表但 **0 行**：`(system_book_code, item_num, custom_group, note, updated_at, updated_by)`，与 `dim_branch_ext` 逐字段同构
- 报表品类走 `dim_item.category`（不卡），所以 ext 维护是「让商品可被人工分组/打标」的前置，为 Phase 2 报表中心（重点 SKU、自定义分组达成）铺路

**本批做**：商品档案列表（筛/查/分页）+ ext 两列编辑（单行 Modal + 多选批量）。

## 二、范围（MVP）

**做**：
1. 商品档案列表：品牌切换 + 筛选（品类/分组/搜索）+ 分页（4.1万行不一次性加载）
2. ext 单行编辑：Modal 改 `custom_group` + `note`（照搬门店维护 Modal）
3. ext 批量编辑：勾选多行 → 底部工具栏 `设分组/设备注` → 一次性写入

**不做（后置 / YAGNI）**：
- 加 ext 列（`is_key_item`/`custom_category`）—— 后续增量迁移，不破坏
- 场景命名 `item_scenario_names`（按跨品牌 `item_code`，粒度不同）—— 单独一批
- 成本价展示（`item_cost_price` 敏感，admin 页不暴露）
- 移动端编辑（维表维护 PC 为主，沿用第一批决策）
- 权限角色（admin 白名单沿用）

## 三、页面 `/admin/items`（照搬门店维护结构）

### 3.1 顶栏 + 筛选
- 品牌切换 `<select>`（3120 鲜果恰恰 / 64188），`ml-auto`，state 提升到页面级
- 切品牌 → `useEffect([sbc])` 重置筛选 + 回到第 1 页（同 `branches/page.tsx:45`）
- 筛选条件：
  - 品类 = `top_category` 下拉（distinct 值，约 10 个，如 `SX|生鲜`）
  - 分组 = `custom_group`（文本，可选，便于「看所有重点品」）
  - 搜索 = `item_num` / `item_name` / `item_code` / `bar_code` `ilike`（PostgREST `or=`）
- 查询按钮触发（无 debounce，同门店维护）

### 3.2 列表表格
列：☐勾选 / 编号(`item_num`) / 商品名称(`item_name`) / 品类(`category_path` 或 `category_name`) / 品牌(`item_brand`) / 分组(ext `custom_group`) / 备注(ext `note`) / 操作

- base 列只读（采集维护）；ext 两列可编辑
- 单行「编辑」按钮 → Modal（两个 input：自定义分组 / 备注，取消/保存）—— 与门店维护 Modal 逐行一致
- 分页：`pageSize=20`，`共 {total} 条 · 上一页 · 第 {page} 页 · 下一页`，total 取自 `content-range` 头
- **不暴露 `item_cost_price`**（成本敏感）

### 3.3 批量编辑（核心新增）
- 表前加勾选列（checkbox），表头全选（仅当前页）
- 勾选 > 0 时，底部浮现工具栏：`☑ 已选 N 项  [设分组…]  [设备注…]  [清除]`
- 点「设分组」→ 小框输入值 → 前端把选中行拼成**全值行**（`custom_group`=新值、`note`=该行现有值）→ POST 批量 RPC
- 点「设备注」同理（`note`=新值、`custom_group`=该行现有值）
- 「清除」=清空选择
- 批量只覆盖当前选中行（不做「应用到筛选结果」——YAGNI）

## 四、数据层（迁移 `055_item_admin.sql`，幂等）

### 4.1 `item_admin_v` 视图
`dim_item LEFT JOIN dim_item_ext` ON `(system_book_code, item_num)`，暴露：
`system_book_code, item_num, item_code, bar_code, item_name, category_name, category_path, top_category, item_brand, item_tags, custom_group, note, is_active`

- **用 `DROP VIEW IF EXISTS item_admin_v; CREATE VIEW ...`**（CLAUDE.md 坑：不能用 `CREATE OR REPLACE`，后迁移加列重跑会报 `cannot drop columns from view`）
- `security_invoker=true`，OWNER postgres，`GRANT SELECT ON item_admin_v TO anon, authenticated`（同 `branch_admin_v`）

### 4.2 `upsert_item_ext` 单行 RPC
逐字段镜像 `upsert_branch_ext`（`051_branch_admin.sql:24-34`）：
```sql
CREATE OR REPLACE FUNCTION upsert_item_ext(
  p_sbc TEXT, p_item TEXT, p_group TEXT, p_note TEXT, p_by TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
  VALUES (p_sbc, p_item, p_group, p_note, p_by, NOW())
  ON CONFLICT (system_book_code, item_num) DO UPDATE
    SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;
```

### 4.3 `upsert_items_ext_batch` 批量 RPC
镜像 `upsert_regions_batch(p_rows JSONB)`（`051` 同文件）：
```sql
CREATE OR REPLACE FUNCTION upsert_items_ext_batch(p_rows JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    INSERT INTO dim_item_ext (system_book_code, item_num, custom_group, note, updated_by, updated_at)
    VALUES (r->>'system_book_code', r->>'item_num', r->>'custom_group', r->>'note', r->>'updated_by', NOW())
    ON CONFLICT (system_book_code, item_num) DO UPDATE
      SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note,
          updated_by = EXCLUDED.updated_by, updated_at = NOW();
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'count', n);
END $$;
```
- `p_rows` 元素 = `{system_book_code, item_num, custom_group, note, updated_by}`（全值，前端拼）
- `GRANT EXECUTE ON FUNCTION upsert_item_ext(...)/upsert_items_ext_batch(JSONB) TO anon, authenticated`

### 4.4 部署后
**restart postgrest** 刷 schema 缓存（CLAUDE.md 坑：新视图/RPC 不重启会 400 `Could not find ... in the schema cache`）。GHA 部署不保证重启 postgrest，需手动补或脚本保证。

## 五、API `/api/admin/items`（直连 `postgrest:3000`，同门店 route）

- 连接：`POSTGREST_URL=http://postgrest:3000`，`apikey` + `Authorization: Bearer` 双头（`INSFORGE_API_KEY`，role anon）
- **GET**：`item_admin_v?select=*&system_book_code=eq.{sbc}&is_active=eq.true&{品类/分组/搜索}&order=item_num`，`Range` + `Prefer: count=exact`，返 `{data, total, page, pageSize}`
- **PATCH**：body `{system_book_code, item_num, custom_group, note, by?}` → `POST /rpc/upsert_item_ext` (`{p_sbc,p_item,p_group,p_note,p_by}`)，缺参 400
- **POST**（批量）：body `{rows:[{system_book_code,item_num,custom_group,note}], by?}` → `POST /rpc/upsert_items_ext_batch` (`{p_rows:[...]}`)，缺参/空数组 400

## 六、侧栏

`web/app/admin/layout.tsx`：紧跟「门店维护」加 NavItem「商品维护」（lucide `Boxes` 图标，href `/admin/items`）。门店维护 `Store` / 商品维护 `Boxes` 视觉对齐。

## 七、文件结构

**新建**：
- `database/migrations/055_item_admin.sql` —— `item_admin_v` 视图（DROP+CREATE）+ 2 RPC + GRANT
- `web/app/admin/items/page.tsx` —— 商品档案维护页（client，照搬 `branches/page.tsx` + 勾选工具栏）
- `web/app/api/admin/items/route.ts` —— GET 列表 / PATCH 单行 / POST 批量

**改造**：
- `web/app/admin/layout.tsx` —— 侧栏加「商品维护」入口

**不改**：`dim_item` / `dim_item_ext` 表结构（零 DDL，ext 两列已存在）。

## 八、部署

改了 migration + web/ + layout → **GHA 完整部署**（非 function-only）：
1. `git add . && git commit && git push origin main`
2. `gh run watch <run-id>`
3. GHA 完成后 **手动 restart postgrest**（或确认 migrate 后重启）：`docker compose restart postgrest`
4. 验证：`/admin/items` 可访问、列表加载、单行 Modal 编辑、勾选批量写、`item_admin_v` 在 postgrest 可查

## 九、成功标准

- 4.1万行商品档案列表筛/查/分页正常（按品牌隔离，不串品牌）
- 单行 Modal 编辑 custom_group/note → 落库 `dim_item_ext`，刷新可见
- 勾选多行 → 设分组/设备注 → 一次批量落库（`count` 正确），刷新可见
- 侧栏「商品维护」入口存在
- 零破坏：`dim_item` 采集、`canonical_product` 视图、现有 admin 页不受影响
- 迁移幂等（DROP+CREATE 视图、RPC `CREATE OR REPLACE`、GRANT 可重跑）

## 十、后续路线

1. ext 加列（重点商品 `is_key_item` 等）—— Phase 2 报表中心前按需增量迁移
2. 场景命名 `item_scenario_names` 维护（跨品牌 `item_code` 粒度，单独 tab/批）
3. 报表中心 Phase 2（消费 ext 分组 + 目标分解 + 战区维度）
