// functions/agent-query/index.js
// 智能问数网关（架构文档 docs/architecture.md §4.2）
// 链路：① 认证(AGENT_API_KEY) → ② 授权(get_user_perms 取 branch_nums/can_see_cost)
//      → ③ SQL 白名单 → ④/⑤ 引擎路由（明细→DuckDB 权限视图；汇总→PostgREST execute_sql_rls 走 RLS）
//      → ⑥ 审计(agent_query_logs)
// CommonJS（InsForge edge function runtime 要求），Deno 运行时，全局 fetch 可用。

// ===== 配置 =====
const AGENT_API_KEY = Deno.env.get("AGENT_API_KEY");
// 签名密钥：优先专用 JWT_SIGNING_KEY（JWT_SECRET 老 function secret 历史加密损坏，注入空串）；
// 回退到容器 env JWT_SECRET（compose 注入，恒在，值同 .env 的 JWT_SECRET）。
const JWT_SECRET = Deno.env.get("JWT_SIGNING_KEY") || Deno.env.get("JWT_SECRET") || "";
const DUCKDB_URL = Deno.env.get("DUCKDB_URL") || "http://duckdb:9000";
const POSTGREST_URL = Deno.env.get("POSTGREST_BASE_URL") || "http://postgrest:3000";

// retail_detail 明细：OOS 全品牌全日期（§7.3 按 company_id 分区）
const RETAIL_GLOB = "s3://lemeng-datasource/lemeng/retail_detail/*/*/all.parquet";
// 成本敏感组（必须成组脱敏，防 sale_money × sale_profit_rate 反算 profit）
const COST_COLUMNS = [
  "item_cost_price",
  "order_detail_cost",
  "order_detail_grade_cost",
  "cost",
  "profit",
  "sale_profit_rate",
];
// PG 汇总表（命中则走 PG 路径）
const REPORT_TABLES = ["report_daily_sales", "report_daily_category", "report_weekly_trend"];
const MAX_ROWS = 1000;
const SHORT_JWT_TTL = 300; // 网关代签短时 JWT 有效期（秒）

// ===== JWT（复用 wecom-oauth 的 signJwt，HS256 + JWT_SECRET）=====
function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signJwt(payload, secret) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

// 服务级短时 JWT（role=authenticated）：网关直连 PostgREST 用。
// PostgREST 不认 InsForge 的 anon_key（非 JWT），用 JWT_SECRET 自签的 JWT 它才认。
async function serviceJwt() {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: "agent-query", role: "authenticated", iss: "agent-query", iat: now, exp: now + 60 }, JWT_SECRET);
}

// ===== 工具 =====
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-agent-key",
      "Content-Type": "application/json",
    },
  });
}
function sqlLit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"; // branch_num 等数值字符串
}
const isReportQuery = (sql) => REPORT_TABLES.some((t) => new RegExp("\\b" + t + "\\b", "i").test(sql));

// SQL 白名单：仅 SELECT、禁 read_parquet/DDL/DML/COPY；无 LIMIT 则强制补
function validateSql(raw) {
  const trimmed = raw.trim().replace(/;+\s*$/, "");
  const u = trimmed.toUpperCase();
  if (!/^SELECT[\s(]/.test(u)) throw new Error("only_select_allowed");
  const forbidden = [
    "READ_PARQUET", "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE",
    "ALTER", "CREATE", "GRANT", "REVOKE", "COPY", "ATTACH", "PRAGMA",
  ];
  for (const kw of forbidden) {
    if (new RegExp("\\b" + kw + "\\b").test(u)) throw new Error("forbidden_statement:" + kw);
  }
  if (/\bLIMIT\b/i.test(trimmed)) return trimmed;
  return trimmed + " LIMIT " + MAX_ROWS;
}

// ④ DuckDB 路径：拼权限视图（行 branch_nums + 列成本组脱敏，硬编码进视图定义）
async function runDuckdb(userSelect, perms) {
  const allBranches = !Array.isArray(perms.branch_nums) || perms.branch_nums.length === 0 || perms.branch_nums.includes("*");
  const branchFilter = allBranches
    ? ""
    : "WHERE branch_num IN (" + perms.branch_nums.map(sqlLit).join(", ") + ")";
  const canSee = perms.can_see_cost ? "TRUE" : "FALSE";
  const replaceList = COST_COLUMNS.map((c) => `CASE WHEN ${canSee} THEN "${c}" ELSE NULL END AS "${c}"`).join(", ");
  const viewSql =
    "CREATE OR REPLACE TEMP VIEW retail_detail AS " +
    "SELECT * REPLACE (" + replaceList + ") " +
    "FROM read_parquet('" + RETAIL_GLOB + "') " + branchFilter + ";";
  // 一次提交：建视图 + 用户 SELECT（同连接，临时视图隔离，已实测）
  const combined = viewSql + "\n" + userSelect;
  const res = await fetch(DUCKDB_URL + "/query", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
    body: JSON.stringify({ sql: combined, user_id: perms.user_id }),
  });
  const body = await res.json();
  if (!res.ok || !body.success) throw new Error("duckdb:" + (body.error || res.status));
  return body.data;
}

// ⑤ PG 路径：代签短时 JWT（注入 branch_nums/can_see_cost）→ execute_sql_rls（SECURITY INVOKER，走 RLS）
async function runPg(userSelect, userId, perms) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    {
      sub: userId,
      role: "authenticated",
      branch_nums: perms.branch_nums,
      can_see_cost: !!perms.can_see_cost,
      iss: "agent-query",
      iat: now,
      exp: now + SHORT_JWT_TTL,
    },
    JWT_SECRET,
  );
  const res = await fetch(POSTGREST_URL + "/rpc/execute_sql_rls", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ p_query: userSelect }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error("pg:" + (JSON.stringify(body.message || body) || res.status));
  // execute_sql_rls 拒绝时返回 [{error:...}]
  if (Array.isArray(body) && body.length === 1 && body[0] && body[0].error) {
    throw new Error("pg_rejected:" + body[0].error);
  }
  return body;
}

// ⑥ 审计
async function audit({ userId, userName, sql, finalSql, engine, rows, ms, err }) {
  try {
    await fetch(POSTGREST_URL + "/agent_query_logs", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        user_name: userName || null,
        query_text: sql,
        generated_sql: sql,
        final_sql: finalSql,
        data_source: engine,
        rows_returned: err ? 0 : rows || 0,
        execution_time_ms: ms,
      }),
    });
  } catch { /* 审计失败不影响主流程 */ }
}

// ===== 入口 =====
module.exports = async function (req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
  }
  const t0 = Date.now();
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const { sql, userId } = body;
  const key = body.agent_api_key || req.headers.get("x-agent-key");

  // ① 认证
  if (!AGENT_API_KEY || key !== AGENT_API_KEY) return json({ error: "unauthorized" }, 401);
  if (!sql || !userId) return json({ error: "missing sql/userId" }, 400);

  // ② 授权
  let perms;
  try {
    const pr = await fetch(POSTGREST_URL + "/rpc/get_user_perms", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await serviceJwt()), "Content-Type": "application/json" },
      body: JSON.stringify({ p_wecom_id: userId }),
    });
    perms = await pr.json();
  } catch (e) {
    return json({ error: "perm_resolve_failed", detail: String(e) }, 502);
  }
  if (!perms || perms.error || !Array.isArray(perms.branch_nums)) {
    return json({ error: "no_permission", detail: perms && perms.error }, 403);
  }

  // ③ SQL 白名单
  let finalSql;
  try {
    finalSql = validateSql(sql);
  } catch (e) {
    return json({ error: "sql_rejected", rule: e.message }, 400);
  }

  // ④/⑤ 引擎路由
  const engine = isReportQuery(sql) ? "pg" : "duckdb";
  let data, err;
  try {
    data = engine === "pg" ? await runPg(finalSql, userId, perms) : await runDuckdb(finalSql, perms);
  } catch (e) {
    err = String(e.message || e);
  }

  // ⑥ 审计
  await audit({
    userId, userName: perms.user_name, sql, finalSql, engine,
    rows: data && data.length, ms: Date.now() - t0, err,
  });

  if (err) return json({ error: err }, 500);
  return json({ success: true, engine, perms: { branch_nums: perms.branch_nums, can_see_cost: perms.can_see_cost }, rowCount: data.length, data });
};
