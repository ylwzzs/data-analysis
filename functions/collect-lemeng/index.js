/**
 * 乐檬零售数据采集 Function
 *
 * 采集：销售订单明细（nhsoft.retail.business.posorder.findposorderdetail）
 * 凭证：token（Bearer JWT，5天过期）
 * 签名：SHA256(auth + timestamp + nonce + branch_nums + scope_ids + SECRET + url + body + SECRET)
 */

// ===== 配置 =====
const BASE_URL = "https://sharef.lemengcloud.com";
// 从环境变量读取签名密钥（部署时配置）
const SECRET_KEY = Deno.env.get("LEMENG_SECRET_KEY") || "";

const ENDPOINT_RETAIL_DETAIL = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.findposorderdetail";
const ENDPOINT_RETAIL_COUNT = "/earth-gateway/amazon-retail/nhsoft.retail.business.posorder.countposorderdetail";

// 全部门店（从 Python 脚本迁移）
const ALL_BRANCH_NUMS = [
  1,2,3,4,5,6,7,10,11,12,13,14,15,17,18,19,20,21,22,24,25,26,27,28,29,30,31,32,33,34,35,36,37,40,42,43,44,46,47,48,49,50,51,52,53,54,57,58,60,61,62,63,64,65,66,67,68,70,72,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,160,161,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,888
];

// ===== 签名算法 =====
function generateSignature(authToken, timestamp, nonce, branchNums, scopeIds, urlPath, bodyStr) {
  // SHA256(auth + timestamp + nonce + branch_nums + scope_ids + SECRET + url + body + SECRET)
  const signStr = authToken + timestamp + nonce + branchNums + scopeIds + SECRET_KEY + urlPath + bodyStr + SECRET_KEY;

  // Deno: 使用 crypto.subtle.digest
  const encoder = new TextEncoder();
  const data = encoder.encode(signStr);

  return crypto.subtle.digest('SHA-256', data).then(hashBuffer => {
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  });
}

// ===== 请求构建 =====
async function buildHeaders(authToken, branchNumsStr, urlPath, bodyStr) {
  const timestamp = String(Date.now());
  const nonce = generateNonce();

  const signature = await generateSignature(
    authToken, timestamp, nonce, branchNumsStr, "", urlPath, bodyStr
  );

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

function generateNonce() {
  // 16 字节随机 hex
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
  }, null, 0);  // separators=(',',':') equivalent - no spaces
}

// ===== API 调用 =====
async function callApi(urlPath, authToken, bodyStr, branchNumsStr, maxRetries = 2) {
  const fullUrl = BASE_URL + urlPath;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = await buildHeaders(authToken, branchNumsStr, urlPath, bodyStr);

    const response = await fetch(fullUrl, {
      method: 'POST',
      headers: headers,
      body: bodyStr
    });

    if (response.status === 200) {
      const data = await response.json();

      // code=-1 表示 "用户信息已失效"，需要重试激活
      if (data.code === -1 && attempt < maxRetries - 1) {
        console.log(`Attempt ${attempt + 1}: code=-1, retrying after 2s...`);
        await delay(2000);
        continue;
      }

      return { ok: true, data };
    }

    return { ok: false, status: response.status, error: await response.text() };
  }

  return { ok: false, error: "Max retries exceeded" };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 业务逻辑 =====
async function fetchRetailCount(authToken, dates, branchNums) {
  const branchNumsStr = branchNums.join(',');
  const bodyStr = buildBody(branchNums, dates, 1, 200);

  const result = await callApi(ENDPOINT_RETAIL_COUNT, authToken, bodyStr, branchNumsStr);

  if (!result.ok) {
    throw new Error(`Count API failed: ${result.error || result.status}`);
  }

  if (result.data.code !== 0) {
    throw new Error(`Count API error: ${result.data.message || JSON.stringify(result.data)}`);
  }

  return result.data.result || 0;
}

async function fetchRetailDetail(authToken, dates, branchNums, pageNumber, pageSize) {
  const branchNumsStr = branchNums.join(',');
  const bodyStr = buildBody(branchNums, dates, pageNumber, pageSize);

  const result = await callApi(ENDPOINT_RETAIL_DETAIL, authToken, bodyStr, branchNumsStr);

  if (!result.ok) {
    throw new Error(`Detail API failed: ${result.error || result.status}`);
  }

  if (result.data.code !== 0) {
    throw new Error(`Detail API error: ${result.data.message || JSON.stringify(result.data)}`);
  }

  return result.data.result || [];
}

async function warmUpSession(authToken, dates, branchNums) {
  // 预热：发送小请求激活 Token 会话
  const branchNumsStr = branchNums.join(',');
  const bodyStr = buildBody(branchNums, dates, 1, 5);

  console.log("Warm-up: activating token session...");

  const result = await callApi(ENDPOINT_RETAIL_DETAIL, authToken, bodyStr, branchNumsStr);

  if (!result.ok || result.data.code === -1) {
    throw new Error(`Warm-up failed: token may be expired. ${JSON.stringify(result.data || result)}`);
  }

  console.log(`Warm-up success: ${result.data.result ? result.data.result.length : 0} test rows`);
}

async function fetchAllPages(authToken, dates, branchNums, pageSize = 200) {
  // 1. 预热会话
  await warmUpSession(authToken, dates, branchNums);

  // 2. 查询总数
  const total = await fetchRetailCount(authToken, dates, branchNums);
  console.log(`Total count: ${total}`);

  if (total === 0) {
    return [];
  }

  // 3. 分页拉取
  const totalPages = Math.ceil(total / pageSize);
  const allRecords = [];

  for (let page = 1; page <= totalPages; page++) {
    console.log(`Fetching page ${page}/${totalPages}...`);

    const records = await fetchRetailDetail(authToken, dates, branchNums, page, pageSize);
    allRecords.push(...records);

    console.log(`Page ${page}: ${records.length} rows, total ${allRecords.length}`);

    if (records.length < pageSize) {
      break;
    }
  }

  return allRecords;
}

// ===== 主入口 =====
module.exports = async function(req) {
  try {
    const body = await req.json();
    const { credentials, params, storage_type, storage_path, manual } = body;

    // 凭证检查
    const authToken = credentials?.token;
    if (!authToken) {
      throw new Error("Missing token in credentials");
    }

    // 日期参数（默认昨天）
    const dates = params?.dates || [getYesterday(), getYesterday()];
    const branchNums = params?.branch_nums || ALL_BRANCH_NUMS;
    const pageSize = params?.page_size || 200;

    console.log("Starting lemeng retail collection");
    console.log(`Dates: ${dates[0]} to ${dates[1]}`);
    console.log(`Branches: ${branchNums.length}`);
    console.log(`Storage: ${storage_type} -> ${storage_path}`);

    // 执行采集
    const records = await fetchAllPages(authToken, dates, branchNums, pageSize);

    console.log(`Collected ${records.length} records`);

    // 存储逻辑（TODO）
    if (storage_type === "oos") {
      // TODO: Parquet 转换 + 天翼云 OOS 上传
      console.log(`[TODO] Upload to OOS: ${storage_path}`);
    } else if (storage_type === "postgresql") {
      // TODO: PostgREST 批量插入
      console.log(`[TODO] Write to PostgreSQL: ${storage_path}`);
    }

    // 返回结果
    return new Response(JSON.stringify({
      success: true,
      rows_collected: records.length,
      dates: dates,
      branches: branchNums.length,
      storage_type,
      storage_path,
      sample: records.slice(0, 2),
      timestamp: new Date().toISOString()
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("Collection error:", error);

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