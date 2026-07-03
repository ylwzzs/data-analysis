// web/app/api/admin/collect-lemeng/route.ts
// 直接在 Next.js 服务端调用乐檬 API，避开 Deno runtime 问题
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import crypto from 'crypto';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_RETAIL_DETAIL = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";
const ENDPOINT_RETAIL_COUNT = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";

const ALL_BRANCH_NUMS = [
  1,2,3,4,5,6,7,10,11,12,13,14,15,17,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,34,35,36,37,40,42,43,44,46,47,48,49,50,51,52,53,54,57,58,60,61,62,63,64,65,66,67,68,70,72,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,888
];

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

async function callLemengApi(urlPath: string, authToken: string, bodyStr: string, branchNumsStr: string, maxRetries = 2) {
  const fullUrl = BASE_URL + urlPath;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = buildHeaders(authToken, branchNumsStr, urlPath, bodyStr);

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: headers,
      body: bodyStr
    });

    if (response.status === 200) {
      const data = await response.json();
      if (data.code === -1 && attempt < maxRetries - 1) {
        console.log(`Attempt ${attempt + 1}: code=-1, retrying after 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      return { ok: true, data };
    }

    return { ok: false, status: response.status, error: await response.text() };
  }
  return { ok: false, error: "Max retries exceeded" };
}

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
      return NextResponse.json({ success: false, error: 'No token configured' }, { status: 400 });
    }

    const params = task.params || {};
    const dates = params.dates || [getYesterday(), getYesterday()];
    const branchNums = params.branch_nums || ALL_BRANCH_NUMS;
    const pageSize = params.page_size || 200;

    console.log(`[collect-lemeng] Starting: dates=${dates[0]}, branches=${branchNums.length}`);

    // 预热
    const branchNumsStr = branchNums.join(',');
    const warmBody = buildBody(branchNums, dates, 1, 5);
    const warmResult = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, warmBody, branchNumsStr);

    if (!warmResult.ok || warmResult.data?.code === -1) {
      const errMsg = warmResult.ok ? warmResult.data?.message : warmResult.error;
      return NextResponse.json({
        success: false,
        error: `Warm-up failed: ${errMsg}`,
        debug: { secretKeySet: !!LEMENG_SECRET_KEY, tokenLen: authToken.length }
      });
    }

    console.log(`[collect-lemeng] Warm-up success`);

    // 查总数 - 用 detail 接口的分页方式
    const allRecords: any[] = [];
    let page = 1;
    const totalPages = 50; // 安全上限

    while (page <= totalPages) {
      const bodyStr = buildBody(branchNums, dates, page, pageSize);
      const result = await callLemengApi(ENDPOINT_RETAIL_DETAIL, authToken, bodyStr, branchNumsStr);

      if (!result.ok) {
        console.error(`[collect-lemeng] Page ${page} failed:`, result.error);
        break;
      }

      if (result.data.code !== 0) {
        console.error(`[collect-lemeng] API error:`, result.data.message);
        break;
      }

      const records = result.data.result || [];
      allRecords.push(...records);
      console.log(`[collect-lemeng] Page ${page}: ${records.length} rows, total ${allRecords.length}`);

      if (records.length < pageSize) break;
      page++;
    }

    // 更新任务状态
    const finishedAt = new Date();
    await client.database
      .from('collect_tasks')
      .update({ last_run_at: finishedAt.toISOString() })
      .eq('id', task_id);

    // 写日志
    await client.database
      .from('collect_logs')
      .insert([{
        task_id: task_id,
        status: 'success',
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        rows_collected: allRecords.length
      }]);

    return NextResponse.json({
      success: true,
      rows_collected: allRecords.length,
      dates,
      branches: branchNums.length,
      sample: allRecords.slice(0, 2)
    });

  } catch (error: any) {
    console.error('[collect-lemeng] Error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}
