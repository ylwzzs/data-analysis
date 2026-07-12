// scripts/capture-server.js
// 抓包服务：监听 9988，记录 bookmarklet POST 来的请求(url+method+body)，CORS 全开
// 用法：node scripts/capture-server.js  （配合 docs/lemeng-capture-bookmarklet.md 的 hook）
const http = require('http');
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (body) {
      console.log('\n========== CAPTURED @ ' + new Date().toISOString() + ' (' + req.url + ') ==========');
      try {
        const j = JSON.parse(body);
        console.log('TYPE:', j.type);
        console.log('URL:', j.url);
        console.log('METHOD:', j.method);
        console.log('BODY:', j.body);
        if (j.response) console.log('RESP[' + j.status + ']:', String(j.response).slice(0, 500));
      } catch (e) {
        console.log('RAW:', body);
      }
      console.log('==========================================\n');
    }
    res.end('ok');
  });
});
server.listen(9988, '0.0.0.0', () => console.log('capture server listening on http://localhost:9988 (POST /capture)'));
