# 乐檬 Token 提取书签（抓"正在使用"的活 token）

旧版从 localStorage 按 exp 最大挑 token，会抓到残留的失效旧 token（30 天有效期的死 token 长期占着 exp 最大位）。本版改为**拦截页面实际发出的请求**，从 `Authorization` 头里取 app 此刻真正在用的 token —— 一定是活的。

## 书签代码（一整行）

复制下面代码框整段，粘到书签的"网址"字段：

```
javascript:(function(){'use strict';function decode(tok){try{var raw=tok.indexOf(' ')>=0?tok.split(' ').pop():tok;var parts=raw.split('.');if(parts.length<2)return null;var p=parts[1].replace(/-/g,'+').replace(/_/g,'/');while(p.length%4)p+='=';return JSON.parse(atob(p));}catch(e){return null;}}function extractAuth(h){if(!h)return null;try{if(typeof h.get==='function')return h.get('Authorization')||h.get('authorization');if(Array.isArray(h)){for(var i=0;i<h.length;i++){var x=h[i]||[];if(String(x[0]).toLowerCase()==='authorization')return x[1];}}for(var k in h){if(Object.prototype.hasOwnProperty.call(h,k)&&k.toLowerCase()==='authorization')return h[k];}}catch(e){}return null;}function showToken(){var tok=window.__lmLiveToken;if(!tok)return false;var c=decode(tok)||{};var jti=c.jti?String(c.jti).slice(0,8):'?';var msg='已捕获【app 正在使用】的活 token（来自实际请求）\n\n品牌 company_id：'+(c.company_id||'?')+'\njti：'+jti+'…\n用户：'+(c.user_name||c.phone||'-')+'\n来源：'+String(window.__lmLiveUrl||'').slice(0,70)+'\n\n已复制到剪贴板，请粘贴给小助手。';try{navigator.clipboard.writeText(tok).then(function(){alert(msg);},function(){prompt(msg+'\n（自动复制失败，手动复制：）',tok);});}catch(e){prompt(msg+'\n（手动复制：）',tok);}return true;}function capture(tok,url){if(!tok||window.__lmLiveToken)return;window.__lmLiveToken=tok;window.__lmLiveUrl=url||'';setTimeout(showToken,0);}if(!window.__lmHooked){window.__lmHooked=true;var origFetch=window.fetch;if(origFetch){window.fetch=function(input,init){try{var url=typeof input==='string'?input:(input&&input.url)||'';var a=extractAuth((init&&init.headers)||(input&&input.headers));if(a&&url.indexOf('earth-gateway')>=0)capture(a,url);}catch(e){}return origFetch.apply(this,arguments);};}var XS=XMLHttpRequest.prototype;var osh=XS.setRequestHeader;XS.setRequestHeader=function(name,value){try{if(name&&String(name).toLowerCase()==='authorization')this.__lmA=value;}catch(e){}return osh.apply(this,arguments);};var osd=XS.send;XS.send=function(){try{if(this.__lmA)capture(this.__lmA,'');}catch(e){}return osd.apply(this,arguments);};}if(!showToken()){alert('已开启请求监听（仅当前标签页有效）。\n\n现在请在乐檬页面上点一下菜单/切换页面触发一条请求；\napp 实际使用的活 token 会被自动捕获并弹出，并复制到剪贴板。\n\n请勿整页刷新（会清除监听），用 SPA 内的点击即可。');}})();
```

## 使用步骤

1. 在乐檬前台**切到要提取的品牌**（如 64188），停在后台页面
2. 点书签 → 弹出"已开启请求监听"
3. **在页面上点一下菜单 / 切换页面**（触发一条请求；**不要整页刷新**，否则监听失效要重点书签）
4. 捕获到后自动弹框，显示 `品牌 company_id` + `jti`（前 8 位），并把活 token 复制到剪贴板
5. 粘贴给小助手

> 判别是否拿到新 token：看弹框里的 **jti**。死掉的 64188 token 是 `3527f7a2…`，活的一定是别的值。

## 原理

- 挂钩 `window.fetch` 与 `XMLHttpRequest.setRequestHeader/send`，拦截发往 `earth-gateway` 的请求，读其 `Authorization` 头。
- 只记第一次捕获到的，立即解码 payload 取 `company_id`/`jti` 显示，并复制原 token。
- 监听器只存在于当前标签页内存，整页刷新即失效（再次点击书签可重新开启）。

## Token 有效期

约 5 天（普通）/ 30 天（ADMIN），过期需重新提取。
