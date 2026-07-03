/**
 * 乐檬cloud Token 提取书签脚本
 *
 * 使用方法：
 * 1. 在浏览器创建一个新书签
 * 2. 名称填写"提取乐檬Token"
 * 3. URL 粘贴以下代码（javascript: 开头）：
 *
 * javascript:(function(){var s=document.createElement('script');s.src='https://data.shanhaiyiguo.com/lemeng-token-extractor.js';document.body.appendChild(s);})();
 */

(function() {
  'use strict';

  let token = null;

  // 方法1：从 localStorage 提取
  const localStorageKeys = [
    'token',
    'access_token',
    'auth_token',
    'accessToken',
    'jwt',
    'jwt_token',
    'lemeng_token',
    'user_token'
  ];

  for (const key of localStorageKeys) {
    const value = localStorage.getItem(key);
    if (value && value.startsWith('eyJ')) { // JWT 以 eyJ 开头
      token = value;
      console.log(`找到 token 在 localStorage.${key}`);
      break;
    }
  }

  // 方法2：如果没找到，尝试解析 localStorage 中所有包含 token 的键
  if (!token) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value && value.includes('eyJ')) {
        // 可能是 JSON 字符串
        try {
          const parsed = JSON.parse(value);
          // 查找对象中所有可能的 token 字段
          const tokenFields = ['token', 'access_token', 'accessToken', 'auth_token'];
          for (const field of tokenFields) {
            if (parsed[field] && parsed[field].startsWith('eyJ')) {
              token = parsed[field];
              console.log(`找到 token 在 localStorage.${key}.${field}`);
              break;
            }
          }
        } catch (e) {
          // 不是 JSON，直接检查是否是 JWT
          if (value.startsWith('eyJ')) {
            token = value;
            console.log(`找到 token 在 localStorage.${key}`);
            break;
          }
        }
      }
    }
  }

  // 方法3：从 Cookie 提取
  if (!token) {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const [name, value] = cookie.trim().split('=');
      if (value && value.startsWith('eyJ')) {
        token = value;
        console.log(`找到 token 在 Cookie.${name}`);
        break;
      }
    }
  }

  // 方法4：从 sessionStorage 提取
  if (!token) {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      const value = sessionStorage.getItem(key);
      if (value && value.startsWith('eyJ')) {
        token = value;
        console.log(`找到 token 在 sessionStorage.${key}`);
        break;
      }
    }
  }

  // 结果处理
  if (token) {
    // 解析 JWT 过期时间
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expDate = new Date(payload.exp * 1000);
      const now = new Date();
      const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));

      // 复制到剪贴板
      navigator.clipboard.writeText(token).then(() => {
        alert(`✅ 乐檬 Token 已复制到剪贴板！

有效期：${daysLeft} 天后过期（${expDate.toLocaleDateString()}）
用户：${payload.user_name || payload.phone}

请回到数据分析平台粘贴使用。`);
      }).catch(err => {
        // 如果自动复制失败，显示文本让用户手动复制
        prompt(`✅ 找到乐檬 Token！

有效期：${daysLeft} 天后过期（${expDate.toLocaleDateString()}）
用户：${payload.user_name || payload.phone}

请手动复制下方 Token：`, token);
      });
    } catch (e) {
      // JWT 解析失败，直接复制
      navigator.clipboard.writeText(token).then(() => {
        alert('✅ 乐檬 Token 已复制到剪贴板！\n\n请回到数据分析平台粘贴使用。');
      }).catch(err => {
        prompt('✅ 找到乐檬 Token！\n\n请手动复制：', token);
      });
    }
  } else {
    alert('❌ 未找到乐檬 Token\n\n可能原因：\n1. 您还未登录乐檬系统\n2. Token 存储方式未知\n\n请确保您已登录乐檬后台，然后重试。');
  }
})();
