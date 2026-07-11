// web/lib/collect.ts
// 乐檬采集核心逻辑，被 route.ts 和 scheduler.ts 共用

import crypto from 'crypto';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_RETAIL_DETAIL = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";
const ENDPOINT_RETAIL_COUNT = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.countposorderdetail";

const REQUEST_TIMEOUT = 30000;
const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || ''; // duckdb-service /transform /merge 鉴权
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

// 从 token 解出 company_id（品牌），用于按品牌分区存储。
// 品牌(company)写在 JWT 的 payload.company_id，由 token 决定（非请求参数）。
function decodeCompanyId(authToken: string): string {
  try {
    const raw = authToken.startsWith('Bearer ') ? authToken.slice(7) : authToken;
    const parts = raw.split('.');
    if (parts.length < 2) return 'unknown';
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return String(payload.company_id || 'unknown');
  } catch {
    return 'unknown';
  }
}

// ===== 签名算法 =====
function generateSignature(authToken: string, timestamp: string, nonce: string, branchNums: string, scopeIds: string, urlPath: string, bodyStr: string, secretKey: string): string {
  const signStr = authToken + timestamp + nonce + branchNums + scopeIds + secretKey + urlPath + bodyStr + secretKey;
  return crypto.createHash('sha256').update(signStr, 'utf8').digest('hex');
}

function buildHeaders(authToken: string, branchNumsStr: string, urlPath: string, bodyStr: string) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(authToken, timestamp, nonce, branchNumsStr, "", urlPath, bodyStr, LEMENG_SECRET_KEY);

  return {
    "Authorization": authToken,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": signature,
    "X-LoginBranchNum": "99",
    "x-branch-nums": branchNumsStr,
    "x-desensitization-columns": ""
  };
}

function buildBody(branchNums: number[], dates: string[], pageNumber: number, pageSize: number) {
  return JSON.stringify({
    branch_nums: branchNums,
    item_departments: [],
    query_item_matrix: true,
    dates: dates,
    order_sources: [],
    page_number: pageNumber,
    page_size: pageSize
  });
}

// 将嵌套结构扁平化
function flattenRecords(records: any[]): any[] {
  return records.map(r => ({
    order_no: r.order_no,
    order_detail_num: r.order_detail_num,
    order_time: r.order_time,
    order_sale_channel: r.order_sale_channel,
    order_sale_type: r.order_sale_type,
    order_payee: r.order_payee,
    order_sold_by: r.order_sold_by,
    order_detail_bizday: r.order_detail_bizday,
    branch_num: r.branch?.branch_num,
    branch_code: r.branch?.branch_code,
    branch_name: r.branch?.branch_name,
    item_num: r.pos_item?.item_num,
    item_code: r.pos_item?.item_code,
    item_name: r.pos_item?.pos_item_name || r.pos_item?.item_name,
    item_category: r.pos_item?.item_category,
    item_spec: r.pos_item?.item_spec,
    item_unit: r.pos_item?.item_unit,
    department: r.pos_item?.department,
    item_regular_price: r.pos_item?.item_regular_price,
    item_cost_price: r.pos_item?.item_cost_price,
    supplier_num: r.supplier?.supplier_num,
    supplier_name: r.supplier?.supplier_name,
    supplier_code: r.supplier?.supplier_code,
    state: r.state,
    management_style_type: r.management_style_type,
    order_detail_price: r.order_detail_price,
    order_detail_cost: r.order_detail_cost,
    order_detail_grade_cost: r.order_detail_grade_cost,
    sale_money: r.sale_money,
    discount_money: r.discount_money,
    cost: r.cost,
    profit: r.profit,
    sale_profit_rate: r.sale_profit_rate,
    discount_rate: r.discount_rate,
    overall_discount_rate: r.overall_discount_rate,
    payment_receipt_money: r.payment_receipt_money,
    order_detail_discount: r.order_detail_discount,
    order_detail_share_discount: r.order_detail_share_discount,
    order_detail_payment_money: r.order_detail_payment_money,
    tax_money: r.tax_money,
    item_tax_rate: r.item_tax_rate,
    total_no_tax_money: r.total_no_tax_money,
    total_amount: r.total_amount,
    coupon_sale_share_money: r.coupon_sale_share_money,
    order_detail_item_serial_number: r.order_detail_item_serial_number,
    item_extend1: r.pos_item_matrix?.item_extend1,
  }));
}

// ===== HTTP 工具 =====
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function callLemengApi(urlPath: string, authToken: string, bodyStr: string, branchNumsStr: string, maxRetries = 2): Promise<{ ok: boolean; data?: any; status?: number; error?: string }> {
  const fullUrl = BASE_URL + urlPath;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = buildHeaders(authToken, branchNumsStr, urlPath, bodyStr);

    try {
      const response = await fetchWithTimeout(fullUrl, {
        method: 'POST',
        headers: headers,
        body: bodyStr
      }, REQUEST_TIMEOUT);

      if (response.status === 200) {
        const data = await response.json();
        if (data.code === -1 && attempt < maxRetries - 1) {
          console.log(`[collect] Attempt ${attempt + 1}: code=-1, retrying after 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { ok: true, data };
      }

      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: any) {
      if (attempt < maxRetries - 1) {
        console.log(`[collect] Attempt ${attempt + 1} error: ${err.message}, retrying after 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

// 使用中国时区获取昨天的日期
export function getYesterdayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  chinaTime.setDate(chinaTime.getDate() - 1);
  return chinaTime.toISOString().split('T')[0];
}

// 使用中国时区获取今天的日期（零售明细当天增量采集用）
export function getTodayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().split('T')[0];
}

// ===== 单次采集 + 转换 =====
export interface CollectResult {
  records: any[];
  apiTotal: number;
  storagePath: string;
  error: string;
  newApiTotal: number; // 当次 API 总数（供 scheduler 更新水位线；incremental 无新增时 = watermarkLastCount）
  skipped: boolean;    // incremental 模式且无新增数据
}

export interface CollectOptions {
  mode?: 'full' | 'incremental';
  watermarkLastCount?: number; // 上次成功采集后的总数（水位线），仅 incremental 用
}

export async function collectOnce(
  authToken: string,
  branchNums: number[],
  branchNumsStr: string,
  dates: string[],
  pageSize: number = 200,
  options?: CollectOptions,
): Promise<CollectResult> {
  const mode = options?.mode || 'full';
  const watermarkLastCount = options?.watermarkLastCount ?? 0;
  const result: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
  const companyId = decodeCompanyId(authToken);

  // ===== 预热：激活 Token 会话 =====
  const warmBody = buildBody(branchNums, dates, 1, 5);
  const warmResult = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, warmBody, branchNumsStr);

  if (warmResult.ok && warmResult.data?.code === 0) {
    console.log(`[collect] Warm-up success`);
  } else if (warmResult.ok && warmResult.data?.code === -1) {
    result.error = `Token expired: ${warmResult.data?.message}`;
    return result;
  } else {
    console.warn(`[collect] Warm-up HTTP ${warmResult.status}: ${warmResult.error}, continuing...`);
  }

  // ===== 查询总数 =====
  const countBody = buildBody(branchNums, dates, 1, pageSize);
  const countResult = await callLemengApi(ENDPOINT_RETAIL_COUNT, authToken, countBody, branchNumsStr);

  if (countResult.ok && countResult.data?.code === 0) {
    result.apiTotal = countResult.data.result || 0;
    console.log(`[collect] Total count: ${result.apiTotal}`);
  } else {
    console.warn(`[collect] Count query failed, will paginate without limit`);
    result.apiTotal = 10000;
  }
  result.newApiTotal = result.apiTotal;

  if (result.apiTotal === 0) {
    return result;
  }

  // ===== 分页拉取 =====
  const totalPages = Math.ceil(result.apiTotal / pageSize);
  const maxPages = 500; // 兜底防爆（500*pageSize 足够覆盖任何一天的全量）
  let page = 1;
  // 增量模式：总数未超水位线 → 无新增跳过；否则从水位线页（重叠 1 页兜底边界）续采尾部
  if (mode === 'incremental') {
    if (result.apiTotal <= watermarkLastCount) {
      console.log(`[collect] Incremental: apiTotal ${result.apiTotal} <= watermark ${watermarkLastCount}, no new data, skip`);
      result.skipped = true;
      return result;
    }
    page = Math.max(1, Math.floor(watermarkLastCount / pageSize));
    console.log(`[collect] Incremental: resume from page ${page} (watermark ${watermarkLastCount}, total ${result.apiTotal})`);
  }
  let consecutiveErrors = 0;

  while (page <= totalPages && page <= maxPages) {
    const bodyStr = buildBody(branchNums, dates, page, pageSize);
    const pageResult = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, bodyStr, branchNumsStr);

    if (!pageResult.ok) {
      console.error(`[collect] Page ${page} HTTP error: ${pageResult.error}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        result.error = `Consecutive 3 pages failed, stopped at page ${page}`;
        break;
      }
      page++;
      continue;
    }

    if (pageResult.data.code !== 0) {
      console.error(`[collect] Page ${page} API error: ${pageResult.data.message}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        result.error = `Consecutive 3 API errors, stopped at page ${page}`;
        break;
      }
      page++;
      continue;
    }

    consecutiveErrors = 0;
    const records = pageResult.data.result || [];
    result.records.push(...records);
    console.log(`[collect] Page ${page}/${totalPages}: ${records.length} rows, total ${result.records.length}`);

    if (records.length < pageSize) break;
    page++;
  }

  // ===== 写入 Parquet：full 用 /transform 覆盖；incremental 用 /merge 合并 =====
  if (result.records.length > 0) {
    try {
      const flatRecords = flattenRecords(result.records);
      const dateStr = dates[0];
      const isIncremental = mode === 'incremental';
      const endpoint = isIncremental ? '/merge' : '/transform';
      const action = isIncremental ? 'merge' : 'transform';

      console.log(`[collect] Calling DuckDB ${action}: ${flatRecords.length} records`);

      const duckRes = await fetch(`${DUCKDB_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
        body: JSON.stringify({
          records: flatRecords,
          config: {
            date: dateStr,
            source: 'lemeng',
            partition_by: ['branch_num'],
            dedupe_key: ['order_no', 'order_detail_num'],
            required_fields: ['order_no', 'item_code', 'branch_num'],
            output_format: 'parquet',
            compression: 'zstd',
            base_path: `lemeng/retail_detail/${companyId}/${dateStr}`
          }
        })
      });

      if (!duckRes.ok) {
        const errText = await duckRes.text();
        throw new Error(`DuckDB ${action} failed: ${duckRes.status} ${errText}`);
      }

      const duckResult = await duckRes.json();
      if (!duckResult.success) {
        throw new Error(duckResult.error || `${action} failed`);
      }

      result.storagePath = duckResult.combined_file;
      console.log(`[collect] Parquet ${action} success: ${result.storagePath}`);

      if (duckResult.invalid_records > 0 || duckResult.duplicates_removed > 0) {
        console.warn(`[collect] Data quality: ${duckResult.invalid_records} invalid, ${duckResult.duplicates_removed} duplicates`);
      }
    } catch (duckErr: any) {
      console.error(`[collect] DuckDB ${mode === 'incremental' ? 'merge' : 'transform'} failed: ${duckErr.message}`);
      result.error += (result.error ? '; ' : '') + `${mode === 'incremental' ? 'Merge' : 'Transform'} failed: ${duckErr.message}`;
    }
  }

  return result;
}

// 导出常量供 scheduler 使用
export { LEMENG_SECRET_KEY };