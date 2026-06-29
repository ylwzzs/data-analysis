// 企业微信 OAuth 辅助（H5 网页授权 snsapi_base）
// 真实联调待「可信回调域名」就绪（企微后台配置 + 公网可达）。
import { insforge } from "@/lib/insforge";

// 构造企微授权 URL。未配置 CORPID/AGENT_ID 时返回空串（UI 可隐藏入口）。
export function buildWecomAuthUrl(redirectUri: string, state = "insforge"): string {
  const corpId = process.env.NEXT_PUBLIC_WECOM_CORP_ID;
  const agentId = process.env.NEXT_PUBLIC_WECOM_AGENT_ID;
  if (!corpId || !agentId) return "";
  const params = new URLSearchParams({
    appid: corpId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "snsapi_base",
    state,
    agentid: agentId,
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

// 调用 wecom-oauth edge function，用 code 换企微 userid / 会话。
export async function exchangeWecomCode(code: string) {
  const { data, error } = await insforge.functions.invoke("wecom-oauth", {
    method: "POST",
    body: { code },
  });
  return { data, error };
}
