/**
 * 乐檬cloud Token 提取书签脚本
 *
 * 使用方法：
 * 1. 在浏览器创建一个新书签
 * 2. 名称填写"提取乐檬Token"
 * 3. URL 粘贴以下代码（javascript: 开头）：
 *
 * javascript:(function(){var s=document.createElement('script');s.src='https://data.shanhaiyiguo.com/lemeng-token-extractor.js';document.body.appendChild(s);})();
 *
 * 注意：乐檬 SPA 可能在 localStorage 里存多个 token（旧的+新的）。
 * 本脚本遍历所有候选、解码 exp、取【最新（exp 最大）】的那个，避免抓到已失效的旧值。
 */

(function() {
  'use strict';

  const candidates = []; // { token, exp, key, payload }

  function addIfJwt(raw, key) {
    if (!raw || typeof raw !== 'string' || !raw.startsWith('eyJ')) return;
    // 截到完整三段 JWT（去掉可能的 Bearer 前缀或尾部多余字符）
    const m = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (!m) return;
    try {
      const payload = JSON.parse(atob(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      candidates.push({ token: m[0], exp: payload.exp || 0, key, payload });
    } catch (e) { /* 非 JWT，忽略 */ }
  }

  function tryAdd(value, key) {
    if (!value || typeof value !== 'string') return;
    addIfJwt(value, key); // 直接是 JWT
    if (value.includes('{')) { // 或 JSON 里含 token 字段
      try {
        const parsed = JSON.parse(value);
        const fields = ['token', 'access_token', 'accessToken', 'auth_token', 'jwt', 'jwt_token'];
        for (const f of fields) {
          if (parsed[f]) addIfJwt(parsed[f], key + '.' + f);
        }
      } catch (e) { /* 非 JSON，忽略 */ }
    }
  }

  // 扫描 localStorage / sessionStorage / cookie
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    tryAdd(localStorage.getItem(k), 'localStorage.' + k);
  }
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    tryAdd(sessionStorage.getItem(k), 'sessionStorage.' + k);
  }
  document.cookie.split(';').forEach(function(c) {
    const p = c.trim().split('=');
    if (p[1]) tryAdd(p[1], 'cookie.' + p[0]);
  });

  if (candidates.length === 0) {
    alert('❌ 未找到乐檬 Token\n\n可能原因：\n1. 您还未登录乐檬系统\n2. Token 存储方式未知\n\n请确保您已登录乐檬后台，然后重试。');
    return;
  }

  // 取 exp 最大（最新、有效期最久）的 token
  candidates.sort(function(a, b) { return (b.exp || 0) - (a.exp || 0); });
  const best = candidates[0];
  const nowSec = Date.now() / 1000;
  const expDate = new Date(best.exp * 1000);
  const daysLeft = Math.ceil((best.exp - nowSec) / 86400);
  const list = candidates.map(function(c) {
    return '  · ' + c.key + ' (exp ' + new Date(c.exp * 1000).toLocaleString() + ')';
  }).join('\n');

  const msg = '✅ 最新乐檬 Token 已复制（共找到 ' + candidates.length + ' 个，已选 exp 最大的）\n\n' +
    '来源：' + best.key + '\n' +
    '用户：' + (best.payload.user_name || best.payload.phone || '-') + '\n' +
    '有效期：' + (daysLeft > 0 ? daysLeft + ' 天' : '已过期！') + '（' + expDate.toLocaleString() + '）\n\n' +
    '其他候选：\n' + list + '\n\n请回到数据分析平台粘贴使用。';

  navigator.clipboard.writeText(best.token).then(function() {
    alert(msg);
  }).catch(function() {
    prompt(msg + '\n\n（自动复制失败，请手动复制下方 Token：）', best.token);
  });
})();
