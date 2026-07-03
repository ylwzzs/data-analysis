# 乐檬 Token 提取书签

## 使用方法

### 步骤 1：添加书签

1. 在浏览器中右键书签栏 → 添加新书签
2. 名称填写：`提取乐檬Token`
3. URL/地址粘贴以下代码（完整复制）：

```
javascript:(function(){let t=null;const l=['token','access_token','auth_token','accessToken','jwt','jwt_token','lemeng_token','user_token'];for(const k of l){const v=localStorage.getItem(k);if(v&&v.startsWith('eyJ')){t=v;console.log('找到token在localStorage.'+k);break}}if(!t){for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);const v=localStorage.getItem(k);if(v&&v.includes('eyJ')){try{const p=JSON.parse(v);const f=['token','access_token','accessToken','auth_token'];for(const f1 of f){if(p[f1]&&p[f1].startsWith('eyJ')){t=p[f1];console.log('找到token在localStorage.'+k+'.'+f1);break}}}catch(e){if(v.startsWith('eyJ')){t=v;console.log('找到token在localStorage.'+k);break}}}}}if(!t){const c=document.cookie.split(';');for(const ck of c){const[n,v]=ck.trim().split('=');if(v&&v.startsWith('eyJ')){t=v;console.log('找到token在Cookie.'+n);break}}}if(!t){for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);const v=sessionStorage.getItem(k);if(v&&v.startsWith('eyJ')){t=v;console.log('找到token在sessionStorage.'+k);break}}}if(t){try{const p=JSON.parse(atob(t.split('.')[1]));const d=new Date(p.exp*1000);const n=new Date();const dl=Math.ceil((d-n)/(86400000));navigator.clipboard.writeText(t).then(()=>{alert('✅ 乐檬Token已复制！\n\n有效期：'+dl+'天后过期（'+d.toLocaleDateString()+'）\n用户：'+(p.user_name||p.phone)+'\n\n请回到数据分析平台粘贴使用。')}).catch(()=>{prompt('✅ 找到乐檬Token！\n\n有效期：'+dl+'天后过期\n用户：'+(p.user_name||p.phone)+'\n\n请手动复制：',t)})}catch(e){navigator.clipboard.writeText(t).then(()=>{alert('✅ 乐檬Token已复制到剪贴板！\n\n请回到数据分析平台粘贴使用。')}).catch(()=>{prompt('✅ 找到乐檬Token！\n\n请手动复制：',t)})}}else{alert('❌ 未找到乐檬Token\n\n可能原因：\n1. 您还未登录乐檬系统\n2. 请确保当前页面是乐檬后台页面\n\n请先登录乐檬系统，然后重试。')} })();
```

### 步骤 2：登录乐檬系统

访问 https://account.lemengcloud.com/ 并登录

### 步骤 3：提取 Token

1. 确保停留在乐檬管理后台页面
2. 点击刚才添加的书签"提取乐檬Token"
3. Token 自动复制到剪贴板
4. 回到数据分析平台粘贴

## 常见问题

### Q: 提示"未找到乐檬 Token"？

确保：
1. 已在乐檬系统中登录
2. 当前页面 URL 是 `*.lemengcloud.com` 或 `*.lemeng.center`
3. 不要在微信扫码登录页点击（要等登录成功后）

### Q: Token 有效期多久？

约 5 天，过期需重新提取

### Q: 添加书签失败？

Chrome 浏览器：
1. Ctrl/Cmd + Shift + B 显示书签栏
2. 右键书签栏 → 添加书签
3. 粘贴名称和 URL

其他浏览器类似操作。

---

**完整代码（开发参考）：**

```javascript
(function() {
  'use strict';

  let token = null;

  // 方法1：从 localStorage 常见键名提取
  const localStorageKeys = [
    'token', 'access_token', 'auth_token', 'accessToken',
    'jwt', 'jwt_token', 'lemeng_token', 'user_token'
  ];

  for (const key of localStorageKeys) {
    const value = localStorage.getItem(key);
    if (value && value.startsWith('eyJ')) {
      token = value;
      console.log(`找到 token 在 localStorage.${key}`);
      break;
    }
  }

  // 方法2：遍历所有 localStorage
  if (!token) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (value && value.includes('eyJ')) {
        try {
          const parsed = JSON.parse(value);
          const tokenFields = ['token', 'access_token', 'accessToken', 'auth_token'];
          for (const field of tokenFields) {
            if (parsed[field] && parsed[field].startsWith('eyJ')) {
              token = parsed[field];
              console.log(`找到 token 在 localStorage.${key}.${field}`);
              break;
            }
          }
        } catch (e) {
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
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const expDate = new Date(payload.exp * 1000);
      const now = new Date();
      const daysLeft = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));

      navigator.clipboard.writeText(token).then(() => {
        alert(`✅ 乐檬 Token 已复制！

有效期：${daysLeft} 天后过期（${expDate.toLocaleDateString()}）
用户：${payload.user_name || payload.phone}

请回到数据分析平台粘贴使用。`);
      }).catch(() => {
        prompt(`✅ 找到乐檬 Token！

有效期：${daysLeft} 天后过期
用户：${payload.user_name || payload.phone}

请手动复制下方 Token：`, token);
      });
    } catch (e) {
      navigator.clipboard.writeText(token).then(() => {
        alert('✅ 乐檬 Token 已复制到剪贴板！\n\n请回到数据分析平台粘贴使用。');
      }).catch(() => {
        prompt('✅ 找到乐檬 Token！\n\n请手动复制：', token);
      });
    }
  } else {
    alert('❌ 未找到乐檬 Token\n\n可能原因：\n1. 您还未登录乐檬系统\n2. 请确保当前页面是乐檬后台页面\n\n请先登录乐檬系统，然后重试。');
  }
})();
```
