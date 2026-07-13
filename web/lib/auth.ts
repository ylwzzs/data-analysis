// web/lib/auth.ts
// admin 白名单单一来源（消除 header.tsx 与 middleware.ts 的重复定义）
export const ADMIN_USERIDS = new Set(["ZhangDuo", "YangWei"]);

export function isAdmin(userid: string | null | undefined): boolean {
  return !!userid && ADMIN_USERIDS.has(userid);
}
