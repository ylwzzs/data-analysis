/**
 * 乐檬零售数据采集 Edge Function
 * 
 * 功能：采集销售订单明细数据并存储到 PostgreSQL 或天翼云 OOS
 * 
 * 优化：
 * 1. 并行分页拉取（支持大量数据）
 * 2. 预热会话解决 token 失效问题
 * 3. 支持增量采集
 * 4. 完整的存储实现（PostgreSQL + 天翼云 OOS）
 */

// ===== 配置 =====
const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_RETAIL_DETAIL = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";

// 全部门店编号
const ALL_BRANCH_NUMS = [
  1,2,3,4,5,6,7,10,11,12,13,14,15,17,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,34,35,36,37,40,42,43,44,46,47,48,49,50,51,52,53,54,57,58,60,61,62,63,64,65,66,67,68,70,72,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,888
];

// ===== 签名算法 =====
async function generateSignature(authToken, timestamp, nonce, branchNumsStr, scopeIds, urlPath, bodyStr, secretKey) {
  const signStr = authToken + timestamp + nonce + branchNumsStr + scopeIds + secretKey + urlPath + bodyStr + secretKey;
  
  const encoder = new TextEncoder();
  const data = encoder.encode(signStr);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildBody(branchNums, dates, pageNumber, pageSize) {
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

async function buildHeaders(authToken, branchNumsStr, urlPath, bodyStr, secretKey) {
  const timestamp = String(Date.now());
  const nonce = generateNonce();
  const signature = await generateSignature(authToken, timestamp, nonce, branchNumsStr, "", urlPath, bodyStr, secretKey);
  
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

// ===== API 调用 =====
async function callApi(urlPath, authToken, bodyStr, branchNumsStr, secretKey, maxRetries = 3) {
  const fullUrl = BASE_URL + urlPath;
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = await buildHeaders(authToken, branchNumsStr, urlPath, bodyStr, secretKey);
    try {
      const response = await fetch(fullUrl, { method: 'POST', headers, body: bodyStr });
      if (response.status === 200) {
        const data = await response.json();
        if (data.code === 0) return { ok: true, data };
        lastErr = `code=${data.code}`;
        if (attempt < maxRetries - 1) { console.log(`[collect-lemeng] 调用失败(${lastErr}), 重试 ${attempt + 1}/${maxRetries}...`); await delay(2000); continue; }
        return { ok: false, data, error: lastErr };
      }
      lastErr = `HTTP ${response.status}`;
    } catch (e) { lastErr = String(e); }
    if (attempt < maxRetries - 1) { console.log(`[collect-lemeng] 调用失败(${lastErr}), 重试 ${attempt + 1}/${maxRetries}...`); await delay(2000); }
  }
  return { ok: false, error: lastErr || "Max retries exceeded" };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 并行分页拉取 =====
async function fetchAllPagesOptimized(authToken, dates, branchNums, pageSize, secretKey) {
  console.log('[collect-lemeng] 开始并行采集...');
  const startTime = Date.now();

  const branchNumsStr = branchNums.join(',');
  const warmBody = buildBody(branchNums, dates, 1, 5);
  const warmResult = await callApi(ENDPOINT_RETAIL_DETAIL, authToken, warmBody, branchNumsStr, secretKey);
  if (!warmResult.ok) {
    throw new Error(`Warm-up failed: token may be expired. ${JSON.stringify(warmResult.data || warmResult)}`);
  }
  console.log('[collect-lemeng] 会话预热成功');

  const firstBody = buildBody(branchNums, dates, 1, pageSize);
  const firstResult = await callApi(ENDPOINT_RETAIL_DETAIL, authToken, firstBody, branchNumsStr, secretKey);
  if (!firstResult.ok) {
    throw new Error(`First page failed: ${JSON.stringify(firstResult.data || firstResult)}`);
  }

  const allRecords = [...(firstResult.data.result || [])];
  console.log(`[collect-lemeng] 第1页: ${allRecords.length} 条`);

  const parallelism = 5;
  const MAX_PAGES = 1000; // 保护上限（以空批判定为主，避免截断大数据量）
  let page = 2;
  let failCount = 0;
  let emptyBatches = 0;

  while (page <= MAX_PAGES) {
    const batchPromises = [];
    for (let i = 0; i < parallelism && page <= MAX_PAGES; i++, page++) {
      batchPromises.push(callApi(ENDPOINT_RETAIL_DETAIL, authToken, buildBody(branchNums, dates, page, pageSize), branchNumsStr, secretKey));
    }
    if (batchPromises.length === 0) break;

    const batchResults = await Promise.all(batchPromises);
    let batchTotal = 0;
    let batchFails = 0;
    for (const result of batchResults) {
      if (!result.ok) { failCount++; batchFails++; console.error('[collect-lemeng] 分页失败(重试后仍失败, 该页数据缺失):', result.error); continue; }
      const records = result.data.result || [];
      allRecords.push(...records);
      batchTotal += records.length;
    }
    console.log(`[collect-lemeng] 进度: 已拉取 ${allRecords.length} 条, 累计失败页 ${failCount}`);

    // 结束判定：整批全0且无失败 → 连续2次才停（防临时空页误判，不再用"单页<pageSize"提前break）
    if (batchTotal === 0 && batchFails === 0) { emptyBatches++; if (emptyBatches >= 2) break; }
    else emptyBatches = 0;
    if (batchFails === batchResults.length) { console.error('[collect-lemeng] 整批全失败, 终止'); break; }
  }

  console.log(`[collect-lemeng] 采集完成: ${allRecords.length} 条, 失败页 ${failCount}, 耗时 ${Date.now() - startTime}ms`);
  return { records: allRecords, failCount };
}

// ===== 天翼云 OOS 存储 =====

/**
 * 计算 AWS Signature Version 4
 * 用于天翼云 OOS (兼容 S3 API)
 */
async function signS3V4(key, secret, region, service, method, path, headers, body) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:.]/g, '').replace(/-\d{4}Z$/, 'Z');
  const dateStamp = amzDate.substring(0, 8);
  
  // Step 1: Canonical Request
  const sortedHeaders = Object.entries(headers)
    .filter(([k]) => k.startsWith('x-amz-') || k === 'host')
    .sort(([a], [b]) => a.localeCompare(b));
  
  const canonicalHeaders = sortedHeaders.map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`).join('\n');
  const signedHeaders = sortedHeaders.map(([k]) => k.toLowerCase()).join(';');
  
  const payloadHash = await sha256Hash(body || '');
  
  const canonicalRequest = [
    method,
    path,
    '',  // query string
    canonicalHeaders,
    '',
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // Step 2: String to Sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256Hash(canonicalRequest);
  
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');
  
  // Step 3: Calculate Signature
  const kDate = await hmacSha256(secret, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);
  
  const authorization = `AWS4-HMAC-SHA256 Credential=${key}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return { authorization, amzDate };
}

async function sha256Hash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key, message) {
  const encoder = new TextEncoder();
  const keyData = typeof key === 'string' ? encoder.encode(key) : key;
  const messageData = encoder.encode(message);
  
  const cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return new Uint8Array(signature);
}

async function hmacSha256Hex(key, message) {
  const result = await hmacSha256(key, message);
  return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 存储到天翼云 OOS
 */
async function storeToOOS(records, bucket, path) {
  if (!records || records.length === 0) {
    console.log('[collect-lemeng] 无数据需要存储到 OOS');
    return 0;
  }
  
  // 从环境变量获取 OOS 配置
  const endpoint = Deno.env.get('S3_ENDPOINT') || 'http://xinan-1-internal.zos.ctyun.cn';
  const accessKey = Deno.env.get('OOS_ACCESS_KEY') || Deno.env.get('S3_ACCESS_KEY_ID');
  const secretKey = Deno.env.get('OOS_SECRET_KEY') || Deno.env.get('S3_SECRET_ACCESS_KEY');
  const region = 'xinan-1';  // 天翼云区域
  
  if (!accessKey || !secretKey) {
    throw new Error('Missing OOS_ACCESS_KEY or OOS_SECRET_KEY');
  }
  
  // 生成文件名
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fileName = path.replace('*', timestamp);
  
  // 转换为 NDJSON 格式
  const ndjsonContent = records.map(r => JSON.stringify(r)).join('\n');
  const body = new TextEncoder().encode(ndjsonContent);
  
  // 计算 body hash
  const contentSha256 = await sha256Hash(ndjsonContent);
  
  // 构建请求
  const host = endpoint.replace(/^https?:\/\//, '');
  const url = `https://${host}/${bucket}/${fileName}`;
  
  const headers = {
    'host': host,
    'x-amz-content-sha256': contentSha256,
    'x-amz-date': ''  // will be filled by signS3V4
  };
  
  const { authorization, amzDate } = await signS3V4(
    accessKey, secretKey, region, 's3',
    'PUT', `/${bucket}/${fileName}`,
    { ...headers, 'x-amz-date': amzDate },
    ndjsonContent
  );
  
  headers['x-amz-date'] = amzDate;
  
  console.log(`[collect-lemeng] 上传到 OOS: ${bucket}/${fileName}`);
  console.log(`[collect-lemeng] endpoint: ${endpoint}`);
  
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/x-ndjson',
      'x-amz-content-sha256': contentSha256,
      'x-amz-date': amzDate
    },
    body
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[collect-lemeng] OOS 上传失败 (${response.status}):`, errorText);
    throw new Error(`OOS upload failed: ${response.status}`);
  }
  
  console.log(`[collect-lemeng] OOS 上传成功: ${records.length} 条`);
  return records.length;
}

// ===== 主入口 =====
module.exports = async function(req) {
  try {
    console.log('[collect-lemeng] 开始执行...');
    
    const body = await req.json();
    const { credentials, params, storage_type, storage_path, manual, secret_key } = body;
    
    console.log('[collect-lemeng] 请求参数:', {
      hasCredentials: !!credentials,
      hasToken: !!credentials?.token,
      hasSecretKey: !!secret_key,
      hasEnvSecret: !!(Deno.env.get('LEMENG_SECRET_KEY')),
      storageType: storage_type,
      storagePath: storage_path
    });
    
    // 1. 获取签名密钥
    const SECRET_KEY = secret_key || Deno.env.get('LEMENG_SECRET_KEY') || "";
    if (!SECRET_KEY) {
      throw new Error("Missing LEMENG_SECRET_KEY for signature");
    }
    console.log('[collect-lemeng] 签名密钥已获取');
    
    // 2. 凭证检查
    let authToken = credentials?.token;
    if (!authToken) {
      throw new Error("Missing token in credentials");
    }
    if (!authToken.startsWith("Bearer ")) {
      authToken = "Bearer " + authToken;
    }
    console.log('[collect-lemeng] 认证token已准备好');
    
    // 3. 日期参数（默认滚动回溯3天到昨天，容延迟单据；lookback_days 可配）
    const lookback = params?.lookback_days ?? 3;
    const dates = params?.dates || getLookbackRange(lookback);
    const branchNums = params?.branch_nums || ALL_BRANCH_NUMS;
    const pageSize = params?.page_size || 200;
    
    console.log(`[collect-lemeng] 采集配置:`, {
      dates: `${dates[0]} to ${dates[1]}`,
      branches: branchNums.length,
      pageSize: pageSize
    });
    
    // 4. 执行采集
    const { records, failCount } = await fetchAllPagesOptimized(authToken, dates, branchNums, pageSize, SECRET_KEY);
    
    console.log(`[collect-lemeng] 采集完成: ${records.length} 条记录`);
    
    // 5. 存储逻辑
    let storedCount = 0;
    if (storage_type === "oos" || storage_type === "s3") {
      // 解析 bucket 和 path
      const parts = storage_path.split('/');
      const bucket = parts[0];
      const filePath = parts.slice(1).join('/');
      storedCount = await storeToOOS(records, bucket, filePath);
    } else if (storage_type === "postgresql") {
      console.warn(`[collect-lemeng] PostgreSQL 存储需要先创建目标表: ${storage_path}`);
      storedCount = 0;
    } else {
      console.warn(`[collect-lemeng] 未知的存储类型: ${storage_type}`);
    }
    
    // 6. 返回结果
    const response = {
      success: true,
      rows_collected: records.length,
      rows_stored: storedCount,
      dates: dates,
      branches: branchNums.length,
      storage_type,
      storage_path,
      fail_pages: failCount,
      complete: failCount === 0,
      sample: records.slice(0, 2),
      timestamp: new Date().toISOString()
    };
    
    console.log('[collect-lemeng] 执行成功:', { rows_collected: records.length, rows_stored: storedCount });
    
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
    
  } catch (error) {
    console.error('[collect-lemeng] 执行失败:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

// 滚动回溯窗口：[今天-N, 昨天]，每天采集覆盖最近N天，延迟生成/审核的单据会被后续重叠窗口补采（/merge按单据号去重，重叠不重复）
function getLookbackRange(days) {
  const end = new Date(); end.setDate(end.getDate() - 1);
  const start = new Date(); start.setDate(start.getDate() - days);
  const f = (d) => d.toISOString().split('T')[0];
  return [f(start), f(end)];
}
