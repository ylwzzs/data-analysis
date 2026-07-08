import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from '../jwt';

describe('decodeJwtPayload', () => {
  it('解出 payload 各字段', () => {
    // payload {"company_id":3120,"exp":1800000000} → base64url
    const payload = Buffer.from(JSON.stringify({ company_id: 3120, exp: 1800000000 })).toString('base64url');
    const token = `header.${payload}.sig`;
    expect(decodeJwtPayload(token)).toEqual({ company_id: 3120, exp: 1800000000 });
  });

  it('带 Bearer 前缀也能解', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 123 })).toString('base64url');
    expect(decodeJwtPayload(`Bearer a.${payload}.b`)?.exp).toBe(123);
  });

  it('非法 token 返回 null', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});
