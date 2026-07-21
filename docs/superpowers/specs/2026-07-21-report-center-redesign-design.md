# 报表中心呈现层重设计

**日期**：2026-07-21
**状态**：已确认，待实现
**方案**：方案 A - 渐进式扩展 + 视图增强

---

## 1. 背景与需求

### 1.1 现状

当前报表中心是一个以「目标达成看板」为核心的单报表系统：
- 首页：目标列表
- 看板详情：KPI 卡片 → 趋势图/排行图 → 交叉表（PC/移动双端）
- 数据源：`report_achievement_v`、`report_daily_sales`、`report_daily_delivery`、`report_daily_wholesale`

### 1.2 需求变更

**删除**：
- 趋势图、排行图、交叉表

**新增/扩展**：
1. KPI 卡片 hover 显示详情（总目标、总完成、完成率）
2. 门店零售/出库数据报表（折叠下钻：大区→小区→门店）
3. 销售商品 TOP20（月度 + 当日）
4. 出库数据报表（拆分三个：类别汇总、战区门店下钻、批发客户下钻）
5. 出库商品 TOP20（月度 + 当日）
6. 预警机制（门店预警 + 仓库出库预警，定时推送到企微）

### 1.3 设计约束

- PC 和移动端都展示全部板块（响应式布局）
- 预警推送到企微群消息
- 符合 DESIGN.md 约定：禁 emoji、DM Sans 字体、tabular-nums 数字对齐、三色达成率编码

---

## 2. 整体架构

### 2.1 方案选择

**方案 A：渐进式扩展 + 视图增强**（已确认）

**理由**：
- 复用现有 `report_*` 表结构，迁移成本小
- 视图层统一鉴权（现有 RLS + claim 机制）
- 前端组件独立，可按优先级迭代
- 预警逻辑独立于报表查询，互不影响

### 2.2 报表中心看板结构

```
┌─────────────────────────────────────────────────────────┐
│ 第一部分：KPI 卡片（hover 显示详情）                      │
├─────────────────────────────────────────────────────────┤
│ 第二部分：门店零售/出库数据报表（折叠下钻）                │
├─────────────────────────────────────────────────────────┤
│ 第三部分：销售商品 TOP20（月度 + 当日）                   │
├─────────────────────────────────────────────────────────┤
│ 第四部分：出库数据报表（拆分三个）                        │
│   4.1 类别出库报表（水果/标品/耗材/合计）                 │
│   4.2 战区门店出库报表（折叠下钻）                        │
│   4.3 外部批发客户出库报表（日期→客户下钻）               │
├─────────────────────────────────────────────────────────┤
│ 第五部分：出库商品 TOP20（月度 + 当日）                   │
└─────────────────────────────────────────────────────────┘

预警机制（定时推送，不在页面内展示）
├── 门店预警（12:00 / 16:00 / 22:00）
└── 仓库出库预警（21:30）
```

---

## 3. 各板块详细设计

### 3.1 第一部分：KPI 卡片 hover 详情

**当前状态**：4 个 KPI 卡片（销售金额、出库金额、销售完成率、出库完成率）

**改进**：
- 鼠标 hover 时显示 tooltip，包含：
  - 总目标（如：¥1,234,567）
  - 总完成（如：¥1,100,000）
  - 完成率（如：89.1%）

**数据来源**：
- 复用现有 `getTargetKpi()` 返回的数据
- 前端从 `report_achievement_v` 的 `total` 行提取 target/actual/rate

**实现方式**：
- KPI 卡片组件加 tooltip 属性
- 移动端：长按触发（touch event）

**示例代码结构**：
```tsx
<KpiCard
  label="销售金额"
  value={formatCurrency(saleAmount)}
  tooltip={{
    target: formatCurrency(saleTarget),
    actual: formatCurrency(saleActual),
    rate: formatPercent(saleRate)
  }}
/>
```

---

### 3.2 第二部分：门店零售/出库数据报表

**标题**：`{target_month}月门店零售/出库数据报表`

**表头**（12 列）：
| 大区名称 | 月销售目标 | 月销售金额 | 月销售完成率 | 月出库目标 | 月出库金额 | 月出库完成率 | 当天销售金额 | 当天出库金额 | 剩余日均销售目标 | 剩余日均出库目标 |
|---------|-----------|-----------|------------|-----------|-----------|------------|------------|------------|----------------|----------------|

**折叠下钻层级**：
1. 大区层（东/南/西/中 4 行）
2. 小区层（点击大区展开）
3. 门店层（点击小区展开）

**视觉层次**：
- 大区行：无缩进，背景色浅灰，加粗
- 小区行：缩进 24px，普通字重
- 门店行：缩进 48px，普通字重

**排序规则**：
- 每级内按销售完成率降序排列

**颜色标记**：
- 完成率低于时间进度 → 单元格文字标红

**计算规则**：
- 剩余日均销售目标 = (销售目标 - 月销售金额) / 剩余天数
- 剩余日均出库目标 = (出库目标 - 月出库金额) / 剩余天数
- 剩余天数 = 目标月总天数 - 已过天数

**数据来源**：
- 后端新建视图 `report_region_breakdown_v`
- 包含字段：level, parent_code, region_name, sale_target, sale_actual, sale_rate, delivery_target, delivery_actual, delivery_rate, daily_sale, daily_delivery, remaining_daily_sale_target, remaining_daily_delivery_target

---

### 3.3 第三部分：销售商品 TOP20

**标题**：`{target_month}月度销售商品TOP20` 和 `{current_day}日销售商品TOP20`

**布局**：PC 端两个表格并排，移动端上下排列

**表头**（5 列）：
| 序号 | 商品名称 | 销售金额 | 销售毛利 | 毛利率 |
|-----|---------|---------|---------|--------|

**最后三行**：
1. TOP20小计：前 20 行汇总（销售金额、销售毛利求和，毛利率 = 毛利/金额）
2. 月度总合计：当月所有商品汇总（来自 `report_achievement_v` 的 total 行）
3. TOP20占比：TOP20小计 / 月度总合计

**排序规则**：按销售金额降序（固定）

**交互**：
- 点击「当日销售商品 TOP20」表格标题或「查看全部」按钮 → 跳转当天全部销售商品明细页

**数据来源**：
- 后端新建视图 `report_product_sale_top20_v`
- 关联 `dim_item` 获取商品名称
- 从 `report_daily_sales` 聚合销售数据

---

### 3.4 第四部分：出库数据报表（拆分三个）

#### 3.4.1 类别出库报表

**标题**：`{target_month}月仓储出库数据报表`

**表头**（11 列）：
| 类别 | 月销售目标 | 月销售金额 | 月销售完成率 | 月毛利目标 | 月毛利金额 | 月毛利完成率 | 月毛利率 | 当天出库金额 | 当天出库毛利 | 当天毛利率 | 差额日均毛利目标 |
|-----|-----------|-----------|------------|-----------|-----------|------------|---------|------------|------------|---------|---------------|

**数据行**：水果 → 标品 → 耗材 → 合计（固定排序，无下钻）

**颜色标记**：毛利率 < 12% → 标红

**计算规则**：
- 差额日均毛利目标 = (总毛利目标 - 月度汇总毛利) / 剩余天数

**数据来源**：
- 后端新建视图 `report_category_summary_v`
- 从 `report_daily_delivery` + `report_daily_wholesale` 按 category 字段聚合

#### 3.4.2 战区门店出库报表

**标题**：`{target_month}月战区门店出库数据报表`

**表头**（7 列）：
| 大区名称 | 月出库金额 | 月出库毛利 | 月毛利率 | 当天出库金额 | 当天出库毛利 | 当天毛利率 |
|---------|-----------|-----------|---------|------------|------------|---------|

**折叠下钻**：大区 → 小区 → 门店（三层折叠，与第二部分相同交互）

**排序规则**：每级内按出库金额降序

**颜色标记**：门店层毛利率 < 12% → 标红

**数据来源**：
- 后端新建视图 `report_branch_delivery_breakdown_v`
- 从 `report_daily_delivery` 按 branch_num 聚合

#### 3.4.3 外部批发客户出库报表

**标题**：`{target_month}月外部批发客户出库报表`

**表头**（4 列）：
| 日期 | 出库金额 | 出库毛利 | 毛利率 |
|-----|---------|---------|--------|

**下钻逻辑**：
1. 初始展示：按日期汇总（每天一行）
2. 点击某一行：展开该日期下的批发客户明细

**排序规则**：
- 日期层：按日期降序（最新在前）
- 客户层：按出库金额降序

**颜色标记**：批发客户毛利率 < 0% → 标红

**数据来源**：
- 后端新建视图 `report_wholesale_customer_breakdown_v`
- 从 `report_daily_wholesale` 按 customer_name 聚合

---

### 3.5 第五部分：出库商品 TOP20

**标题**：`{target_month}月度出库商品TOP20` 和 `{current_day}日出库商品TOP20`

**布局**：PC 端两个表格并排，移动端上下排列

**表头**（5 列）：
| 序号 | 商品名称 | 出库金额 | 出库毛利 | 毛利率 |
|-----|---------|---------|---------|--------|

**最后三行**：与第三部分相同（TOP20小计、总合计、TOP20占比）

**排序规则**：按出库金额降序（固定）

**颜色标记**：毛利率 < 12% → 标红

**交互**：
- 点击「当天出库商品 TOP20」表格标题或「查看全部」按钮 → 跳转当天全部出库商品明细页

**数据来源**：
- 后端新建视图 `report_product_delivery_top20_v`
- 从 `report_daily_delivery` + `report_daily_wholesale` 按 item_num 聚合

---

### 3.6 第六部分：预警机制

#### 3.6.1 门店预警

**推送时间**：12:00 / 16:00 / 22:00

**预警内容**：
1. 大区汇总对比：对比前一天营业额、客单量的上升/下降情况
2. 小区明细推送：按大区分组推送
   - 营业额下降 TOP10 门店
   - 客单量下降 TOP10 门店
   - 重点提醒：同时出现在两个 TOP10 的门店

**推送格式示例**：
```
【门店预警 12:00】

📊 大区汇总对比
东区：营业额 ↓¥5,000(-2.1%)，客单量 ↓120(-3.5%)
南区：营业额 ↑¥3,000(+1.5%)，客单量 ↑80(+2.1%)

📋 东区门店明细
营业额下降 TOP10：
1. 门店A ↓¥2,000(-5.2%)
2. 门店B ↓¥1,800(-4.8%)

客单量下降 TOP10：
1. 门店C ↓50(-6.1%)
2. 门店D ↓45(-5.5%)

⚠️ 重点提醒（双降门店）：
门店A：营业额 ↓¥2,000，客单量 ↓30
门店E：营业额 ↓¥1,500，客单量 ↓25
```

#### 3.6.2 仓库出库预警

**推送时间**：21:30

**预警内容**：
1. 大类别汇总对比：对比前一天出库金额、毛利、毛利率的变化
2. 低毛利商品汇总：当天毛利率 < 12% 的商品数量、金额、毛利、占比
3. 趋势对比：低毛利商品数、金额/毛利占比的变化
4. 调整建议：为达到 12% 综合毛利率目标提供建议

**推送格式示例**：
```
【仓库出库预警 21:30】

📊 大类别汇总对比
水果：出库金额 ↑¥5,000(+3.2%)，毛利 ↑¥600(+2.8%)，毛利率 12.1%
标品：出库金额 ↓¥3,000(-2.1%)，毛利 ↓¥360(-2.0%)，毛利率 12.0%
耗材：出库金额 ↑¥1,000(+5.0%)，毛利 ↑¥120(+5.0%)，毛利率 12.0%

⚠️ 低毛利商品汇总
当天毛利率 < 12% 商品数：15 个
出库金额：¥50,000（占比 25.0%）
出库毛利：¥5,000（占比 20.0%）

📈 趋势对比
低毛利商品数：↑ 3 个
金额占比：↑ 2.0%
毛利占比：↓ 1.0%

💡 调整建议
当前综合毛利率：11.8%，距离目标 12% 差 0.2%

建议措施：
1. 商品A 出库价上调 ¥0.5，可提升毛利 ¥300
2. 商品B 出库价上调 ¥1.0，可提升毛利 ¥200
3. 加强水果类商品出库占比（当前 30% → 建议 35%）
```

**推送渠道**：企微群消息（配置群机器人 webhook）

**推送逻辑**：
- 定时任务触发（scheduler cron）
- 计算前一天 vs 当天数据差异
- 生成预警文案
- 调用企微 webhook 发送消息

---

## 4. 技术实现

### 4.1 后端视图设计

#### 4.1.1 report_region_breakdown_v

**用途**：门店零售/出库数据报表（第二部分）

**数据源**：
- `report_daily_sales`（销售数据）
- `report_daily_delivery`（出库数据）
- `dim_branch`（门店维表，包含大区/小区层级）

**字段**：
```sql
CREATE VIEW report_region_breakdown_v AS
SELECT
  level,                    -- 'region' / 'sub_region' / 'store'
  parent_code,              -- 上级编码
  region_code,              -- 大区编码
  region_name,              -- 大区名称
  sub_region_code,          -- 小区编码
  sub_region_name,          -- 小区名称
  branch_num,               -- 门店编码
  branch_name,              -- 门店名称
  sale_target,              -- 月销售目标
  sale_actual,              -- 月销售金额
  sale_rate,                -- 月销售完成率
  delivery_target,          -- 月出库目标
  delivery_actual,          -- 月出库金额
  delivery_rate,            -- 月出库完成率
  daily_sale,               -- 当天销售金额
  daily_delivery,           -- 当天出库金额
  remaining_daily_sale_target,   -- 剩余日均销售目标
  remaining_daily_delivery_target -- 剩余日均出库目标
FROM ...
```

#### 4.1.2 report_product_sale_top20_v

**用途**：销售商品 TOP20（第三部分）

**数据源**：
- `report_daily_sales`（销售数据）
- `dim_item`（商品维表）

**字段**：
```sql
CREATE VIEW report_product_sale_top20_v AS
SELECT
  period,              -- 'month' / 'day'
  rank,                -- 排名（1-20）
  item_num,            -- 商品编码
  product_name,        -- 商品名称
  sale_amount,         -- 销售金额
  sale_profit,         -- 销售毛利
  profit_rate,         -- 毛利率
  top20_subtotal_amount,   -- TOP20小计销售金额
  top20_subtotal_profit,   -- TOP20小计销售毛利
  total_amount,        -- 月度总合计销售金额
  total_profit,        -- 月度总合计销售毛利
  top20_amount_ratio,  -- TOP20销售金额占比
  top20_profit_ratio   -- TOP20销售毛利占比
FROM ...
```

#### 4.1.3 report_category_summary_v

**用途**：类别出库报表（第四部分 4.1）

**数据源**：
- `report_daily_delivery`（出库数据）
- `report_daily_wholesale`（批发数据）
- `dim_item`（商品维表，包含 category 字段）

**字段**：
```sql
CREATE VIEW report_category_summary_v AS
SELECT
  category,             -- 类别：水果/标品/耗材/合计
  sale_target,          -- 月销售目标
  sale_actual,          -- 月销售金额
  sale_rate,            -- 月销售完成率
  profit_target,        -- 月毛利目标
  profit_actual,        -- 月毛利金额
  profit_rate,          -- 月毛利完成率
  profit_margin,        -- 月毛利率
  daily_amount,         -- 当天出库金额
  daily_profit,         -- 当天出库毛利
  daily_profit_margin,  -- 当天毛利率
  remaining_daily_profit_target  -- 差额日均毛利目标
FROM ...
```

#### 4.1.4 report_branch_delivery_breakdown_v

**用途**：战区门店出库报表（第四部分 4.2）

**数据源**：
- `report_daily_delivery`（出库数据）
- `dim_branch`（门店维表）

**字段**：
```sql
CREATE VIEW report_branch_delivery_breakdown_v AS
SELECT
  level,                -- 'region' / 'sub_region' / 'store'
  parent_code,          -- 上级编码
  region_name,          -- 大区名称
  sub_region_name,      -- 小区名称
  branch_name,          -- 门店名称
  delivery_amount,      -- 月出库金额
  delivery_profit,      -- 月出库毛利
  profit_margin,        -- 月毛利率
  daily_amount,         -- 当天出库金额
  daily_profit,         -- 当天出库毛利
  daily_profit_margin   -- 当天毛利率
FROM ...
```

#### 4.1.5 report_wholesale_customer_breakdown_v

**用途**：外部批发客户出库报表（第四部分 4.3）

**数据源**：
- `report_daily_wholesale`（批发数据）

**字段**：
```sql
CREATE VIEW report_wholesale_customer_breakdown_v AS
SELECT
  level,                -- 'date' / 'customer'
  parent_date,          -- 上级日期（客户层用）
  date,                 -- 日期
  customer_name,        -- 客户名称
  delivery_amount,      -- 出库金额
  delivery_profit,      -- 出库毛利
  profit_margin         -- 毛利率
FROM ...
```

#### 4.1.6 report_product_delivery_top20_v

**用途**：出库商品 TOP20（第五部分）

**数据源**：
- `report_daily_delivery`（出库数据）
- `report_daily_wholesale`（批发数据）
- `dim_item`（商品维表）

**字段**：
```sql
CREATE VIEW report_product_delivery_top20_v AS
SELECT
  period,              -- 'month' / 'day'
  rank,                -- 排名（1-20）
  item_num,            -- 商品编码
  product_name,        -- 商品名称
  delivery_amount,     -- 出库金额
  delivery_profit,     -- 出库毛利
  profit_rate,         -- 毛利率
  top20_subtotal_amount,   -- TOP20小计出库金额
  top20_subtotal_profit,   -- TOP20小计出库毛利
  total_amount,        -- 月度总合计出库金额
  total_profit,        -- 月度总合计出库毛利
  top20_amount_ratio,  -- TOP20出库金额占比
  top20_profit_ratio   -- TOP20出库毛利占比
FROM ...
```

### 4.2 前端组件设计

#### 4.2.1 KpiCardWithTooltip

**用途**：KPI 卡片，hover 显示详情

**Props**：
```tsx
interface KpiCardProps {
  label: string;           // 标签（如"销售金额"）
  value: string;           // 大数字（如"¥1,234,567"）
  tooltip: {
    target: string;        // 总目标
    actual: string;        // 总完成
    rate: string;          // 完成率
  };
}
```

#### 4.2.2 RegionDrillTable

**用途**：门店零售/出库数据报表（折叠下钻表格）

**Props**：
```tsx
interface RegionDrillTableProps {
  targetId: string;        // 目标 ID
  targetMonth: number;     // 目标月份
  progress: number;        // 时间进度（如 0.677）
}
```

**功能**：
- 三层折叠（大区→小区→门店）
- 每级内按销售完成率降序
- 完成率低于时间进度标红
- 响应式：PC 端完整 12 列，移动端横向滚动

#### 4.2.3 ProductTop20

**用途**：销售商品 TOP20 / 出库商品 TOP20

**Props**：
```tsx
interface ProductTop20Props {
  type: 'sale' | 'delivery';  // 销售/出库
  targetId: string;
  targetMonth: number;
  currentDay: number;
}
```

**功能**：
- 两个表格（月度/当日）并排或上下排列
- 最后三行：TOP20小计、总合计、TOP20占比
- 毛利率 < 12% 标红
- 点击「查看全部」跳转明细页

#### 4.2.4 CategorySummary

**用途**：类别出库报表

**Props**：
```tsx
interface CategorySummaryProps {
  targetId: string;
  targetMonth: number;
}
```

**功能**：
- 4 行数据（水果/标品/耗材/合计）
- 固定排序
- 毛利率 < 12% 标红

#### 4.2.5 BranchDrillTable

**用途**：战区门店出库报表（折叠下钻表格）

**Props**：
```tsx
interface BranchDrillTableProps {
  targetId: string;
  targetMonth: number;
}
```

**功能**：
- 三层折叠（大区→小区→门店）
- 每级内按出库金额降序
- 门店层毛利率 < 12% 标红

#### 4.2.6 WholesaleDrillTable

**用途**：外部批发客户出库报表（日期→客户下钻）

**Props**：
```tsx
interface WholesaleDrillTableProps {
  targetId: string;
  targetMonth: number;
}
```

**功能**：
- 两层折叠（日期→客户）
- 日期层按日期降序，客户层按出库金额降序
- 批发客户毛利率 < 0% 标红

### 4.3 预警机制实现

#### 4.3.1 定时任务

**scheduler 配置**：
```yaml
# 门店预警（12:00 / 16:00 / 22:00）
- cron: "0 12 * * *"
  function: send-store-alert
- cron: "0 16 * * *"
  function: send-store-alert
- cron: "0 22 * * *"
  function: send-store-alert

# 仓库出库预警（21:30）
- cron: "30 21 * * *"
  function: send-warehouse-alert
```

#### 4.3.2 Edge Function

**send-store-alert**：
```javascript
// 1. 查询前一天 vs 当天营业额、客单量
// 2. 按大区汇总对比
// 3. 找出下降 TOP10 门店
// 4. 找出双降门店
// 5. 生成预警文案
// 6. 调用企微 webhook 发送
```

**send-warehouse-alert**：
```javascript
// 1. 查询前一天 vs 当天出库数据
// 2. 按类别汇总对比
// 3. 统计低毛利商品
// 4. 计算趋势对比
// 5. 生成调整建议
// 6. 调用企微 webhook 发送
```

#### 4.3.3 企微 Webhook

**配置**：
- 在企微群中添加群机器人
- 获取 webhook URL
- 存储在 `WECOM_ALERT_WEBHOOK` secret 中

**调用方式**：
```javascript
await fetch(WECOM_ALERT_WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: alertMessage }
  })
});
```

---

## 5. 数据流

### 5.1 报表数据流

```
采集任务（scheduler）
  ↓
report_daily_sales / report_daily_delivery / report_daily_wholesale
  ↓
/compute 聚合
  ↓
report_achievement_v / report_region_breakdown_v / report_product_sale_top20_v / ...
  ↓
PostgREST 查询（带用户 claim）
  ↓
前端组件渲染
```

### 5.2 预警数据流

```
定时任务（scheduler cron）
  ↓
Edge Function（send-store-alert / send-warehouse-alert）
  ↓
查询前一天 vs 当天数据
  ↓
计算差异、生成预警文案
  ↓
企微 Webhook 推送
```

---

## 6. 迁移计划

### 6.1 后端迁移

1. 创建视图 `report_region_breakdown_v`
2. 创建视图 `report_product_sale_top20_v`
3. 创建视图 `report_category_summary_v`
4. 创建视图 `report_branch_delivery_breakdown_v`
5. 创建视图 `report_wholesale_customer_breakdown_v`
6. 创建视图 `report_product_delivery_top20_v`
7. 配置企微 webhook secret（`WECOM_ALERT_WEBHOOK`）
8. 创建 Edge Function `send-store-alert`
9. 创建 Edge Function `send-warehouse-alert`
10. 配置 scheduler cron 任务

### 6.2 前端迁移

1. 创建组件 `KpiCardWithTooltip`
2. 创建组件 `RegionDrillTable`
3. 创建组件 `ProductTop20`
4. 创建组件 `CategorySummary`
5. 创建组件 `BranchDrillTable`
6. 创建组件 `WholesaleDrillTable`
7. 修改看板页面 `desktop.tsx` / `mobile.tsx`：
   - 删除趋势图、排行图、交叉表
   - 添加新组件
8. 删除孤儿组件（bar-chart、report-card、report-detail-skeleton）

### 6.3 优先级

**Phase 1**（核心功能）：
- 第一部分：KPI 卡片 hover 详情
- 第二部分：门店零售/出库数据报表
- 第四部分 4.1：类别出库报表

**Phase 2**（扩展功能）：
- 第三部分：销售商品 TOP20
- 第四部分 4.2：战区门店出库报表
- 第五部分：出库商品 TOP20

**Phase 3**（预警机制）：
- 第六部分：门店预警 + 仓库出库预警

---

## 7. 风险与待办

### 7.1 风险

1. **视图性能**：部分视图涉及多表关联和大聚合，可能影响查询性能
   - 缓解：在 `report_daily_*` 表上加索引，考虑物化视图
2. **预警推送时机**：定时任务依赖 scheduler，如果 scheduler 挂掉会影响推送
   - 缓解：监控 scheduler 健康状态，异常时告警
3. **企微 webhook 限流**：频繁推送可能被企微限流
   - 缓解：合并多条预警为一条消息，避免短时间多次推送

### 7.2 待办

1. 确认批发客户数据源字段（`customer_name` 是否存在于 `report_daily_wholesale`）
2. 确认商品类别字段（`category` 是否存在于 `dim_item`）
3. 确认门店预警的客单量数据源（是否需要采集客单量数据）
4. 确认预警推送的具体企微群（需要 webhook URL）
5. 确认「查看全部」跳转的明细页路由（是否需要新建页面）

---

## 8. 附录

### 8.1 相关文件

**前端**：
- `web/app/reports/targets/[id]/desktop.tsx` - PC 看板布局
- `web/app/reports/targets/[id]/mobile.tsx` - 移动看板布局
- `web/components/report-center/` - 报表组件目录
- `web/lib/report-center/` - 数据获取库

**后端**：
- `database/migrations/` - 数据库迁移文件
- `functions/` - Edge Functions
- `deploy/` - 部署配置

**文档**：
- `DESIGN.md` - 设计系统约定
- `docs/architecture.md` - 架构文档

### 8.2 参考

- DESIGN.md 报表中心特定约定（第 65-72 行）
- 架构文档子系统 C（第 461-479 行）
- 现有 `report_achievement_v` 视图设计
