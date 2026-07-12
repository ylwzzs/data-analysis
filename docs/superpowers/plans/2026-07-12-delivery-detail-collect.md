# 配送调出明细采集（delivery_detail）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建「配送调出明细」采集任务，照搬 retail_detail（collect.ts）模式，只在 3120 采集（配送中心 distributionBranchNum=99），64188 共用此数据，落 Parquet，不算汇总。

**Architecture:** 复用 data-collect-system（collect.ts / scheduler / DuckDB /transform / S3 Parquet / collect_tasks / datasets）。新建 `web/lib/collect-delivery.ts` 采集模块 + scheduler 加 `task_type='delivery'` 分支 + migration 049（3120 任务 + 监控 + datasets 注册）+ 手动触发 route + SKILL 路由。endpoint `nhsoft.amazon.transfer.item.detail`，offset/limit 分页，落 `lemeng/transfer_detail/{company_id}/{date}/all.parquet`。

**Tech Stack:** Next.js 采集（web 进程，复用 collect.ts 签名）+ DuckDB `/transform`/`/merge` + Parquet/S3（天翼云 OOS）+ PostgreSQL（collect_tasks/logs/datasets/monitor_rules）+ node-cron。

**接口依据**：`docs/superpowers/specs` 口述 + memory `lemeng-delivery-detail-api.md`（实测：endpoint `nhsoft.amazon.transfer.item.detail`，body 驼峰 offset 分页，response `{code:"0",data:{count,content:[{...}]}}`，粒度=调出单明细行）。

---

## File Structure

- **Create** `web/lib/collect-delivery.ts` — 配送明细采集核心（签名复用 collect.ts 算法、item.detail endpoint、offset 分页、flatten、落 Parquet、对账）。被 route + scheduler 共用。
- **Modify** `web/lib/scheduler.ts` — `executeTask` 加 `if (params.task_type === 'delivery')` 分支（mode 判定、collectDeliveryOnce、对账重试、水位线、writeLog）。不 triggerCompute（先不汇总）。
- **Create** `web/app/api/admin/collect-delivery/route.ts` — 手动触发入口（照 collect-lemeng route）。
- **Create** `database/migrations/049_transfer_detail_collect.sql` — collect_tasks 加 3120 delivery 任务 + monitor_rules（collect_fail consecutive=3）+ datasets 注册 delivery_detail + dataset_columns。幂等。
- **Modify** `openclaw/data-query-plugin/skills/retail-query/SKILL.md` — 加 delivery_detail（配送明细）路由段。

---

## Task 1: 采集核心 `web/lib/collect-delivery.ts`

**Files:** Create `web/lib/collect-delivery.ts`

照 `web/lib/collect.ts` 结构，换 endpoint/body/flatten/分页。签名算法、headers、callLemengApi、fetchWithTimeout、decodeCompanyId 与 collect.ts **完全一致**（独立实现，不动 collect.ts，避免影响在跑的 retail）。

- [ ] **Step 1: 写 `web/lib/collect-delivery.ts`**

```ts
// web/lib/collect-delivery.ts
// 配送调出明细采集（乐檬 nhsoft.amazon.transfer.item.detail），照 collect.ts 模式。
// 只 3120（配送中心 distributionBranchNum=99），64188 共用此数据。
// 落 Parquet: lemeng/transfer_detail/{company_id}/{date}/all.parquet
import crypto from 'crypto';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_DETAIL = "/earth-gateway/amazon-report/report/center/nhsoft.amazon.transfer.item.detail";
const REQUEST_TIMEOUT = 30000;
const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

// 从 token 解 company_id（品牌），用于按品牌分区存储。同 collect.ts。
function decodeCompanyId(authToken: string): string {
  try {
    const raw = authToken.startsWith('Bearer ') ? authToken.slice(7) : authToken;
    const parts = raw.split('.');
    if (parts.length < 2) return 'unknown';
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return String(payload.company_id || 'unknown');
  } catch { return 'unknown'; }
}

// 签名算法（与 collect.ts 完全一致）
function generateSignature(authToken: string, timestamp: string, nonce: string, branchNums: string, scopeIds: string, urlPath: string, bodyStr: string, secretKey: string): string {
  const signStr = authToken + timestamp + nonce + branchNums + scopeIds + secretKey + urlPath + bodyStr + secretKey;
  return crypto.createHash('sha256').update(signStr, 'utf8').digest('hex');
}
function buildHeaders(authToken: string, branchNumsStr: string, urlPath: string, bodyStr: string) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(authToken, timestamp, nonce, branchNumsStr, "", urlPath, bodyStr, LEMENG_SECRET_KEY);
  return {
    "Authorization": authToken, "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "x-timestamp": timestamp, "x-nonce": nonce, "x-signature": signature,
    "X-LoginBranchNum": "99", "x-branch-nums": branchNumsStr, "x-desensitization-columns": ""
  };
}

// body 构造（实测抓到的真实结构）：驼峰，offset 分页，responseBranchNums 空=全部调入
function buildBody(distributionBranch: number, dtFrom: string, dtTo: string, offset: number, limit: number): string {
  return JSON.stringify({
    branchNums: [distributionBranch], dateType: "调出日期", dtFrom, dtTo,
    distributionBranchNums: [distributionBranch], responseBranchNums: [],   // 空=全部调入门店
    unitType: "常用单位", itemNums: [], itemLabelNums: [], itemDepartments: [], storehouseNums: [],
    filterPolicyItems: false, filterCreditNote: false, categoryCodes: [], isEnableTax: false, queryTime: false,
    managementStyles: [], taxRates: [], supplierNums: [],
    userBranchNum: distributionBranch, userStorehouseNums: [],
    dtType: "调出日期", branchNum: distributionBranch, paging: true, offset, limit
  });
}

// 扁平化：提取明细核心字段（snake_case，落 Parquet 用）。pos_order_* / 门店 / 商品 / 交易量额毛利
function flattenRecords(records: any[]): any[] {
  return records.map(r => ({
    id: r.id,
    pos_order_num: r.posOrderNum,
    pos_order_type: r.posOrderType,
    order_time: r.orderTime,
    sale_time: r.saleTime,
    state: r.state,
    distribution_branch_num: r.distributionBranchNum,
    distribution_branch_name: r.distributionBranchName,
    response_branch_num: r.responseBranchNum,
    response_branch_name: r.responseBranchName,
    response_branch_region_name: r.responseBranchRegionName,
    storehouse_num: r.storehouseNum,
    storehouse_name: r.storehouseName,
    item_num: r.itemNum,
    pos_item_code: r.posItemCode,
    pos_item_name: r.posItemName,
    item_category: r.itemCategory,
    top_category_name: r.topCategoryName,
    department: r.department,
    item_method: r.itemMethod,
    spec: r.spec,
    out_unit: r.outUnit,
    lot_number: r.lotNumber,
    out_amount: r.outAmount,            // 调出数量（拿货量）
    out_money: r.outMoney,              // 调出金额
    out_unit_price: r.outUnitPrice,
    cost_price: r.costPrice,            // 成本
    cost_unit_price: r.costUnitPrice,
    profit_money: r.profitMoney,        // 毛利
    no_tax_out_money: r.noTaxOutMoney,
    tax_money: r.taxMoney,
    base_amount: r.baseAmount,
    base_price: r.basePrice,
    order_maker: r.orderMaker,
    order_seller: r.orderSeller,
    order_auditor: r.orderAuditor,
  }));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout); return response;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`Request timeout after ${timeoutMs}ms`);
    throw err;
  }
}

async function callLemengApi(urlPath: string, authToken: string, bodyStr: string, branchNumsStr: string, maxRetries = 2): Promise<{ ok: boolean; data?: any; status?: number; error?: string }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = buildHeaders(authToken, branchNumsStr, urlPath, bodyStr);
    try {
      const response = await fetchWithTimeout(BASE_URL + urlPath, { method: 'POST', headers, body: bodyStr }, REQUEST_TIMEOUT);
      if (response.status === 200) {
        const data = await response.json();
        if (data.code === -1 && attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return { ok: true, data };
      }
      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: any) {
      if (attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

export function getYesterdayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  chinaTime.setDate(chinaTime.getDate() - 1);
  return chinaTime.toISOString().split('T')[0];
}
export function getTodayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().split('T')[0];
}

export interface DeliveryCollectResult {
  records: any[]; apiTotal: number; storagePath: string; error: string; newApiTotal: number; skipped: boolean;
}
export interface DeliveryCollectOptions { mode?: 'full' | 'incremental'; watermarkLastCount?: number; }

// 单次采集：首页拿 count + 预热 → offset 分页拉全 → 落 Parquet
// branchNumsStr：签名/header 用（配送中心号字符串，如 "99"）
export async function collectDeliveryOnce(
  authToken: string,
  distributionBranch: number,
  branchNumsStr: string,
  dtFrom: string,    // "YYYY-MM-DD HH:MM:SS"
  dtTo: string,
  limit: number = 200,
  options?: DeliveryCollectOptions,
): Promise<DeliveryCollectResult> {
  const mode = options?.mode || 'full';
  const watermarkLastCount = options?.watermarkLastCount ?? 0;
  const result: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
  const companyId = decodeCompanyId(authToken);

  // 首页：拿 count + 预热 token
  const firstBody = buildBody(distributionBranch, dtFrom, dtTo, 0, limit);
  const firstRes = await callLemengApi(ENDPOINT_DETAIL, authToken, firstBody, branchNumsStr);
  if (!firstRes.ok) { result.error = firstRes.error || 'first page failed'; return result; }
  if (firstRes.data?.code === -1) { result.error = `Token expired: ${firstRes.data?.message}`; return result; }
  if (firstRes.data?.code !== 0) { result.error = `API code=${firstRes.data?.code} msg=${firstRes.data?.msg}`; return result; }

  const data = firstRes.data?.data || {};
  result.apiTotal = data.count || 0;
  result.newApiTotal = result.apiTotal;
  const firstRecords = data.content || [];
  result.records.push(...firstRecords);
  if (result.apiTotal === 0) return result;

  // 增量跳过
  if (mode === 'incremental' && result.apiTotal <= watermarkLastCount) {
    console.log(`[collect-delivery] Incremental: apiTotal ${result.apiTotal} <= watermark ${watermarkLastCount}, skip`);
    result.skipped = true; return result;
  }

  // offset 分页（从首页之后续采）
  let offset = firstRecords.length;
  let consecutiveErrors = 0;
  const maxPages = 500;
  let pages = 0;
  while (offset < result.apiTotal && pages < maxPages) {
    const bodyStr = buildBody(distributionBranch, dtFrom, dtTo, offset, limit);
    const pr = await callLemengApi(ENDPOINT_DETAIL, authToken, bodyStr, branchNumsStr);
    if (!pr.ok || pr.data?.code !== 0) {
      console.error(`[collect-delivery] offset ${offset} error: ${pr.error || pr.data?.msg}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) { result.error = `Consecutive 3 pages failed at offset ${offset}`; break; }
      offset += limit; pages++; continue;
    }
    consecutiveErrors = 0;
    const recs = pr.data?.data?.content || [];
    result.records.push(...recs);
    console.log(`[collect-delivery] offset ${offset}/${result.apiTotal}: +${recs.length}, total ${result.records.length}`);
    offset += limit; pages++;
    if (recs.length === 0) break;
  }

  // 落 Parquet：full 用 /transform 覆盖；incremental 用 /merge
  if (result.records.length > 0) {
    try {
      const flat = flattenRecords(result.records);
      const dateStr = dtFrom.slice(0, 10).replace(/-/g, ''); // YYYYMMDD
      const isInc = mode === 'incremental';
      const endpoint = isInc ? '/merge' : '/transform';
      const action = isInc ? 'merge' : 'transform';
      console.log(`[collect-delivery] DuckDB ${action}: ${flat.length} records`);
      const duckRes = await fetch(`${DUCKDB_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
        body: JSON.stringify({
          records: flat,
          config: {
            date: dateStr, source: 'lemeng',
            partition_by: ['response_branch_num'],          // 按调入门店分片
            dedupe_key: ['id'],                              // 调出单明细行唯一 id
            required_fields: ['pos_order_num', 'item_num', 'response_branch_num'],
            output_format: 'parquet', compression: 'zstd',
            base_path: `lemeng/transfer_detail/${companyId}/${dateStr}`
          }
        })
      });
      if (!duckRes.ok) throw new Error(`DuckDB ${action} failed: ${duckRes.status} ${await duckRes.text()}`);
      const dj = await duckRes.json();
      if (!dj.success) throw new Error(dj.error || `${action} failed`);
      result.storagePath = dj.combined_file;
      console.log(`[collect-delivery] Parquet ${action} success: ${result.storagePath}`);
      if (dj.invalid_records > 0 || dj.duplicates_removed > 0)
        console.warn(`[collect-delivery] data quality: ${dj.invalid_records} invalid, ${dj.duplicates_removed} dup`);
    } catch (e: any) {
      console.error(`[collect-delivery] DuckDB ${mode} failed: ${e.message}`);
      result.error += (result.error ? '; ' : '') + `${mode === 'incremental' ? 'Merge' : 'Transform'} failed: ${e.message}`;
    }
  }
  return result;
}

export { LEMENG_SECRET_KEY };
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `cd web && npx tsc --noEmit lib/collect-delivery.ts` （或整体 `npx tsc --noEmit`，预期无类型错误）
Expected: 无报错（签名/接口与 collect.ts 同款）

- [ ] **Step 3: Commit**

```bash
git add web/lib/collect-delivery.ts
git commit -m "feat(delivery): 配送调出明细采集核心 collect-delivery.ts"
```

---

## Task 2: scheduler 加 `task_type='delivery'` 分支

**Files:** Modify `web/lib/scheduler.ts`

在 `executeTask` 里、retail 分支之前，加 delivery 分支。照 retail 分支（mode 判定/对账重试/水位线/writeLog），换：dtFrom/dtTo 构造、调 `collectDeliveryOnce`、不 triggerCompute。

- [ ] **Step 1: 在 `web/lib/scheduler.ts` 顶部 import 加 `collectDeliveryOnce`**

找到现有 `import { collectOnce, ... } from './collect';` 那行，下方加：

```ts
import { collectDeliveryOnce, type DeliveryCollectResult } from './collect-delivery';
```

- [ ] **Step 2: 在 `executeTask` 的 `if (params.task_type === 'branches')` 分支之后、retail 默认分支之前，插入 delivery 分支**

定位锚点：`// ===== 订单明细采集（默认） =====`（retail 分支注释，约 scheduler.ts:278）。在其**之前**插入：

```ts
    if (params.task_type === 'delivery') {
      // ===== 配送调出明细采集（仅 3120，配送中心99；64188 共用此数据）=====
      console.log(`[scheduler] 配送明细采集: ${task.name}`);
      const distributionBranch = Number(params.distribution_branch_num) || 99;
      const branchNumsStr = String(distributionBranch);
      const limit = params.page_size || 200;
      const today = getTodayChina();
      // dtFrom/dtTo 带时分秒（接口要求 "YYYY-MM-DD HH:MM:SS"）
      const dates = params.date_mode === 'today'
        ? { from: `${today} 00:00:00`, to: `${today} 23:59:59` }
        : { from: `${getYesterdayChina()} 00:00:00`, to: `${getYesterdayChina()} 23:59:59` };

      // 模式判定（同 retail：新一天/距上次全量≥55min/无水位线 → full；否则 incremental）
      const watermark = params.watermark || {};
      const watermarkLastCount: number = watermark.last_count || 0;
      const mode: 'full' | 'incremental' =
        (watermark.date !== today || Date.now() - (watermark.last_full_ts || 0) >= 55 * 60 * 1000 || watermark.last_count == null) ? 'full' : 'incremental';
      console.log(`[scheduler] 任务 ${task.name}: dtFrom=${dates.from}, mode=${mode}`);

      let lastResult: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
      let verified = false;

      if (mode === 'incremental') {
        lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit, { mode: 'incremental', watermarkLastCount });
        if (lastResult.error.startsWith('Token expired')) {
          await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
          await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
          return;
        }
        verified = true; // 增量不对账，交给每小时 full
      } else {
        for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
          console.log(`[scheduler] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);
          lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit, { mode: 'full' });
          if (lastResult.error.startsWith('Token expired')) {
            await writeLog(client, task.id, startedAt, new Date(), 'failed', 0, lastResult.error);
            await notifyWecom('❌ Token 过期', `**任务**: ${task.name}\n**错误**: ${lastResult.error}`);
            return;
          }
          if (lastResult.apiTotal === 0) { await writeLog(client, task.id, startedAt, new Date(), 'success', 0); return; }
          const missing = lastResult.apiTotal - lastResult.records.length;
          verified = lastResult.records.length >= lastResult.apiTotal;
          if (verified) { console.log(`[scheduler] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`); break; }
          if (attempt < MAX_VERIFY_RETRIES) {
            console.warn(`[scheduler] ⚠️ 对账失败: 缺 ${missing}，5s 后重试`);
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.error(`[scheduler] ❌ ${MAX_VERIFY_RETRIES} 次失败: 缺 ${missing}`);
            await notifyWecom('❌ 配送明细采集不完整', `**任务**: ${task.name}\n**日期**: ${dates.from}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**缺**: ${missing}`);
            lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): 缺 ${missing}`;
          }
        }
      }

      // 更新水位线（同 retail：仅落盘成功才推进）
      const finishedAt = new Date();
      const nowMs = finishedAt.getTime();
      const persistOk = !lastResult.error;
      const newWatermark = {
        date: today,
        last_count: persistOk ? lastResult.newApiTotal : watermarkLastCount,
        last_full_ts: (mode === 'full' && persistOk) ? nowMs : (watermark.last_full_ts || nowMs),
      };
      await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString(), params: { ...params, watermark: newWatermark } }).eq('id', task.id);

      // 不 triggerCompute（先只落明细，汇总后续）
      const finalStatus = lastResult.error ? 'partial' : 'success';
      await writeLog(client, task.id, startedAt, finishedAt, finalStatus, lastResult.records.length, lastResult.error || undefined,
        { mode, skipped: lastResult.skipped, storage_path: lastResult.storagePath, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } });
      console.log(`[scheduler] 配送明细 ${task.name}: ${finalStatus} ${mode}${lastResult.skipped ? '(skipped)' : `(${lastResult.records.length} 条)`} ${verified ? '✅' : '❌'}`);
      return;
    }
```

- [ ] **Step 3: 确认 `notifyWecom` / `writeLog` / `MAX_VERIFY_RETRIES` / `getTodayChina`/`getYesterdayChina` 已在 scheduler.ts 顶部 import/定义**（retail 分支已用，复用即可，无需新增）

- [ ] **Step 4: 编译检查**

Run: `cd web && npx tsc --noEmit`
Expected: 无报错

- [ ] **Step 5: Commit**

```bash
git add web/lib/scheduler.ts
git commit -m "feat(delivery): scheduler 加 task_type=delivery 分支(对账+水位线,不汇总)"
```

---

## Task 3: migration 049（任务 + 监控 + datasets 注册）

**Files:** Create `database/migrations/049_transfer_detail_collect.sql`

幂等（ON CONFLICT）。collect_tasks 加 3120 delivery 任务（source=3120，cron 同 retail 3120 错峰，distribution_branch_num=99）；monitor_rules collect_fail consecutive=3；datasets 注册 delivery_detail（duckdb_view，parquet glob）+ 列。

- [ ] **Step 1: 写 `database/migrations/049_transfer_detail_collect.sql`**

```sql
-- 049_transfer_detail_collect.sql
-- 配送调出明细采集任务（仅 3120，配送中心99；64188 共用）+ 监控 + datasets 注册
-- 幂等：ON CONFLICT。设计见 memory lemeng-delivery-detail-api.md

-- ===== 1. 采集任务（只 3120）=====
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled) VALUES
 ('a0000000-0000-0000-0000-000000000010'::uuid, '乐檬-3120-配送调出明细采集',
  'a0000000-0000-0000-0000-000000000001'::uuid,   -- source = 3120
  'collect-delivery',
  '*/5 8-23 * * *',                               -- 同 retail 3120（当天增量+每小时全量）
  '{"task_type":"delivery","date_mode":"today","page_size":200,"distribution_branch_num":99}'::jsonb,
  true)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, params=EXCLUDED.params, enabled=true;

-- ===== 2. 采集失败告警（连续 3 次 partial/failed）=====
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-配送明细', 'collect_fail', 'a0000000-0000-0000-0000-000000000010',
  '{"consecutive":3,"window":5}'::jsonb, 'high',
  '连续 {consecutive_count} 次失败（最近 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold=EXCLUDED.threshold, severity=EXCLUDED.severity, template=EXCLUDED.template, enabled=true;

-- ===== 3. datasets 注册（让 LLM 字典 + agent-query 路由感知 delivery_detail）=====
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description) VALUES
 ('delivery_detail','配送调出明细(乐檬配送毛利)','duckdb_view',
  's3://lemeng-datasource/lemeng/transfer_detail/*/*/all.parquet','fact',TRUE,FALSE,
  'order_time','YYYYMMDD',FALSE,TRUE,
  '配送中心调出门店的明细（每条=一个调出单的商品行）；含调出量out_amount/调出额out_money/毛利profit_money/成本cost_price/调入门店response_branch_num；全字符串列，数学运算须 CAST')
ON CONFLICT (name) DO UPDATE SET display_name=EXCLUDED.display_name, engine=EXCLUDED.engine,
  source=EXCLUDED.source, kind=EXCLUDED.kind, is_realtime=EXCLUDED.is_realtime,
  columns_typed=EXCLUDED.columns_typed, date_column=EXCLUDED.date_column,
  date_format=EXCLUDED.date_format, description=EXCLUDED.description;

-- ===== 4. delivery_detail 列注册（成本/毛利组 is_sensitive=TRUE，按 can_see_cost 整组脱敏）=====
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal) VALUES
 ('delivery_detail','id','VARCHAR','单据',FALSE,NULL,'明细行唯一id（去重键）',1),
 ('delivery_detail','pos_order_num','VARCHAR','单据',FALSE,NULL,'调出单号',2),
 ('delivery_detail','pos_order_type','VARCHAR','单据',FALSE,NULL,'单据类型(调出单)',3),
 ('delivery_detail','order_time','VARCHAR','日期',FALSE,NULL,'调出业务日 YYYY-MM-DD HH:MM:SS（按日过滤用 order_time）',4),
 ('delivery_detail','sale_time','VARCHAR','日期',FALSE,NULL,'调出时间',5),
 ('delivery_detail','state','VARCHAR','单据',FALSE,NULL,'状态(未配货等)',6),
 ('delivery_detail','distribution_branch_num','VARCHAR','调出方',FALSE,NULL,'调出方(配送中心)号=99',7),
 ('delivery_detail','distribution_branch_name','VARCHAR','调出方',FALSE,NULL,'调出方名(管理中心)',8),
 ('delivery_detail','response_branch_num','VARCHAR','门店',FALSE,'dim_branch(system_book_code,branch_num)','调入门店号（JOIN 键，按店算拿货量/毛利）',9),
 ('delivery_detail','response_branch_name','VARCHAR','门店',FALSE,NULL,'调入门店名',10),
 ('delivery_detail','response_branch_region_name','VARCHAR','门店',FALSE,NULL,'调入门店战区',11),
 ('delivery_detail','storehouse_num','VARCHAR','仓库',FALSE,NULL,'仓库号',12),
 ('delivery_detail','storehouse_name','VARCHAR','仓库',FALSE,NULL,'仓名',13),
 ('delivery_detail','item_num','VARCHAR','商品',FALSE,'dim_item(system_book_code,item_num)','商品号（JOIN 键）',14),
 ('delivery_detail','pos_item_code','VARCHAR','商品',FALSE,'canonical_product(item_code)','商品业务码(跨品牌合并键)',15),
 ('delivery_detail','pos_item_name','VARCHAR','商品',FALSE,NULL,'商品名',16),
 ('delivery_detail','item_category','VARCHAR','商品',FALSE,NULL,'品类',17),
 ('delivery_detail','top_category_name','VARCHAR','商品',FALSE,NULL,'顶级品类(标品等)',18),
 ('delivery_detail','department','VARCHAR','商品',FALSE,NULL,'部门',19),
 ('delivery_detail','item_method','VARCHAR','商品',FALSE,NULL,'经营方式(购销等)',20),
 ('delivery_detail','spec','VARCHAR','商品',FALSE,NULL,'规格',21),
 ('delivery_detail','out_unit','VARCHAR','商品',FALSE,NULL,'调出单位',22),
 ('delivery_detail','lot_number','VARCHAR','批次',FALSE,NULL,'批次号',23),
 ('delivery_detail','out_amount','VARCHAR','数量',FALSE,NULL,'调出数量(拿货量，可负=退货)',24),
 ('delivery_detail','out_money','VARCHAR','金额',FALSE,NULL,'调出金额',25),
 ('delivery_detail','out_unit_price','VARCHAR','金额',FALSE,NULL,'调出单价',26),
 ('delivery_detail','cost_price','VARCHAR','成本',TRUE,NULL,'成本（无权限=NULL）',27),
 ('delivery_detail','cost_unit_price','VARCHAR','成本',TRUE,NULL,'成本单价（无权限=NULL）',28),
 ('delivery_detail','profit_money','VARCHAR','成本',TRUE,NULL,'毛利（无权限=NULL）',29),
 ('delivery_detail','no_tax_out_money','VARCHAR','金额',FALSE,NULL,'不含税调出额',30),
 ('delivery_detail','tax_money','VARCHAR','金额',FALSE,NULL,'税额',31),
 ('delivery_detail','base_amount','VARCHAR','数量',FALSE,NULL,'基本单位数量',32),
 ('delivery_detail','base_price','VARCHAR','金额',FALSE,NULL,'基本单价',33),
 ('delivery_detail','order_maker','VARCHAR','单据',FALSE,NULL,'制单人',34),
 ('delivery_detail','order_seller','VARCHAR','单据',FALSE,NULL,'销售员',35),
 ('delivery_detail','order_auditor','VARCHAR','单据',FALSE,NULL,'审核人',36)
ON CONFLICT (dataset_name, name) DO UPDATE SET data_type=EXCLUDED.data_type,
  semantic_group=EXCLUDED.semantic_group, is_sensitive=EXCLUDED.is_sensitive,
  join_to=EXCLUDED.join_to, description=EXCLUDED.description, ordinal=EXCLUDED.ordinal;

DO $$ BEGIN RAISE NOTICE 'Migration 049_transfer_detail_collect completed'; END $$;
```

- [ ] **Step 2: SQL 语法自检**（本地或部署时 migrate.sh 会跑，幂等保证重跑不报错）

- [ ] **Step 3: Commit**

```bash
git add database/migrations/049_transfer_detail_collect.sql
git commit -m "feat(delivery): 049 迁移-3120配送采集任务+监控+datasets注册"
```

---

## Task 4: 手动触发 route

**Files:** Create `web/app/api/admin/collect-delivery/route.ts`

照 `web/app/api/admin/collect-lemeng/route.ts`，调 `collectDeliveryOnce`，对账重试，写 collect_logs。

- [ ] **Step 1: 写 `web/app/api/admin/collect-delivery/route.ts`**

```ts
// web/app/api/admin/collect-delivery/route.ts
// 配送明细采集手动触发入口（照 collect-lemeng route）
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { collectDeliveryOnce, getTodayChina, getYesterdayChina, LEMENG_SECRET_KEY, type DeliveryCollectResult } from '@/lib/collect-delivery';
import { notifyWecom } from '@/lib/notify';
import { ensureSchedulerInitialized } from '@/lib/scheduler';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const MAX_VERIFY_RETRIES = 3;

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  try {
    if (!LEMENG_SECRET_KEY) return NextResponse.json({ success: false, error: 'LEMENG_SECRET_KEY not configured' }, { status: 500 });
    const { task_id } = await req.json();
    const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
    const { data: task } = await client.database.from('collect_tasks').select('id,name,source_id,params').eq('id', task_id).single();
    if (!task) return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });

    const { data: cred } = await client.database.from('auth_credentials').select('credential_data').eq('source_id', task.source_id).single();
    let credentials: Record<string, string> = {};
    if (cred?.credential_data) { try { credentials = JSON.parse(cred.credential_data); } catch {} }
    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) return NextResponse.json({ success: false, error: 'No token' }, { status: 400 });

    const params = task.params || {};
    const distributionBranch = Number(params.distribution_branch_num) || 99;
    const branchNumsStr = String(distributionBranch);
    const limit = params.page_size || 200;
    const today = getTodayChina();
    const dates = params.date_mode === 'today'
      ? { from: `${today} 00:00:00`, to: `${today} 23:59:59` }
      : { from: `${getYesterdayChina()} 00:00:00`, to: `${getYesterdayChina()} 23:59:59` };

    await ensureSchedulerInitialized();

    let lastResult: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
    let verified = false;
    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit);
      if (lastResult.error.startsWith('Token expired')) return NextResponse.json({ success: false, error: lastResult.error }, { status: 401 });
      if (lastResult.apiTotal === 0) {
        await client.database.from('collect_tasks').update({ last_run_at: new Date().toISOString() }).eq('id', task_id);
        return NextResponse.json({ success: true, rows_collected: 0, dates });
      }
      verified = lastResult.records.length >= lastResult.apiTotal;
      if (verified) break;
      if (attempt < MAX_VERIFY_RETRIES) await new Promise(r => setTimeout(r, 5000));
      else {
        await notifyWecom('❌ 手动配送采集不完整', `**任务**: ${task.name}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}`);
        lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次)`;
      }
    }
    const finishedAt = new Date();
    await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString() }).eq('id', task_id);
    const finalStatus = lastResult.error ? 'partial' : 'success';
    await client.database.from('collect_logs').insert([{
      task_id, status: finalStatus, started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(), rows_collected: lastResult.records.length,
      error_message: lastResult.error || null,
      response_summary: { storage_path: lastResult.storagePath, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } },
    }]);
    return NextResponse.json({
      success: verified && !lastResult.error, rows_collected: lastResult.records.length, dates,
      api_total: lastResult.apiTotal, verification: { verified, missing: lastResult.apiTotal - lastResult.records.length },
      storage_path: lastResult.storagePath || undefined, error: lastResult.error || undefined,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/app/api/admin/collect-delivery/route.ts
git commit -m "feat(delivery): 配送明细手动触发 route"
```

---

## Task 5: SKILL 路由 + 部署 + 验证

**Files:** Modify `openclaw/data-query-plugin/skills/retail-query/SKILL.md`

- [ ] **Step 1: SKILL.md 加 delivery_detail 路由段**

在 retail_detail 路由段之后，加配送明细路由（让问数能查"配送/拿货/毛利"）。示例片段（贴到对应数据集列表处）：

```markdown
- **delivery_detail（配送调出明细）**：乐檬配送中心→门店的调出明细。
  - 算「门店拿货量」：`SUM(CAST(out_amount AS DOUBLE))` 按 `response_branch_num` 聚合。
  - 算「配送毛利」：`SUM(CAST(profit_money AS DOUBLE))`；成本列(cost_price/cost_unit_price/profit_money) 无权限=NULL。
  - 按日过滤：`order_time LIKE 'YYYYMMDD%'`（列是 YYYY-MM-DD HH:MM:SS 字符串，取前 8 位比 YYYYMMDD）。
  - 调出方固定 distribution_branch_num=99（配送中心）。
```

- [ ] **Step 2: Commit**

```bash
git add openclaw/data-query-plugin/skills/retail-query/SKILL.md
git commit -m "feat(delivery): SKILL 加配送明细路由"
```

- [ ] **Step 3: 部署（改了 web/database → GHA）**

```bash
git push origin main
gh run watch <run-id>
```

GHA：rsync + 起后端 + migrate（跑 049）+ function（容错）+ 前端镜像。约 3-4 分钟。

- [ ] **Step 4: 验证 migrate 生效（datasets 注册 + 任务行）**

```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT name FROM datasets WHERE name='delivery_detail'; SELECT id,name,enabled FROM collect_tasks WHERE id='a0000000-0000-0000-0000-000000000010';\""
```
Expected: `delivery_detail` 在；3120 配送任务 enabled=true

- [ ] **Step 5: 手动触发采集 + 验证落盘 + 对账**

```bash
# 触发（用 3120 配送任务 id）
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/collect-delivery -H 'Content-Type: application/json' -d '{"task_id":"a0000000-0000-0000-0000-000000000010"}'
```
Expected: `success:true`，rows_collected > 0，verification.verified=true，storage_path 非空

- [ ] **Step 6: 验证 Parquet 落盘 + 数据可查（duckdb-service 直查）**

```bash
# 查 transfer_detail parquet 行数 + 抽样
curl -s -X POST https://data.shanhaiyiguo.com/api/admin/duckdb-query -H 'Content-Type: application/json' -d '{"query":"SELECT count(*) c, sum(CAST(out_amount AS DOUBLE)) qty, sum(CAST(profit_money AS DOUBLE)) profit FROM read_parquet('"'"'s3://lemeng-datasource/lemeng/transfer_detail/3120/'"'"'$(date +%Y%m%d -d today)'"'"'/all.parquet'"'"')"}'
```
（若无 duckdb-query route，改用 agent-query 问数出口验：「今天配送中心总调出金额、毛利」）
Expected: 行数 = 接口 count；qty/profit 数值合理

- [ ] **Step 7: 验证 collect_logs + 监控**

```bash
ssh ... "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT status, rows_collected, response_summary FROM collect_logs WHERE task_id='a0000000-0000-0000-0000-000000000010' ORDER BY started_at DESC LIMIT 3;\""
```
Expected: status=success，response_summary.verification.verified=true

---

## 完整性五点核对（CLAUDE.md 强制）

1. **按维度对账**：✅ fetched ≥ data.count（count 来自接口首页，按品牌 token）
2. **拉取完整性**：✅ offset 分页逐页，连续 3 页失败才停（consecutiveErrors），不在中间 break；fetched ≥ count 判 verified
3. **写入失败检测**：✅ /transform 失败计入 `result.error` → status=partial → 不推进水位线
4. **软删除**：✅ N/A——Parquet 按"天"覆盖写（同 retail_detail，明细数据天然无需软删；/transform full 模式每小时覆盖当天）
5. **失败→告警**：✅ verified=false → collect_logs partial/failed → monitor_rules collect_fail consecutive=3 → 企微告警

## YAGNI

- 不算汇总表（report_daily_delivery）——用户明确「先落明细，汇总后面再说」
- 不为 64188 配采集任务——用户明确「64188 共用 3120 的数据」
- delivery 不 triggerCompute（汇总后续再加）
- 不抽共享签名工具（collect-delivery.ts 自含签名，不动 collect.ts 避免影响在跑的 retail；后续可重构）

## Self-Review

- ✅ Spec 覆盖：endpoint/body/字段/分页/对账/调度/完整性五点/只3120/不算汇总，全部有 task
- ✅ 无占位符：collect-delivery.ts / scheduler 分支 / migration / route 均完整代码
- ✅ 类型一致：`collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dtFrom, dtTo, limit, options)` 定义与 route + scheduler 调用签名一致；`DeliveryCollectResult` 字段（records/apiTotal/storagePath/error/newApiTotal/skipped）与 collect.ts `CollectResult` 对齐
- ✅ 幂等：migration 全 ON CONFLICT；collect_tasks id 固定 UUID（...0010，不与现有冲突）
- ✅ 部署：改 web/database → GHA（符合 CLAUDE.md 部署决策表）

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-07-12-delivery-detail-collect.md`. Two execution options:

1. **Subagent-Driven（推荐）** — 每个 task 派一个 fresh subagent，task 间 review，迭代快
2. **Inline Execution** — 本 session 批量执行，checkpoint review

Which approach?
