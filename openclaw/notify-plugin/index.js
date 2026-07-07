// openclaw/notify-plugin/index.js
// 统一通知工具（架构文档 §7.1.1）：OpenClaw 主动发企微通知时调用，
// 转发到 wecom-notify function（App B / Agent 1000009 发送）。
//
// 注册形式对齐同实例已验证的 data-query 插件：api.registerTool(factory, { name })。
// - name 放第二参数 metadata（运行时注册 + 模型发现都靠它；放 factory 返回里会被判 malformed）。
// - factory 每轮调用，从 ctx.requesterSenderId 取可信企微 userid（核心注入，非 LLM 传），
//   用于解析 "@sender" 收件人。execute 闭包捕获当轮 senderId。
// - AGENT_API_KEY 留 openclaw 容器 env（compose 注入，同 data-query），不进 LLM/用户上下文。
// - NOTIFY_URL 默认 http://insforge:7130/functions/wecom-notify（与 agent-query 同 host）。
//
// 依赖：仅 openclaw 运行时（definePluginEntry 由 loader 解析）。无 typebox 等 npm 依赖。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const NOTIFY_URL =
  process.env.NOTIFY_URL || "http://insforge:7130/functions/wecom-notify";

const TOOL_NAME = "send_notify";
const TOOL_DESC =
  "向企业微信发送一条通知消息（由系统统一通知服务 App B 发送）。用于需要主动通知的场景：" +
  "采集完成/异常告警、定时汇报、或用户明确要求通知/提醒某人。普通对话回复不要用此工具。" +
  "默认发给系统管理员组（NOTIFY_DEFAULT_TUSERS）；可指定收件人。详见 notify skill。";
const TOOL_PARAMS = {
  type: "object",
  properties: {
    content: {
      type: "string",
      description:
        "消息正文（markdown）。简洁，直接写要通知的事，不要写'我来通知你'之类的铺垫。",
    },
    title: {
      type: "string",
      description: "消息标题（markdown 三级标题）。默认'通知'。",
    },
    touser: {
      type: "string",
      description:
        "收件人 userid。省略=管理员组（默认）；'@sender'=发给当前提问的用户；具体 userid（如 ZhangDuo）=发给该人；'@all'=全员广播（慎用）。",
    },
    msgtype: {
      type: "string",
      enum: ["markdown", "text", "textcard"],
      description: "消息类型，默认 markdown。",
    },
  },
  required: ["content"],
  additionalProperties: false,
};

async function sendNotify({ content, title, touser, msgtype }, senderId) {
  const agentApiKey = process.env.AGENT_API_KEY;
  if (!agentApiKey) {
    return {
      error:
        "通知服务密钥未配置（openclaw 容器缺 AGENT_API_KEY env），请联系管理员。",
    };
  }
  if (!content || typeof content !== "string") {
    return { error: "content 必填（消息正文）" };
  }

  // "@sender" → 当前可信 userid（核心注入，非 LLM 传）
  let to = touser;
  if (touser === "@sender") {
    if (!senderId) {
      return {
        error:
          "无法识别当前用户身份（requesterSenderId 缺失），不能解析 @sender。",
      };
    }
    to = senderId;
  }

  let resp;
  try {
    resp = await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_api_key: agentApiKey,
        content,
        title,
        touser: to,
        msgtype,
      }),
    });
  } catch (e) {
    return { error: "通知服务不可达：" + ((e && e.message) || String(e)) };
  }

  let body = {};
  try {
    body = await resp.json();
  } catch {
    body = {};
  }

  if (!resp.ok || body.ok !== true) {
    return {
      error: body.error || "通知服务返回 HTTP " + resp.status,
      errcode: body.errcode,
      errmsg: body.errmsg,
    };
  }
  return { ok: true, sent_to: body.sent_to };
}

export default definePluginEntry({
  id: "notify",
  name: "Notify",
  description:
    "统一通知出口：OpenClaw 主动发企微通知时调用，转发到 wecom-notify function（App B 发送）。",
  register(api) {
    api.registerTool(
      (ctx) => {
        const senderId = ctx && ctx.requesterSenderId;
        // 首次调用打一行诊断（确认 sender 注入路径，同 data-query）。
        if (!globalThis.__NOTIFY_DIAG) {
          globalThis.__NOTIFY_DIAG = 1;
          // eslint-disable-next-line no-console
          console.log(
            "[notify] diag ctxKeys=" +
              (ctx ? Object.keys(ctx).join(",") : "none") +
              " senderId=" +
              (senderId || "<empty>") +
              " notifyUrl=" +
              NOTIFY_URL,
          );
        }
        return {
          name: TOOL_NAME,
          description: TOOL_DESC,
          parameters: TOOL_PARAMS,
          // execute 签名实测定稿（同 data-query，agent-tools.before-tool-call.js:1510）：
          //   execute(toolCallId, params, signal, onUpdate)
          // 第一个参数是 toolCallId（字符串"id"），第二个才是模型传的参数对象。
          // 这里兼容 params 为对象 / JSON 字符串 / 包一层 input|arguments|parameters。
          execute: (toolCallId, params, _signal, _onUpdate) => {
            let raw = params;
            if (typeof raw === "string") {
              try {
                raw = JSON.parse(raw);
              } catch {
                raw = { content: raw };
              }
            }
            const obj = raw && typeof raw === "object" ? raw : {};
            const content =
              obj.content ??
              (obj.input && obj.input.content) ??
              (obj.arguments && obj.arguments.content) ??
              (obj.parameters && obj.parameters.content);
            return sendNotify(
              {
                content,
                title: obj.title,
                touser: obj.touser,
                msgtype: obj.msgtype,
              },
              senderId,
            );
          },
        };
      },
      { name: TOOL_NAME },
    );
  },
});
