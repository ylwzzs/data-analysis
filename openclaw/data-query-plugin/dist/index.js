// openclaw/data-query-plugin/dist/index.js
// 零售数据查询工具（架构文档 docs/architecture.md §4.3）。
//
// 注册形式对齐同实例已验证的 wecom 插件：api.registerTool(factory, { name })。
// - name 放第二参数 metadata（运行时注册 + 模型发现都靠它；放 factory 返回里会被判 malformed）。
// - factory 每轮调用，从 ctx.requesterSenderId 取可信企微 userid（核心注入，非 LLM 传；
//   远程 MCP 拿不到 → 必须用 native plugin）。execute 闭包捕获当轮 userId。
// - userid + SQL 转发 agent-query 网关（§4.2）做按人鉴权。AGENT_API_KEY 留容器 env 不进 LLM。
//
// 依赖：仅 openclaw 运行时（definePluginEntry 由 loader 解析）。无 typebox 等 npm 依赖。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const GATEWAY_URL =
  process.env.AGENT_QUERY_URL || "http://insforge:7130/functions/agent-query";
const MAX_ROWS_TO_MODEL = 50;

const TOOL_NAME = "query_retail_data";
const TOOL_DESC =
  "查询零售销售数据。可直接查明细视图 retail_detail（乐檬 POS 订单明细），" +
  "或查汇总表 report_daily_sales / report_daily_category / report_weekly_trend。" +
  "只允许 SELECT。门店与成本列按当前用户权限自动过滤/脱敏，无需也不能在 SQL 里写权限条件。" +
  "调用前请参考 retail-query skill 了解可用列与写法。";
const TOOL_PARAMS = {
  type: "object",
  properties: {
    sql: {
      type: "string",
      description:
        "单条 SELECT 语句。明细查 retail_detail，汇总查 report_* 表。不要写 read_parquet/DDL/DML。无 LIMIT 时网关自动补 LIMIT 1000。",
    },
  },
  required: ["sql"],
  additionalProperties: false,
};

// ===== list_datasets 工具：拉活字典（数据集/列/敏感度/JOIN提示/日期列）=====
const LIST_TOOL_NAME = "list_datasets";
const LIST_TOOL_DESC =
  "列出当前可查的数据集（明细/汇总/维表）及其列、成本敏感标记、JOIN 提示、日期列与格式。" +
  "会话首次查询前调一次，了解能用哪些表/列、哪些列成本敏感（无权限会返回 NULL）。" +
  "可用表/列以此返回为准，勿凭记忆。";
const LIST_TOOL_PARAMS = { type: "object", properties: {}, additionalProperties: false };

async function fetchDictionary(userId) {
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!agentApiKey) return { error: "网关密钥未配置（openclaw 容器缺 AGENT_API_KEY env）。" };
  let resp;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "dictionary", userId, agent_api_key: agentApiKey }),
    });
  } catch (e) {
    return { error: "查询网关不可达：" + ((e && e.message) || String(e)) };
  }
  let body = {};
  try { body = await resp.json(); } catch { body = {}; }
  if (!resp.ok || body.success !== true) return { error: body.error || "网关返回 HTTP " + resp.status };
  return body.dictionary;
}

async function executeQuery({ sql }, userId) {
  const agentApiKey = process.env.AGENT_API_KEY;

  if (!agentApiKey) {
    return {
      error: "网关密钥未配置（openclaw 容器缺 AGENT_API_KEY env），请联系管理员。",
    };
  }
  if (!userId) {
    return {
      error: "无法识别请求者身份（requesterSenderId 缺失），出于权限安全不予查询。",
    };
  }

  let resp;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, userId, agent_api_key: agentApiKey }),
    });
  } catch (e) {
    return { error: "查询网关不可达：" + ((e && e.message) || String(e)) };
  }

  let body = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }

  if (!resp.ok || body.success !== true) {
    const rule = body.rule || undefined;
    let hint;
    if (rule === "only_select_allowed") hint = "只允许 SELECT 语句。";
    else if (rule && String(rule).startsWith("forbidden_statement"))
      hint =
        "该关键词被禁止（" + rule + "）。明细请查 retail_detail 视图，不要用 read_parquet。";
    else if (body.error === "no_permission") hint = "你当前没有数据查询权限。";
    return { error: body.error || "网关返回 HTTP " + resp.status, rule, hint };
  }

  const data = Array.isArray(body.data) ? body.data : [];
  const trimmed = data.slice(0, MAX_ROWS_TO_MODEL);
  return {
    engine: body.engine,
    rowCount: body.rowCount != null ? body.rowCount : data.length,
    perms: body.perms,
    rows: trimmed,
    truncated: data.length > MAX_ROWS_TO_MODEL,
    note:
      data.length > MAX_ROWS_TO_MODEL
        ? "仅返回前 " +
          MAX_ROWS_TO_MODEL +
          " 行（共 " +
          data.length +
          " 行）。如需精确数字请用聚合（count/sum），或加 LIMIT。"
        : undefined,
  };
}

export default definePluginEntry({
  id: "data-query",
  name: "Retail Data Query",
  description:
    "零售数据查询：携带可信企微 userid 转发到 agent-query 网关，按用户权限返回零售明细与汇总表。",
  register(api) {
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        // 首次调用打一行诊断（确认 sender 注入路径）。
        if (!globalThis.__DQ_DIAG) {
          globalThis.__DQ_DIAG = 1;
          // eslint-disable-next-line no-console
          console.log(
            "[data-query] diag ctxKeys=" +
              (ctx ? Object.keys(ctx).join(",") : "none") +
              " userId=" +
              (userId || "<empty>") +
              " gateway=" +
              GATEWAY_URL,
          );
        }
        return {
          name: TOOL_NAME,
          description: TOOL_DESC,
          parameters: TOOL_PARAMS,
          // execute 签名实测定稿（agent-tools.before-tool-call.js:1510）：
          //   execute(toolCallId, params, signal, onUpdate)
          // 第一个参数是 toolCallId（字符串"id"），第二个才是模型传的参数对象。
          // 之前误写成 (args) => 把 toolCallId 当成 params，导致 sql 恒为 undefined
          // → 网关收到无 sql 的 body → "missing sql/userId"（每次必现，非编造）。
          // 这里兼容 params 为对象 / JSON 字符串 / 包一层 input|arguments|parameters。
          execute: (toolCallId, params, _signal, _onUpdate) => {
            let raw = params;
            if (typeof raw === "string") {
              try {
                raw = JSON.parse(raw);
              } catch {
                raw = { sql: raw };
              }
            }
            const obj = raw && typeof raw === "object" ? raw : {};
            const sql =
              obj.sql ??
              (obj.input && obj.input.sql) ??
              (obj.arguments && obj.arguments.sql) ??
              (obj.parameters && obj.parameters.sql);
            if (!globalThis.__DQ_EXEC_DIAG) {
              globalThis.__DQ_EXEC_DIAG = 1;
              // eslint-disable-next-line no-console
              console.log(
                "[data-query] exec diag toolCallId=" +
                  (toolCallId || "<empty>") +
                  " paramsType=" +
                  (params === undefined ? "undef" : typeof params) +
                  " paramsKeys=" +
                  (obj && typeof obj === "object"
                    ? Object.keys(obj).join(",")
                    : "<n/a>") +
                  " sqlLen=" +
                  (sql ? sql.length : 0) +
                  " userId=" +
                  (userId || "<empty>"),
              );
            }
            return executeQuery({ sql }, userId);
          },
        };
      },
      { name: TOOL_NAME },
    );

    // list_datasets：拉活字典（转发 agent-query 的 dictionary 模式）
    api.registerTool(
      (ctx) => {
        const userId = ctx && ctx.requesterSenderId;
        return {
          name: LIST_TOOL_NAME,
          description: LIST_TOOL_DESC,
          parameters: LIST_TOOL_PARAMS,
          execute: () => fetchDictionary(userId),
        };
      },
      { name: LIST_TOOL_NAME },
    );
  },
});
