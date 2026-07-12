# 乐檬页面请求抓取 bookmarklet

> 抓包服务已在本地 `http://localhost:9988` 运行（`scripts/capture-server.js`）。
> 用法：在乐檬页面（如「配送毛利」）打开浏览器 DevTools → Console，粘贴下面代码回车，然后正常操作页面（选日期、查询）。页面的 fetch/XHR 请求会被 hook 后 POST 到本地 :9988，终端实时打印。

## hook 代码（复制整段粘到 Console）

```js
(function(){
  const CAP='http://localhost:9988/capture';
  const send=(u,m,b)=>{if(/localhost|127\.0\.0\.1|capture/.test(u))return;try{fetch(CAP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:u,method:m,body:b})}).catch(()=>{})}catch(e){}};
  const of=window.fetch;window.fetch=function(u,o){o=o||{};const b=o.body;if(b&&(typeof b==='string'))send(u,o.method||'GET',b);return of.apply(this,arguments)};
  const oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this._u=u;this._m=m;return oo.apply(this,arguments)};
  XMLHttpRequest.prototype.send=function(b){if(this._u&&(typeof b==='string'))send(this._u,this._m,b);return os.apply(this,arguments)};
  console.log('✅ capture hook installed — 现在操作页面（选日期/查询），请求会打到 localhost:9988');
})();
```

## 操作步骤

1. 确认抓包服务已启动（本机终端跑 `node scripts/capture-server.js`，看到 `listening on :9988`）。
2. 浏览器打开乐檬「配送毛利」页面（`sharef.lemengcloud.com`）。
3. F12 → Console，粘贴上面 hook 代码，回车（看到 `✅ capture hook installed`）。
4. 在页面选一个**有数据的日期**（如 2026-07-12），点查询。
5. 抓包服务终端会打印 `========== CAPTURED ==========` + URL + BODY。

## 注意

- 乐檬是 https，post 到 http://localhost 是混合内容；Chrome/Edge 对 localhost 通常放行。若被拦，地址栏盾牌图标→允许不安全内容，或用 Firefox。
- hook 排除了 `localhost/127.0.0.1/capture`，不会递归抓自己的上报。
- 抓完把终端里的 `URL` + `BODY` 给我，我对比 `collect-delivery` 的 buildBody 找参数差异。
