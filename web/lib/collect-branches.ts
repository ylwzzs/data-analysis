// web/lib/collect-branches.ts
// 乐檬门店档案采集 → dim_branch（同 collect-items 模式 + CLAUDE.md 完整性五条）
// API: POST user-center-v2/nhsoft.user.branch.page，body {page,size,company_id,page_type,search_keyword}
// 响应 result.content + result.total_elements。branch_num = API system_id（= 明细 branch_num，JOIN 键）。
import crypto from 'crypto';

interface Branch { [k: string]: any }

interface DimBranchRow {
  system_book_code: string;
  branch_num: string;
  branch_id: string | null;
  branch_code: string | null;
  branch_name: string | null;
  region_name: string | null;
  branch_groups: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  phone: string | null;
  longitude: string | null;
  latitude: string | null;
  enable: boolean | null;
  deleted: boolean | null;
  expire_time: string | null;
  is_active: boolean;
  raw: object;
}

// API 原始 → dim_branch 行（region 取 branch_region.name；system_id 为空的特殊店跳过）
function mapToDimBranch(b: Branch): DimBranchRow | null {
  const system_book_code = String(b.company_id ?? '');
  const branch_num = b.system_id != null ? String(b.system_id) : '';
  if (!system_book_code || !branch_num) return null;
  const s = (v: any) => (v == null ? null : String(v));
  return {
    system_book_code,
    branch_num,
    branch_id: s(b.id),
    branch_code: s(b.code),
    branch_name: s(b.name),
    region_name: s((b.branch_region || {}).name),
    branch_groups: s(b.branch_groups),
    province: s(b.province),
    city: s(b.city),
    district: s(b.district),
    address: s(b.address),
    phone: s(b.phone),
    longitude: s(b.longitude),
    latitude: s(b.latitude),
    enable: b.enable ?? null,
    deleted: b.deleted ?? null,
    expire_time: s(b.expire_time),
    is_active: true,
    raw: b,
  };
}

interface BranchApiResponse {
  code: number;
  message?: string;
  result?: { total_elements: number; content: Branch[] };
}

const BASE_URL = 'https://sharef.lemengcloud.com';
const ENDPOINT_BRANCH = '/earth-gateway/user-center-v2/nhsoft.user.branch.page';
const REQUEST_TIMEOUT = 30000;
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_ANON_KEY = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '';

function generateSignature(authToken: string, timestamp: string, nonce: string, branchNums: string, scopeIds: string, urlPath: string, bodyStr: string, secretKey: string): string {
  return crypto.createHash('sha256').update(authToken + timestamp + nonce + branchNums + scopeIds + secretKey + urlPath + bodyStr + secretKey, 'utf8').digest('hex');
}

function buildHeaders(authToken: string, branchNumsStr: string, urlPath: string, bodyStr: string) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(authToken, timestamp, nonce, branchNumsStr, '', urlPath, bodyStr, LEMENG_SECRET_KEY);
  return {
    Authorization: authToken,
    'Content-Type': 'application/json',
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    'X-LoginBranchNum': '99',
    'x-branch-nums': branchNumsStr,
    'x-desensitization-columns': '',
  };
}

function buildBody(companyId: number, page: number, size: number): string {
  return JSON.stringify({ page, size, company_id: companyId, page_type: 'branch.page', search_keyword: '' });
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err: unknown) {
    clearTimeout(timeout);
    if ((err instanceof Error ? err.name : 'Unknown') === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function callBranchApi(authToken: string, bodyStr: string, maxRetries = 2): Promise<{ ok: boolean; data?: BranchApiResponse; status?: number; error?: string }> {
  const fullUrl = BASE_URL + ENDPOINT_BRANCH;
  const branchNumsStr = '1';
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = buildHeaders(authToken, branchNumsStr, ENDPOINT_BRANCH, bodyStr);
    try {
      const response = await fetchWithTimeout(fullUrl, { method: 'POST', headers, body: bodyStr }, REQUEST_TIMEOUT);
      if (response.status === 200) {
        const data = await response.json();
        if (data.code === -1 && attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { ok: true, data };
      }
      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: unknown) {
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, error: (err instanceof Error ? err.message : String(err)) };
    }
  }
  return { ok: false, error: 'Max retries exceeded' };
}

async function upsertToPostgREST(records: Branch[]): Promise<{ success: boolean; upserted?: number; error?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Prefer': 'resolution=merge-duplicates' };
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }
  const rows = records.map(mapToDimBranch).filter((r): r is DimBranchRow => r !== null);
  if (rows.length === 0) return { success: true, upserted: 0 };
  try {
    const response = await fetchWithTimeout(`${POSTGREST_URL}/dim_branch`, { method: 'POST', headers, body: JSON.stringify(rows) }, 30000);
    if (response.status === 201 || response.status === 200) return { success: true, upserted: rows.length };
    const errorText = await response.text();
    console.error(`[collect-branches] upsert ${response.status}: ${errorText.slice(0, 300)}`);
    return { success: false, error: `PostgREST ${response.status}: ${errorText.slice(0, 200)}` };
  } catch (err: unknown) {
    return { success: false, error: (err instanceof Error ? err.message : String(err)) };
  }
}

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
      `${POSTGREST_URL}/dim_branch?select=branch_num&system_book_code=eq.${encodeURIComponent(systemBookCode)}&is_active=eq.true`,
      { method: 'GET', headers }, 15000
    );
    const contentRange = response.headers.get('content-range');
    if (contentRange) return parseInt(contentRange.split('/')[1], 10) || 0;
    return 0;
  } catch { return 0; }
}

async function markBrandInactive(systemBookCode: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (INSFORGE_ANON_KEY && INSFORGE_ANON_KEY.length > 20) {
    headers['Authorization'] = `Bearer ${INSFORGE_ANON_KEY}`;
    headers['apikey'] = INSFORGE_ANON_KEY;
  }
  try {
    const response = await fetchWithTimeout(
      `${POSTGREST_URL}/dim_branch?system_book_code=eq.${encodeURIComponent(systemBookCode)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ is_active: false }) }, 30000
    );
    return response.status === 200 || response.status === 204;
  } catch { return false; }
}

export interface CollectBranchesResult {
  total: number;
  collected: number;
  dbCount: number;
  verified: boolean;
  error: string;
}

export async function collectBranches(authToken: string, companyId: number, pageSize: number = 200): Promise<CollectBranchesResult> {
  const result: CollectBranchesResult = { total: 0, collected: 0, dbCount: 0, verified: false, error: '' };
  const brand = String(companyId);

  // 预热（兼查 token）
  const warmResult = await callBranchApi(authToken, buildBody(companyId, 1, 5));
  if (warmResult.ok && warmResult.data?.code === -1) {
    result.error = `Token expired: ${warmResult.data?.message}`;
    return result;
  }

  // 第1页拿总数
  const firstResult = await callBranchApi(authToken, buildBody(companyId, 1, pageSize));
  if (!firstResult.ok || firstResult.data?.code !== 0) {
    result.error = firstResult.error || firstResult.data?.message || 'First page failed';
    return result;
  }
  const total = firstResult.data.result?.total_elements || 0;
  result.total = total;
  if (total === 0) return result;

  const allRecords: Branch[] = [];
  allRecords.push(...(firstResult.data.result?.content || []));
  console.log(`[collect-branches] Page 1: ${allRecords.length}, total ${total}`);

  const totalPages = Math.ceil(total / pageSize);
  let failedPages = 0;
  for (let page = 2; page <= totalPages; page++) {
    const pageResult = await callBranchApi(authToken, buildBody(companyId, page, pageSize));
    if (!pageResult.ok || pageResult.data?.code !== 0) {
      failedPages++;
      console.error(`[collect-branches] Page ${page}/${totalPages} failed: ${pageResult.error || pageResult.data?.message}`);
      continue;
    }
    allRecords.push(...(pageResult.data.result?.content || []));
  }
  console.log(`[collect-branches] Fetched ${allRecords.length}/${total}`);

  // 去重（system_id 品牌内唯一）
  const seen = new Set<string>();
  const deduped: Branch[] = [];
  for (const b of allRecords) {
    if (b.system_id == null) continue;
    const k = String(b.system_id);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(b);
  }

  const fetchComplete = failedPages === 0 && allRecords.length >= total;
  if (!fetchComplete) console.warn(`[collect-branches] ⚠️ 拉取不完整 fetched ${allRecords.length}/${total} failedPages=${failedPages}`);

  // 软删除前置（仅完整拉取）
  if (fetchComplete) {
    const marked = await markBrandInactive(brand);
    console.log(`[collect-branches] pre-mark ${brand} inactive: ${marked ? 'ok' : 'failed'}`);
  }

  // 写入（mapToDimBranch 带 is_active=true）
  let upsertFailures = 0;
  if (deduped.length > 0) {
    const batchSize = 100;
    let successCount = 0;
    for (let i = 0; i < deduped.length; i += batchSize) {
      const batch = deduped.slice(i, i + batchSize);
      const { success, error } = await upsertToPostgREST(batch);
      if (!success) { upsertFailures += batch.length; console.error(`[collect-branches] Batch ${i} failed: ${error}`); }
      else successCount += batch.length;
    }
    result.collected = successCount;
    console.log(`[collect-branches] Upserted ${successCount}, failed ${upsertFailures}`);
  }

  // 完整校验：fetchComplete && 无 upsert 失败 && 该品牌 active 数 >= total
  const activeCount = await getActiveCount(brand);
  result.dbCount = activeCount;
  result.verified = fetchComplete && upsertFailures === 0 && activeCount >= total;
  if (!result.verified && !result.error) {
    result.error = `校验未通过: ${brand} active ${activeCount}/${total} (fetchComplete=${fetchComplete}, upsertFailures=${upsertFailures})`;
  }
  console.log(`[collect-branches] ${result.verified ? '✅' : '⚠️'} ${brand} active ${activeCount}/${total}`);
  return result;
}
