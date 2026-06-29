// functions/mcp/index.ts
// InsForge Edge Function (Deno runtime)
// MCP Server: 暴露数据分析平台能力给智能体 (openclaw 等)
// 协议：JSON-RPC 2.0 over HTTP
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS: MCPTool[] = [
  {
    name: "fetch-docs",
    description: "获取平台文档和数据结构说明",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list-reports",
    description: "列出用户可访问的报表",
    inputSchema: {
      type: "object",
      properties: {
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["user_token"],
    },
  },
  {
    name: "get-report",
    description: "获取指定报表的数据",
    inputSchema: {
      type: "object",
      properties: {
        report_name: { type: "string", description: "报表名称" },
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["report_name", "user_token"],
    },
  },
  {
    name: "query-table",
    description: "查询预设数据表",
    inputSchema: {
      type: "object",
      properties: {
        table_name: { type: "string", description: "表名" },
        filters: { type: "object", description: "过滤条件" },
        user_token: { type: "string", description: "用户认证 Token" },
      },
      required: ["table_name", "user_token"],
    },
  },
];

async function handleFetchDocs(): Promise<unknown> {
  return {
    platform: "数据分析平台",
    version: "1.0.0",
    dataSources: [
      { name: "销售数据", tables: ["sales_daily", "sales_orders"] },
      { name: "运营数据", tables: ["users_daily", "activity_logs"] },
    ],
    reports: [
      { name: "销售日报", id: "sales_daily" },
      { name: "运营周报", id: "ops_weekly" },
    ],
    usage: "使用 list-reports 查看可访问报表，get-report 获取报表数据",
  };
}

async function handleListReports(_userToken: string): Promise<unknown> {
  // TODO: 验证 Token 并查询用户可访问的报表
  return [
    { id: "1", name: "销售日报", updatedAt: "2026-06-29 10:30" },
    { id: "2", name: "运营周报", updatedAt: "2026-06-28 18:00" },
  ];
}

async function handleGetReport(
  reportName: string,
  _userToken: string,
): Promise<unknown> {
  // TODO: 验证权限并查询报表数据
  return {
    name: reportName,
    metrics: [
      { name: "销售额", value: 125000, unit: "元" },
      { name: "订单数", value: 328, unit: "单" },
    ],
    chartData: [
      { date: "2026-06-23", value: 12000 },
      { date: "2026-06-24", value: 15000 },
      { date: "2026-06-25", value: 18000 },
    ],
  };
}

async function handleQueryTable(
  tableName: string,
  filters: Record<string, unknown>,
  _userToken: string,
): Promise<unknown> {
  // TODO: 验证权限并查询数据
  return {
    table: tableName,
    filters,
    rows: [
      { id: 1, name: "示例数据 1" },
      { id: 2, name: "示例数据 2" },
    ],
    total: 2,
  };
}

async function handleRequest(req: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = req;

  try {
    let result: unknown;

    switch (method) {
      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments as Record<string, unknown>) || {};

        switch (toolName) {
          case "fetch-docs":
            result = await handleFetchDocs();
            break;
          case "list-reports":
            result = await handleListReports(toolArgs.user_token as string);
            break;
          case "get-report":
            result = await handleGetReport(
              toolArgs.report_name as string,
              toolArgs.user_token as string,
            );
            break;
          case "query-table":
            result = await handleQueryTable(
              toolArgs.table_name as string,
              toolArgs.filters as Record<string, unknown>,
              toolArgs.user_token as string,
            );
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.json();
  const response = await handleRequest(body as MCPRequest);

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
});
