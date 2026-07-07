// web/lib/notify.ts
// 企微告警通知 —— 薄客户端：统一走 functions/wecom-notify（架构文档 §7.1.1）。
// App B secret 单点存于 function secret；web 仅持 AGENT_API_KEY 做调用鉴权（compose 注入 web 容器）。
// notifyWecom(title, content) 签名不变，scheduler / collect-lemeng 调用点无需改动。
import { insforge } from "@/lib/insforge";

export async function notifyWecom(title: string, content: string) {
  const apiKey = process.env.AGENT_API_KEY;
  if (!apiKey) {
    console.warn("[notifyWecom] Missing AGENT_API_KEY（compose 未注入 web 容器？）");
    return;
  }
  try {
    const { data, error } = await insforge.functions.invoke("wecom-notify", {
      method: "POST",
      body: { agent_api_key: apiKey, title, content, msgtype: "markdown" },
    });
    if (error) {
      console.error("[notifyWecom] invoke error:", error);
      return;
    }
    if (data && data.ok) {
      console.log(`[notifyWecom] sent to ${data.sent_to}`);
    } else {
      console.error("[notifyWecom] send failed:", data);
    }
  } catch (err: any) {
    console.error("[notifyWecom] Error:", err.message);
  }
}
