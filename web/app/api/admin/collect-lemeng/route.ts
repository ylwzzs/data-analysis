// web/app/api/admin/collect-lemeng/route.ts
// 采集乐檬数据，调用 DuckDB 服务转换为 Parquet
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import crypto from 'crypto';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

// DuckDB 服务地址（内网）
const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_RETAIL_DETAIL = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";
const ENDPOINT_RETAIL_COUNT = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.countposorderdetail";

// 请求超时（毫秒）
const REQUEST_TIMEOUT = 30000;

const ALL_BRANCH_NUMS = [
  1,2,3,4,5,6,7,10,11,12,13,14,15,17,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,34,35,36,37,40,42,43,44,46,47,48,49,50,51,52,53,54,57,58,60,61,62,63,64,65,66,67,68,70,72,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,888
];

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

// 将嵌套结构扁平化（DuckDB 需要平铺字段）
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
          console.log(`[collect-lemeng] Attempt ${attempt + 1}: code=-1, retrying after 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        return { ok: true, data };
      }

      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: any) {
      if (attempt < maxRetries - 1) {
        console.log(`[collect-lemeng] Attempt ${attempt + 1} error: ${err.message}, retrying after 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

// 使用中国时区获取昨天的日期
function getYesterdayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  chinaTime.setDate(chinaTime.getDate() - 1);
  return chinaTime.toISOString().split('T')[0];
}

// 写入采集日志
async function writeLog(client: any, taskId: string, startedAt: Date, finishedAt: Date, status: string, rowsCollected: number, errorMessage?: string, storagePath?: string, verification?: { api_total: number; missing: number; verified: boolean }) {
  await client.database
    .from('collect_logs')
    .insert([{
      task_id: taskId,
      status: status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rows_collected: rowsCollected,
      error_message: errorMessage || null,
      response_summary: storagePath ? {
        storage_path: storagePath,
        verification: verification || null,
      } : null,
    }]);
}

// 发送企微通知
async function notifyWecom(title: string, content: string) {
  const corpid = process.env.WECOM_CORP_ID;
  const secret = process.env.WECOM_SECRET;
  const agentid = process.env.WECOM_AGENT_ID;

  if (!corpid || !secret || !agentid) {
    console.warn('[notifyWecom] Missing WeChat work credentials');
    return;
  }

  try {
    // 获取 access_token
    const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${secret}`);
    const tokenData = await tokenRes.json();

    if (tokenData.errcode !== 0) {
      console.error('[notifyWecom] Failed to get token:', tokenData.errmsg);
      return;
    }

    const accessToken = tokenData.access_token;

    // 发送应用消息（发给管理员）
    const sendRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: 'ZhangDuo',  // 发给张铎
        msgtype: 'markdown',
        agentid: parseInt(agentid),
        markdown: { content: `### ${title}\n${content}` },
      }),
    });

    const sendData = await sendRes.json();
    if (sendData.errcode !== 0) {
      console.error('[notifyWecom] Failed to send:', sendData.errmsg);
    } else {
      console.log('[notifyWecom] Notification sent');
    }
  } catch (err: any) {
    console.error('[notifyWecom] Error:', err.message);
  }
}

// ===== 单次采集 + 转换 =====
interface CollectResult {
  records: any[];
  apiTotal: number;
  storagePath: string;
  error: string;
}

async function collectOnce(
  authToken: string,
  branchNums: number[],
  branchNumsStr: string,
  dates: string[],
  pageSize: number,
): Promise<CollectResult> {
  const result: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '' };

  // ===== 预热：激活 Token 会话 =====
  const warmBody = buildBody(branchNums, dates, 1, 5);
  const warmResult = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, warmBody, branchNumsStr);

  if (warmResult.ok && warmResult.data?.code === 0) {
    console.log(`[collect-lemeng] Warm-up success`);
  } else if (warmResult.ok && warmResult.data?.code === -1) {
    result.error = `Token expired: ${warmResult.data?.message}`;
    return result;
  } else {
    console.warn(`[collect-lemeng] Warm-up HTTP ${warmResult.status}: ${warmResult.error}, continuing...`);
  }

  // ===== 查询总数 =====
  const countBody = buildBody(branchNums, dates, 1, pageSize);
  const countResult = await callLemengApi(ENDPOINT_RETAIL_COUNT, authToken, countBody, branchNumsStr);

  if (countResult.ok && countResult.data?.code === 0) {
    result.apiTotal = countResult.data.result || 0;
    console.log(`[collect-lemeng] Total count: ${result.apiTotal}`);
  } else {
    console.warn(`[collect-lemeng] Count query failed, will paginate without limit`);
    result.apiTotal = 10000;
  }

  if (result.apiTotal === 0) {
    return result;
  }

  // ===== 分页拉取 =====
  const totalPages = Math.ceil(result.apiTotal / pageSize);
  const maxPages = 100;
  let page = 1;
  let consecutiveErrors = 0;

  while (page <= totalPages && page <= maxPages) {
    const bodyStr = buildBody(branchNums, dates, page, pageSize);
    const pageResult = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, bodyStr, branchNumsStr);

    if (!pageResult.ok) {
      console.error(`[collect-lemeng] Page ${page} HTTP error: ${pageResult.error}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        result.error = `Consecutive 3 pages failed, stopped at page ${page}`;
        break;
      }
      page++;
      continue;
    }

    if (pageResult.data.code !== 0) {
      console.error(`[collect-lemeng] Page ${page} API error: ${pageResult.data.message}`);
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
    console.log(`[collect-lemeng] Page ${page}/${totalPages}: ${records.length} rows, total ${result.records.length}`);

    if (records.length < pageSize) break;
    page++;
  }

  // ===== 调用 DuckDB 转换为 Parquet =====
  if (result.records.length > 0) {
    try {
      const flatRecords = flattenRecords(result.records);
      const dateStr = dates[0];

      console.log(`[collect-lemeng] Calling DuckDB transform: ${flatRecords.length} records`);

      const transformRes = await fetch(`${DUCKDB_URL}/transform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
            base_path: `lemeng/retail_detail/${dateStr}`
          }
        })
      });

      if (!transformRes.ok) {
        const errText = await transformRes.text();
        throw new Error(`DuckDB transform failed: ${transformRes.status} ${errText}`);
      }

      const transformResult = await transformRes.json();
      if (!transformResult.success) {
        throw new Error(transformResult.error || 'Transform failed');
      }

      result.storagePath = transformResult.combined_file;
      console.log(`[collect-lemeng] Parquet export success: ${result.storagePath}`);

      if (transformResult.invalid_records > 0 || transformResult.duplicates_removed > 0) {
        console.warn(`[collect-lemeng] Data quality: ${transformResult.invalid_records} invalid, ${transformResult.duplicates_removed} duplicates`);
      }
    } catch (transformErr: any) {
      console.error(`[collect-lemeng] DuckDB transform failed: ${transformErr.message}`);
      result.error += (result.error ? '; ' : '') + `Transform failed: ${transformErr.message}`;
    }
  }

  return result;
}

// 对账重试最大次数
const MAX_VERIFY_RETRIES = 3;

// ===== 主流程 =====
export async function POST(req: NextRequest) {
  const startedAt = new Date();

  try {
    if (!LEMENG_SECRET_KEY) {
      return NextResponse.json({ success: false, error: "LEMENG_SECRET_KEY not configured" }, { status: 500 });
    }

    const body = await req.json();
    const { task_id } = body;

    const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

    // 获取任务信息
    const { data: task } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, function_slug, params, storage_type, storage_path')
      .eq('id', task_id)
      .single();

    if (!task) {
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'Task not found');
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    // 获取凭证
    let credentials: Record<string, string> = {};
    if (task.source_id) {
      const { data: cred } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', task.source_id)
        .single();

      if (cred?.credential_data) {
        try { credentials = JSON.parse(cred.credential_data); } catch { /* ignore */ }
      }
    }

    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) {
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'No token configured');
      return NextResponse.json({ success: false, error: 'No token configured' }, { status: 400 });
    }

    const params = task.params || {};
    const dates = params.dates || [getYesterdayChina(), getYesterdayChina()];
    const branchNums = params.branch_nums || ALL_BRANCH_NUMS;
    const pageSize = params.page_size || 200;

    console.log(`[collect-lemeng] Starting: dates=${dates[0]}~${dates[1]}, branches=${branchNums.length}`);

    const branchNumsStr = branchNums.join(',');

    // ===== 对账重试循环 =====
    let lastResult: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '' };
    let verified = false;
    let retryCount = 0;

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      console.log(`[collect-lemeng] === 采集第 ${attempt} 次 ${attempt > 1 ? '(对账重试)' : ''} ===`);

      lastResult = await collectOnce(authToken, branchNums, branchNumsStr, dates, pageSize);

      // Token 过期直接退出，不重试
      if (lastResult.error.startsWith('Token expired')) {
        const finishedAt = new Date();
        await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, lastResult.error);
        return NextResponse.json({ success: false, error: lastResult.error }, { status: 401 });
      }

      // 无数据直接退出
      if (lastResult.apiTotal === 0) {
        const finishedAt = new Date();
        await client.database
          .from('collect_tasks')
          .update({ last_run_at: finishedAt.toISOString() })
          .eq('id', task_id);
        await writeLog(client, task_id, startedAt, finishedAt, 'success', 0);
        return NextResponse.json({ success: true, rows_collected: 0, dates, branches: branchNums.length });
      }

      // 全量对账
      const missing = lastResult.apiTotal - lastResult.records.length;
      verified = lastResult.records.length >= lastResult.apiTotal;

      if (verified) {
        console.log(`[collect-lemeng] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal} 条`);
        break;
      }

      // 对账失败
      const missingPercent = ((missing / lastResult.apiTotal) * 100).toFixed(1);
      retryCount = attempt;

      if (attempt < MAX_VERIFY_RETRIES) {
        console.warn(`[collect-lemeng] ⚠️ 第 ${attempt} 次对账失败：采集 ${lastResult.records.length} 条，API 总数 ${lastResult.apiTotal}，缺少 ${missing} 条 (${missingPercent}%)，5 秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error(`[collect-lemeng] ❌ 第 ${attempt} 次对账仍失败：采集 ${lastResult.records.length} 条，API 总数 ${lastResult.apiTotal}，缺少 ${missing} 条 (${missingPercent}%)，已用尽重试次数`);

        // 3 次都失败，发送企微告警
        await notifyWecom(
          '❌ 乐檬数据采集不完整（已重试3次）',
          `**日期**: ${dates[0]}\n**采集数**: ${lastResult.records.length}\n**API总数**: ${lastResult.apiTotal}\n**缺少**: ${missing} 条 (${missingPercent}%)\n**重试**: ${MAX_VERIFY_RETRIES} 次均失败\n**建议**: 请检查网络或手动重新采集`
        );

        lastResult.error += (lastResult.error ? '; ' : '') + `对账失败(重试${MAX_VERIFY_RETRIES}次): 缺少 ${missing} 条`;
      }
    }

    // ===== 更新任务状态和日志 =====
    const finishedAt = new Date();
    await client.database
      .from('collect_tasks')
      .update({ last_run_at: finishedAt.toISOString() })
      .eq('id', task_id);

    const missing = lastResult.apiTotal - lastResult.records.length;
    const finalStatus = lastResult.error ? 'partial' : 'success';
    await writeLog(
      client,
      task_id,
      startedAt,
      finishedAt,
      finalStatus,
      lastResult.records.length,
      lastResult.error || undefined,
      lastResult.storagePath || undefined,
      { api_total: lastResult.apiTotal, missing, verified }
    );

    return NextResponse.json({
      success: verified && !lastResult.error,
      rows_collected: lastResult.records.length,
      dates,
      branches: branchNums.length,
      api_total: lastResult.apiTotal,
      verification: { verified, missing, retries: retryCount },
      storage_path: lastResult.storagePath || undefined,
      error: lastResult.error || undefined,
      sample: lastResult.records.slice(0, 2),
    });

  } catch (error: any) {
    console.error('[collect-lemeng] Fatal error:', error);
    const finishedAt = new Date();

    try {
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const body = await req.json();
      await writeLog(client, body.task_id, startedAt, finishedAt, 'failed', 0, error.message);
    } catch { /* ignore */ }

    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
