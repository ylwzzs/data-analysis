// web/lib/collect-items.ts
// 乐檬商品档案采集逻辑 - 直接使用 fetch 调用 PostgREST
// 包含：去重、完整校验、分页全量采集

import crypto from 'crypto';

// ===== 类型定义 =====
// API 原始记录（按需取字段，其余进 raw JSONB）
interface LemengItem { [k: string]: any }

// dim_item 列（base 列 + raw；绝不写 ext 列）
interface DimItemRow {
  system_book_code: string;
  item_num: string;
  item_code: string | null;
  bar_code: string | null;
  item_name: string | null;
  category_code: string | null;
  category_name: string | null;
  category_path: string | null;
  top_category: string | null;
  item_brand: string | null;
  department: string | null;
  item_unit: string | null;
  item_regular_price: string | null;
  item_cost_price: string | null;
  supplier_name: string | null;
  item_tags: string | null;
  is_active: boolean;
  raw: object;
}

// 乐檬 API 原始对象 → dim_item 行（类别/部门从嵌套对象取，结构化）
function mapToDimItem(it: LemengItem): DimItemRow | null {
  const system_book_code = String(it.system_book_code ?? '');
  const item_num = String(it.item_num ?? '');
  if (!system_book_code || !item_num) return null;  // 缺主键跳过
  const cat = it.item_category || {};
  const dept = it.item_department || {};
  const str = (v: any) => (v == null ? null : String(v));
  return {
    system_book_code,
    item_num,
    item_code: str(it.item_code),
    bar_code: str(it.bar_code ?? it.item_barcode),
    item_name: str(it.item_name),
    category_code: str(cat.category_code),
    category_name: str(cat.category_name),
    category_path: str(it.full_category_path),
    top_category: str(it.top_category),
    item_brand: str(it.item_brand),
    department: str(dept.item_department_name ?? it.department),
    item_unit: str(it.item_unit ?? it.unit_name),
    item_regular_price: str(it.item_regular_price),
    item_cost_price: str(it.item_cost_price),
    supplier_name: str(it.item_first_supplier),
    item_tags: str(it.item_tag_strs),
    is_active: true,
    raw: it,
  };
}

interface LemengApiResponse {
  code: number;
  message?: string;
  result?: {
    total_elements: number;
    content: LemengItem[];
  };
}

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
  } catch (err: unknown) {
    clearTimeout(timeout);
    if ((err instanceof Error ? err.name : "Unknown") === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function callLemengApi(urlPath: string, authToken: string, bodyStr: string, branchNumsStr: string, maxRetries = 2): Promise<{ ok: boolean; data?: LemengApiResponse; status?: number; error?: string }> {
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
    } catch (err: unknown) {
      if (attempt < maxRetries - 1) {
        console.log(`[collect-items] Attempt ${attempt + 1} error: ${(err instanceof Error ? err.message : String(err))}, retrying after 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

// ===== 直接调用 PostgREST 的 upsert（写 dim_item）=====
async function upsertToPostgREST(records: LemengItem[]): Promise<{ success: boolean; upserted?: number; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Prefer': 'resolution=merge-duplicates'   // 冲突在 PK (system_book_code, item_num) 上 merge
  };

  // 仅在有有效 JWT 时添加 auth header（RLS 未启用时也可无 auth 访问）
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }

  const rows = records.map(mapToDimItem).filter((r): r is DimItemRow => r !== null);
  if (rows.length === 0) return { success: true, upserted: 0 };
  const url = `${POSTGREST_URL}/dim_item`;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rows)
    }, 30000);

    if (response.status === 201 || response.status === 200) {
      return { success: true, upserted: rows.length };
    }

    const errorText = await response.text();
    console.error(`[collect-items] Error response (${response.status}): ${errorText.slice(0, 500)}`);
    return { success: false, error: `PostgREST ${response.status}: ${errorText.slice(0, 200)}` };
  } catch (err: unknown) {
    console.error(`[collect-items] Fetch error:`, (err instanceof Error ? err.message : String(err)));
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

// ===== 查询某品牌 active 商品数（完整性校验：按品牌而非全表，避免双品牌互相掩盖）=====
async function getActiveCount(systemBookCode: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }
  try {
    headers['Prefer'] = 'count=exact';
    headers['Range'] = '0-0';
    const response = await fetchWithTimeout(
      `${POSTGREST_URL}/dim_item?select=item_num&system_book_code=eq.${encodeURIComponent(systemBookCode)}&is_active=eq.true`,
      { method: 'GET', headers },
      15000
    );
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
      const total = contentRange.split('/')[1];
      return parseInt(total, 10) || 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

// ===== 软删除前置：把该品牌所有商品先标 inactive；随后 upsert 会把本次见到的标回 active =====
// 仅在全量拉取成功（fetchComplete）时调用——partial run 不应误把没采到的当陈旧。
async function markBrandInactive(systemBookCode: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }
  try {
    const response = await fetchWithTimeout(
      `${POSTGREST_URL}/dim_item?system_book_code=eq.${encodeURIComponent(systemBookCode)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }) },
      30000
    );
    return response.status === 200 || response.status === 204;
  } catch {
    return false;
  }
}

// ===== 商品档案采集 =====
export interface CollectItemsResult {
  total: number;          // API 返回的总数
  collected: number;      // 成功 upsert 的记录数
  deduped: number;        // 去重移除的记录数
  dbCount: number;        // 写入后数据库中的总记录数
  verified: boolean;      // 完整校验是否通过
  error: string;
}

export async function collectItems(
  authToken: string,
  branchId: number = 28444,
  pageSize: number = 200
): Promise<CollectItemsResult> {
  const result: CollectItemsResult = { total: 0, collected: 0, deduped: 0, dbCount: 0, verified: false, error: '' };
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
  console.log(`[collect-items] API total: ${total}`);

  if (total === 0) {
    return result;
  }

  // ===== 收集所有记录（全量分页） =====
  const allRecords: LemengItem[] = [];
  const firstRecords = firstPageResult.data.result?.content || [];
  allRecords.push(...firstRecords);
  console.log(`[collect-items] Page 1: ${firstRecords.length} items`);

  const totalPages = Math.ceil(total / pageSize);
  let failedPages = 0;

  for (let page = 2; page <= totalPages; page++) {
    const bodyStr = buildBody(branchId, page, pageSize);
    const pageResult = await callLemengApi(ENDPOINT_ITEM_LIST, authToken, bodyStr, branchNumsStr);

    if (!pageResult.ok || pageResult.data?.code !== 0) {
      failedPages++;
      console.error(`[collect-items] Page ${page}/${totalPages} failed: ${pageResult.error || pageResult.data?.message}`);
      continue;
    }

    const records = pageResult.data.result?.content || [];
    allRecords.push(...records);
    console.log(`[collect-items] Page ${page}/${totalPages}: ${records.length} items, accumulated ${allRecords.length}`);
    // 按 totalPages 固定拉取到底，不在中间页提前 break（避免单页返回不满丢尾部）
  }

  console.log(`[collect-items] Fetched ${allRecords.length}/${total} items from API`);

  // ===== 去重（以 item_num 为主键） =====
  const seen = new Set<string>();
  const dedupedRecords: LemengItem[] = [];
  let dupCount = 0;

  for (const item of allRecords) {
    const key = item.item_num;
    if (!key) continue;
    if (seen.has(key)) {
      dupCount++;
      continue;
    }
    seen.add(key);
    dedupedRecords.push(item);
  }

  result.deduped = dupCount;
  if (dupCount > 0) {
    console.log(`[collect-items] Deduped: removed ${dupCount} duplicates, ${dedupedRecords.length} unique items`);
  }

  // ===== 品牌 & 拉取完整性判定 =====
  const brand = String(dedupedRecords[0]?.system_book_code ?? firstRecords[0]?.system_book_code ?? '');
  const fetchedCount = allRecords.length;
  const fetchComplete = failedPages === 0 && fetchedCount >= total;
  if (!fetchComplete) {
    console.warn(`[collect-items] ⚠️ 拉取不完整: fetched ${fetchedCount}/${total}, failedPages=${failedPages}（本次不做软删除标 inactive）`);
  }

  // ===== 软删除前置（仅完整拉取）：该品牌全部先标 inactive，upsert 会把本次见到的标回 active =====
  if (fetchComplete && brand) {
    const marked = await markBrandInactive(brand);
    console.log(`[collect-items] pre-mark ${brand} inactive: ${marked ? 'ok' : 'failed'}`);
  }

  // ===== 写入 PostgreSQL（批量 upsert；mapToDimItem 带 is_active=true）=====
  let upsertFailures = 0;
  if (dedupedRecords.length > 0) {
    const batchSize = 100;
    let successCount = 0;

    for (let i = 0; i < dedupedRecords.length; i += batchSize) {
      const batch = dedupedRecords.slice(i, i + batchSize);
      const { success, error } = await upsertToPostgREST(batch);

      if (!success) {
        upsertFailures += batch.length;
        console.error(`[collect-items] Batch ${i}-${i + batchSize} upsert failed: ${error}`);
      } else {
        successCount += batch.length;
      }
    }

    result.collected = successCount;
    console.log(`[collect-items] Upserted ${successCount} items, failed ${upsertFailures}`);
  }

  // ===== 完整校验：拉取完整 + 无 upsert 失败 + 该品牌 active 数 >= API total =====
  // 三者皆满足才算 verified（任一失败→verified=false→collect-lemeng 记 failed→collect_fail 告警）
  const activeCount = brand ? await getActiveCount(brand) : 0;
  result.dbCount = activeCount;
  result.verified = fetchComplete && upsertFailures === 0 && activeCount >= total;

  if (result.verified) {
    console.log(`[collect-items] ✅ 校验通过: ${brand} active ${activeCount} >= API ${total}`);
  } else {
    console.warn(`[collect-items] ⚠️ 校验未通过: ${brand} active ${activeCount}/${total} (fetchComplete=${fetchComplete}, upsertFailures=${upsertFailures})`);
    if (!result.error) {
      result.error = `校验未通过: ${brand} active ${activeCount}/${total} (fetchComplete=${fetchComplete}, upsertFailures=${upsertFailures})`;
    }
  }

  return result;
}
