# 企微通讯录回调接收（web/api 方案）设计 spec

> 架构依据：`docs/architecture.md` §7.1.2（已更新为 web/api 版）。
> 本文替代之前的 function 方案 spec（`2026-07-08-wecom-contact-realtime-sync-design.md` 的回调接收部分）。
> **2026-07-08 方案变更**：回调接收从 InsForge edge function 改为 web/api，因 InsForge gateway 把 raw XML body 吞成 `{}`（详见 memory `insforge-function-body-limit`）。

## 1. 背景

企微「通讯录同步」变更回调是 **XML body**（加密在 `<Encrypt>`）。已验证 InsForge edge function 接不了：
- InsForge gateway(7130) 对 function 请求 body 按 content-type 协商，**raw text/XML 吞成 `{}`**（仅 JSON 正常）
- 所有 function 共用 gateway，无解（OSS 改不了）
- 证据：直连 gateway(localhost:7130) 绕 nginx，POST text/xml 仍被吞

兜底全量同步（`functions/wecom-sync-contacts`）是 JSON 调用（web scheduler POST），不受影响，保留。仅**回调接收**这条实时链路要从 function 移到 web/api。

## 2. 方案

新建 `web/app/api/wecom-contacts-webhook/route.ts`（Next.js Route Handler，Node runtime）。Next.js 用标准 Web Request API，`await request.text()` 能读 raw XML body（不像 InsForge gateway 按 content-type 吞）。逻辑从已补全的 `functions/wecom-contacts-webhook/index.js` 搬运，适配 TS + Web Request + web 的写库方式。

## 3. 详细设计

### 3.1 route.ts（GET 验证 + POST 事件分派）

**GET**（企微保存回调 URL 时验证）：
- query：`msg_signature`、`timestamp`、`nonce`、`echostr`
- 校验 `sha1(sort([token, timestamp, nonce, echostr]))` === `msg_signature`（GET 签名含 echostr 原始密文）
- AES 解密 echostr → 明文
- 返明文 `text/plain`

**POST**（通讯录变更事件）：
- query：`msg_signature`、`timestamp`、`nonce`
- `await request.text()` 读 raw XML body
- regex 提取 `<Encrypt>` 密文
- 校验 `sha1(sort([token, timestamp, nonce, encrypt]))` === `msg_signature`
- AES 解密 → 校验 receiveid === `WECOM_CORP_ID` → parseXml 事件 XML
- 按 `ChangeType` 分派（见下表）
- 5s 内返 `success`（`text/plain`）

**事件分派表**（企微用 `party` 表示部门）：

| ChangeType | 处理 | 字段来源 |
|---|---|---|
| `create_user` / `update_user` | `user/get(userid)` 拉快照 → upsert `org_users`（is_active=true） | user/get 全量 |
| `delete_user` | `UPDATE org_users SET is_active=false WHERE wecom_id=userid` | 回调 UserID |
| `create_party` / `update_party` | upsert `org_departments`（is_active=true） | 回调 Id/Name/ParentId/Order |
| `delete_party` | `UPDATE org_departments SET is_active=false WHERE id=Id` | 回调 Id |
| 其它 | 记日志、返 success（不报错避免企微重试风暴） | — |

### 3.2 加解密（Node `crypto.subtle`，从 function 搬运）

- `deriveAesKey`：`base64decode(EncodingAESKey+"=")` → 32B；IV = key 前 16B
- `decrypt`：`crypto.subtle.decrypt({name:"AES-CBC",iv})` —— **已自动去 PKCS7 padding，勿手动 unpad**（2026-07-08 踩坑：手动 unpad 把 receiveid 尾字节当 pad 截断）；解密结构 `16B随机+4B len(BE)+msg+receiveid`，getUint32(16) 读 msgLen
- `sha1Hex`：`crypto.subtle.digest("SHA-1", ...)` → hex
- `parseXml` / `extractEncrypt`：regex（从 function 搬，CDATA + 简单字段兼容）

Node 18+ 全局 `crypto.subtle` 可用（Next.js Node runtime）。或 `import { webcrypto } from "node:crypto"`。

### 3.3 写库（web 现有 `@insforge/sdk` + ANON_KEY，不签 JWT）

web 是可信服务端，用现有方式：
```ts
const client = createClient({
  baseUrl: process.env.INSFORGE_API_BASE,
  anonKey: process.env.INSFORGE_API_KEY,  // = ANON_KEY（compose web env 行 21）
});
```
- `INSFORGE_API_KEY` 在 web 容器 = `${ANON_KEY}`（compose 行 21），anon 角色
- anon 对 `org_users`/`org_departments` 有 INSERT/SELECT/UPDATE（CLAUDE.md 常见问题 GRANT；sync-contacts function 也用 ANON_KEY upsert 验证可行）
- delete_user 的 `update is_active=false` 是 UPDATE，anon 有权限
- **不用签 JWT**（web 不像 function 要自证身份；anon 角色够用）

### 3.4 user/get 快照（App B secret）

create/update_user 时 `gettoken(WECOM_CORP_ID, WECOM_OPS_SECRET)` → `user/get(userid)` 拉权威全量再 upsert（回调零散字段不全，且 update 不保证触发，如昵称→实名）。delete_user 例外（直接软删）。

### 3.5 nginx 路由（关键：避开 /api 兜底）

现有 nginx：`/api/admin` `/api/auth` → web:3000；`/api` 兜底 → insforge:7130。`/api/wecom-contacts-webhook` 会被 `/api` 兜底送到 InsForge（又踩 body 限制）。

`deploy/nginx/server.conf.tpl` 加（在 `/api` location 之前/之后均可，nginx 最长前缀匹配优先）：
```nginx
location /api/wecom-contacts-webhook {
    proxy_pass http://web:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
`/api/wecom-contacts-webhook` 前缀长于 `/api`，nginx 最长前缀匹配会优先选这条 → web:3000。

### 3.6 secrets（注入 web 容器 compose env）

`deploy/docker-compose.prod.yml` web 服务 environment 加：
- `WECOM_TOKEN=${WECOM_TOKEN}`（回调验证解密）
- `WECOM_ENCODING_AES_KEY=${WECOM_ENCODING_AES_KEY}`（回调验证解密）
- `WECOM_OPS_SECRET=${WECOM_OPS_SECRET}`（user/get，App B）

`WECOM_CORP_ID` web 容器已有（compose 行 32）。route 经 `process.env` 读。

服务器 `deploy/.env` 已有 `WECOM_TOKEN`/`WECOM_ENCODING_AES_KEY`（之前 function 方案填的）/`WECOM_OPS_SECRET`。

### 3.7 废弃 function

`functions/wecom-contacts-webhook/` 删除（`git rm`）——逻辑移至 route.ts。InsForge 里注册的该 function 无人再调（企微回调改 web/api），可选 `DELETE /api/functions/wecom-contacts-webhook` 清理注册（非必须，留着无害）。

## 4. 文件清单

**新建**：
- `web/app/api/wecom-contacts-webhook/route.ts`（Next.js Route Handler，GET 验证 + POST 解密分派 + user/get + 软删除）

**修改**：
- `deploy/nginx/server.conf.tpl`——加 `location /api/wecom-contacts-webhook → web:3000`
- `deploy/docker-compose.prod.yml`——web env 加 `WECOM_TOKEN`/`WECOM_ENCODING_AES_KEY`/`WECOM_OPS_SECRET`

**删除**：
- `functions/wecom-contacts-webhook/`（git rm；逻辑移走）

**已更新**（本 spec 之前）：
- `docs/architecture.md` §7.1.2 + 功能矩阵（回调接收 → web/api）

## 5. 前置条件（已就绪）

- ✅ 企微后台「通讯录同步」已开启 + Token/EncodingAESKey 已生成（服务器 .env 有）
- ✅ 迁移 017（is_active 列）已上线
- ⏳ 部署后企微后台回调 URL 改 `https://data.shanhaiyiguo.com/api/wecom-contacts-webhook` + 重新 GET 验证

## 6. 部署与验证

**全走 GHA**（web route + nginx conf + compose env 都是非 function 改动）：
1. push → GHA（rsync + nginx reload + web 重建）
2. 验证 nginx 路由：`curl https://data.shanhaiyiguo.com/api/wecom-contacts-webhook`（GET 无参应返 400 missing params，说明到 web 非 InsForge）
3. 企微后台改回调 URL → GET 验证通过
4. e2e：改测试员工 position → 查 `docker logs deploy-web-1 | grep webhook`（update_user 事件）+ DB org_users 秒级更新
5. e2e delete_user：删测试员工 → DB 行在 + is_active=false

**本地 curl 自测**（部署后）：构造合法 echostr（用 Token/EncodingAESKey 加密）+ 签名，GET route，期望返明文（复刻企微 GET 验证，node 脚本同之前）。

## 7. 风险与回退

| 风险 | 缓解 |
|---|---|
| anon 角色 UPDATE 权限不足 | 迁移后实测；不足则 GRANT（CLAUDE.md 同款）或 route 改签 authenticated JWT（加 JWT_SECRET env） |
| nginx location 没生效（仍走 /api 兜底） | curl 测 /api/wecom-contacts-webhook 返 web 响应（400 missing params）而非 InsForge |
| route 5s 超时 | 处理 <600ms；超时企微重试，幂等安全 |
| 企微回调丢消息 | 每日全量兜底（sync-contacts，已上线 03:17 cron） |

**回退**：route 故障 → 企微后台关闭回调，回退纯全量（兜底 cron 仍跑）。

## 8. 不做（out of scope）

- 改 InsForge gateway 支持 XML body（OSS，不实际）
- 通讯录事件审计落表（YAGNI）
- 部门 department/get 补全（回调字段够）
- 已离职员工 retail_query_user_perms override 自动清理（业务决策，另议）
