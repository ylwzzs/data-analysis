// web/lib/collect-items.ts
// 乐檬商品档案采集逻辑 - 直接使用 fetch 调用 PostgREST

import crypto from 'crypto';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_ITEM_LIST = "/earth-gateway/amazon-base/nhsoft.base.business.item.page.new";

const REQUEST_TIMEOUT = 30000;
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

// PostgREST 直接访问配置
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
// 优先使用 INSFORGE_API_KEY（已在 docker-compose.prod.yml 中配置）
// 兼容 NEXT_PUBLIC_INSFORGE_ANON_KEY（前端用）
const INSFORGE_ANON_KEY = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

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

function buildBody(branchId: number, page: number, pageSize: number): string {
  return JSON.stringify({
    branch_id: branchId,
    category_range_codes: [],
    scene_filter_flag: false,
    query_combine_relation: false,
    department_name_list: [],
    keyword: "",
    center_branch_flag: true,
    price_type: "标准售价",
    item_status_list: ["ELIMINATE_FALSE"],
    page: page,
    size: pageSize,
    orders: [],
    item_departments: []
  });
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
          console.log(`[collect-items] Attempt ${attempt + 1}: code=-1, retrying after 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { ok: true, data };
      }

      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: any) {
      if (attempt < maxRetries - 1) {
        console.log(`[collect-items] Attempt ${attempt + 1} error: ${err.message}, retrying after 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

// ===== 直接调用 PostgREST 的 upsert =====
async function upsertToPostgREST(records: any[]): Promise<{ success: boolean; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Prefer': 'resolution=merge-duplicates'
  };

  // 仅在有有效 JWT 时添加 auth header（RLS 未启用时也可无 auth 访问）
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }

  const url = `${POSTGREST_URL}/lemeng_items`;
  const authMode = INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20 ? 'with-auth' : 'no-auth';
  console.log(`[collect-items] POST ${url} with ${records.length} records (${authMode})`);

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(records)
    }, 30000);

    console.log(`[collect-items] Response status: ${response.status}`);

    if (response.status === 201 || response.status === 200) {
      return { success: true };
    }

    const errorText = await response.text();
    console.error(`[collect-items] Error response (${response.status}): ${errorText.slice(0, 500)}`);
    return { success: false, error: `PostgREST ${response.status}: ${errorText.slice(0, 200)}` };
  } catch (err: any) {
    console.error(`[collect-items] Fetch error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ===== 商品档案采集 =====
export interface CollectItemsResult {
  total: number;
  collected: number;
  error: string;
}

export async function collectItems(
  authToken: string,
  branchId: number = 28444,
  pageSize: number = 200
): Promise<CollectItemsResult> {
  const result: CollectItemsResult = { total: 0, collected: 0, error: '' };
  const branchNumsStr = "99";

  // ===== 预热：激活 Token 会话 =====
  const warmBody = buildBody(branchId, 1, 5);
  const warmResult = await callLemengApi(ENDPOINT_ITEM_LIST, authToken, warmBody, branchNumsStr);

  if (warmResult.ok && warmResult.data?.code === 0) {
    console.log(`[collect-items] Warm-up success`);
  } else if (warmResult.ok && warmResult.data?.code === -1) {
    result.error = `Token expired: ${warmResult.data?.message}`;
    return result;
  } else {
    console.warn(`[collect-items] Warm-up HTTP ${warmResult.status}: ${warmResult.error}, continuing...`);
  }

  // ===== 查询第1页获取总数 =====
  const firstPageBody = buildBody(branchId, 1, pageSize);
  const firstPageResult = await callLemengApi(ENDPOINT_ITEM_LIST, authToken, firstPageBody, branchNumsStr);

  if (!firstPageResult.ok || firstPageResult.data?.code !== 0) {
    result.error = firstPageResult.error || firstPageResult.data?.message || 'First page failed';
    return result;
  }

  const total = firstPageResult.data.result?.total_elements || 0;
  result.total = total;
  console.log(`[collect-items] Total items: ${total}`);

  if (total === 0) {
    return result;
  }

  // ===== 收集所有记录 =====
  const allRecords: any[] = [];
  const firstRecords = firstPageResult.data.result?.content || [];
  allRecords.push(...firstRecords);
  console.log(`[collect-items] Page 1: ${firstRecords.length} items`);

  // ===== 分页拉取 =====
  const totalPages = Math.ceil(total / pageSize);
  const maxPages = Math.ceil(total / pageSize); // 采集全部，不限制页数

  for (let page = 2; page <= totalPages && page <= maxPages; page++) {
    const bodyStr = buildBody(branchId, page, pageSize);
    const pageResult = await callLemengApi(ENDPOINT_ITEM_LIST, authToken, bodyStr, branchNumsStr);

    if (!pageResult.ok || pageResult.data?.code !== 0) {
      console.error(`[collect-items] Page ${page} failed: ${pageResult.error || pageResult.data?.message}`);
      continue;
    }

    const records = pageResult.data.result?.content || [];
    allRecords.push(...records);
    console.log(`[collect-items] Page ${page}/${totalPages}: ${records.length} items, total ${allRecords.length}`);

    if (records.length < pageSize) break;
  }

  // ===== 写入 PostgreSQL（直接调用 PostgREST） =====
  if (allRecords.length > 0) {
    const batchSize = 100;
    let successCount = 0;

    for (let i = 0; i < allRecords.length; i += batchSize) {
      const batch = allRecords.slice(i, i + batchSize);
      const upsertRecords = batch.map(item => ({
        item_num: item.item_num,
        item_code: item.item_code,
        item_name: item.item_name,
        item_category: item.item_category,
        item_spec: item.item_spec,
        item_unit: item.item_unit,
        department: item.department,
        item_regular_price: item.item_regular_price,
        item_cost_price: item.item_cost_price,
        item_status: item.item_status,
        branch_id: item.branch_id || branchId,
      }));

      const { success, error } = await upsertToPostgREST(upsertRecords);

      if (!success) {
        console.error(`[collect-items] Batch ${i}-${i + batchSize} upsert failed: ${error}`);
      } else {
        successCount += batch.length;
      }
    }

    result.collected = successCount;
    console.log(`[collect-items] Upserted ${successCount} items to PostgreSQL`);
  }

  return result;
}