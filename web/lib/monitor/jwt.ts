// JWT payload 解码（不验签，仅读 claim；复用 collect.ts:16 的 base64url 解码模式）
export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
    const parts = raw.split('.');
    if (parts.length < 2) return null;
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/'); // base64url → base64
    while (p.length % 4) p += '=';                          // 补 padding
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
