import { createClient } from "@insforge/sdk";

// InsForge 单例 client。前端用 anon_key 经 PostgREST 匿名读取业务表。
// 真实 URL/key 写在 web/.env.local（不入库）。
export const insforge = createClient({
  baseUrl: process.env.NEXT_PUBLIC_INSFORGE_URL!,
  anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
});
