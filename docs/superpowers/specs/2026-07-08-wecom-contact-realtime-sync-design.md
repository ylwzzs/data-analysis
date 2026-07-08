# 企微通讯录实时同步（回调 + 兜底全量）设计 spec

> 架构依据：`docs/architecture.md` §7.1 / §7.1.2（已更新）。
> 本文是实现 spec，供 writing-plans 拆任务、子代理逐任务实现。

## 1. 背景与目标

当前通讯录同步是**全量拉取**（`functions/wecom-sync-contacts`：`department/list` + 遍历 `user/list` → upsert `org_users`/`org_departments`），且**无自动调度**（全仓 grep 无触发点，疑似纯手动 curl）。问题：

- **延迟不可控**：员工入职/离职/改部门，要等下次手动同步才反映到库；最长可能数天。
- **企微"邀请→微信昵称→实名"字段漂移**：邀请阶段 name=微信昵称，实名后变正式名字；全量间隔越长，昵称在系统里滞留越久。
- **无一致性保证**：手动同步易遗忘，库与企微逐步偏离。

**目标**：通讯录变更秒级入库（回调）+ 每日全量兜底自愈（纠正回调漏的一切漂移）。双轨互为补偿，非二选一。

## 2. 方案（C：回调 + 兜底全量）

| 机制 | 职责 | 触发 | 延迟 |
|---|---|---|---|
| **回调** `functions/wecom-contact-callback`（新） | 实时增量：create/update/delete → upsert/软删 | 企微 `change_contact` 事件推送 | 秒级 |
| **全量兜底** `functions/wecom-sync-contacts`（改造） | 自愈：纠正回调漏消息 + is_active 对齐 + name 漂移纠正 | web cron 每日 03:17 | 次日 |

单一机制都不够：回调会丢消息且 `update_user` 不保证覆盖所有字段变更；全量有延迟。故双轨。

## 3. 详细设计

### 3.1 回调 function `functions/wecom-contact-callback/index.js`

企微「通讯录同步」功能配回调 URL 后，企微会向同一路由发 GET（验证）和 POST（事件）。

**GET 验证**（企微保存回调 URL 时触发一次）：
- query：`msg_signature`、`timestamp`、`nonce`、`echostr`
- 校验 `sha1(sort([token, timestamp, nonce, echostr]))` === `msg_signature`（注意：GET 验证签名包含 `echostr` 原始密文串）
- AES 解密 `echostr` → 明文
- **返回明文纯文本**（`Content-Type: text/plain`，不是 JSON、不是 XML）

**POST 事件**（通讯录每次变更）：
- query：`msg_signature`、`timestamp`、`nonce`
- body：`text/xml`，含 `<Encrypt>` 字段（**不能用 `req.json()`**，用 `req.text()` 手解析）
- 步骤：
  1. regex 提取 `<Encrypt><![CDATA[...]]></Encrypt>` 的密文
  2. 校验 `sha1(sort([token, timestamp, nonce, encrypt]))` === `msg_signature`
  3. AES 解密 encrypt → 事件 XML（结构 `16B随机 + 4B长度(BE) + msg + receiveid`）
  4. 校验 `receiveid` === `WECOM_CORP_ID`（防伪造）
  5. regex 解析事件 XML 的 `<ChangeType>` 与业务字段
  6. 按 ChangeType 分派（见下表）
  7. **5s 内返回字符串 `success`**（`Content-Type: text/plain`）；超时企微会重试

**事件分派表**：

| ChangeType | 处理 | 字段来源 |
|---|---|---|
| `create_user` | `user/get(userid)` 拉快照 → upsert `org_users`（`is_active=true`） | user/get 全量 |
| `update_user` | `user/get(userid)` 拉快照 → upsert `org_users`（`is_active=true`） | user/get 全量（**不信任回调带的零散字段**） |
| `delete_user` | `UPDATE org_users SET is_active=false WHERE wecom_id=userid` | 回调带的 UserID（人已删，无法 get） |
| `create_department` | upsert `org_departments`（`is_active=true`） | 回调带的 Id/Name/ParentId/Order |
| `update_department` | upsert `org_departments` | 回调带的 Id/Name/ParentId/Order |
| `delete_department` | `UPDATE org_departments SET is_active=false WHERE id=Id` | 回调带的 Id |
| 其它/未知 ChangeType | 记日志、返回 success（不报错，避免企微重试风暴） | — |

**关键：create/update_user 补 `user/get`**。回调的 `update_user` 只带"变化字段"且不保证触发（典型：微信昵称→实名有时不触发 update）。故一律用回调里的 `UserID` 调 `user/get` 拉权威全量快照，再用快照 upsert。回调只当"谁变了"的通知。

### 3.2 加解密协议（企微 WXBizMsgCrypt，Deno Web Crypto 手写，零依赖）

InsForge OSS runtime = Deno + CommonJS + 全局 `Deno`/`createClient`。Web Crypto 经全局 `crypto.subtle` 可用。

**密钥派生**：
- `aesKey = base64decode(EncodingAESKey + "=")` → 32 字节（EncodingAESKey 是企微后台给的 43 字符串）
- `iv = aesKey.slice(0, 16)` → 16 字节

**AES-256-CBC 解密**：
```js
const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, cipherBytes);
// PKCS7 unpad
const buf = new Uint8Array(plain);
const pad = buf[buf.length - 1];
const unpadded = buf.subarray(0, buf.length - pad);
// 结构：16B 随机 + 4B msg_len(大端) + msg + receiveid
const msgLen = new DataView(plain).getUint32(16);
const msg = new TextDecoder().decode(unpadded.subarray(20, 20 + msgLen));
const receiveid = new TextDecoder().decode(unpadded.subarray(20 + msgLen));
```

**签名校验**（SHA-1）：
```js
const sorted = [token, timestamp, nonce, encrypt].sort().join("");
const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sorted));
const sig = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
// sig === msg_signature
```

**base64decode**：Deno 全局 `atob()` → 转 Uint8Array。

**XML 解析**：企微事件 XML 结构固定，用 regex 提取（不引入 XML 库）：
- 外层：`/<Encrypt><!\[CDATA\[([^\]]+)\]\]><\/Encrypt>/`
- 事件字段：`/<ChangeType><!\[CDATA\[([^\]]+)\]\]><\/ChangeType>/`、`/<UserID>([^<]+)<\/UserID>/`、`/<Id>([^<]+)<\/Id>/` 等

**安全**：签名校验 + receiveid 校验是鉴权全部（回调 URL 公网可达，但只有持 Token 的企微能伪造合法签名）。**不需要 agent_api_key**（GET 验证无法带额外头，且企微签名+加密本身即鉴权）。签名/receiveid 校验失败一律返回 403，不处理。

### 3.3 user/get 快照拉取（用 App B 的 secret，非通讯录同步 secret）

create/update_user 时调：
```
GET https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=TOKEN&userid=USERID
```
- access_token 用 `gettoken(WECOM_CORP_ID, WECOM_OPS_SECRET)` 取（**App B secret**，全员可见+通讯录读取，能 `user/get` 任何 userid）。
- **不用**"通讯录同步功能专用 secret"（历史判断其废弃/不引入新依赖；WECOM_OPS_SECRET 已验证可拉全量，user/get 同源）。
- user/get 返回 `{userid, name, department, position, mobile, email, avatar, status, ...}` → 映射 upsert org_users。

**注意区分两套 secret**：
- 回调**验证/解密**：`CONTACT_CALLBACK_TOKEN` / `CONTACT_CALLBACK_ENCODING_AES_KEY`（企微「通讯录同步」功能生成，与 user/get 无关）
- 拉快照 **user/get**：`WECOM_OPS_SECRET`（App B）

### 3.4 软删除（is_active 迁移）

新迁移 `database/migrations/017_contact_realtime_sync.sql`（幂等）：
```sql
BEGIN;
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE org_departments ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
COMMENT ON COLUMN org_users.is_active IS '通讯录同步软删除标记：false=企微已离职/删除，保留行';
COMMENT ON COLUMN org_departments.is_active IS '通讯录同步软删除标记：false=企微已删除，保留行';
COMMIT;
```
- 语义：离职/删部门 = 标 false，**保留行**（保历史 + 不破坏 `retail_query_user_perms`(wecom_id 关联、无外键) + 登录时拦已离职）。
- 现有数据默认 true，不受影响。
- **权限**：确认 anon 对 `org_users`/`org_departments` 有 `UPDATE` 权限（CLAUDE.md 常见问题 GRANT 过 INSERT/SELECT/UPDATE；新增列继承表级权限，但迁移后需实测回调的 UPDATE 不报 401/权限错）。

### 3.5 全量兜底改造（`functions/wecom-sync-contacts`）

在现有全量拉取 + upsert 基础上加一步 **is_active 对齐**，让全量也能纠正离职（不只靠回调）：

```
全量拉取得企微当前 userid 集合 = A
库里 org_users WHERE is_active=true 的 wecom_id 集合 = B
(B - A) → UPDATE org_users SET is_active=false   -- 企微已没有但库里还 active 的 = 离职
A 中的 → upsert 时 is_active=true                  -- 企微有的都 active
```
- upsert 行带 `is_active: true`（在职）。
- 部门同理：企微没有的 active 部门标 false。
- name 字段：全量快照是最终权威，upsert 覆盖一切（纠正回调漏的昵称→实名等漂移）。

### 3.6 调度（web cron 每日 03:17）

通讯录兜底是**平台基础设施**（非 collect_tasks 采集任务），在 `web/lib/scheduler.ts` 独立注册一个 cron，**不**塞进 `collect_tasks` 表、**不**改 `executeTask` 逻辑：

```ts
// 在 ensureSchedulerInitialized() 成功后调用 registerContactSyncJob()
function registerContactSyncJob() {
  if (scheduledJobs.has('__contact_sync')) return;
  const job = cron.schedule('17 3 * * *', async () => {
    // 防重入
    if (runningTasks.has('__contact_sync')) return;
    runningTasks.add('__contact_sync');
    try {
      await fetch(`${INSFORGE_API_BASE}/functions/wecom-sync-contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${INSFORGE_API_KEY}` },
      });
    } finally {
      runningTasks.delete('__contact_sync');
    }
  }, { timezone: 'Asia/Shanghai' });
  scheduledJobs.set('__contact_sync', job);
}
```
- 复用 `globalThis` 单例机制（同 collect 任务，防双触发）。
- 复用 `scheduledJobs`/`runningTasks`（key 用保留前缀 `__` 避免与 collect_tasks UUID 冲突）。
- `reloadScheduler()` 里一并 stop 重建（已有循环清理 scheduledJobs，覆盖到）。
- 选 03:17（非整点，避开 fleet 高峰）。

### 3.7 secret 管理

新增两个 secret（回调验证用）：
- `CONTACT_CALLBACK_TOKEN`
- `CONTACT_CALLBACK_ENCODING_AES_KEY`

落地处：
- `scripts/deploy-functions.sh`：在 set_secret 段加两行（与 `WECOM_OPS_SECRET` 等同款 POST/409→PUT upsert）
- `deploy/.env.example`：加两行 + 注释
- `deploy/.env`（服务器，gitignored）：用户企微后台拿到后填
- function 内 `Deno.env.get("CONTACT_CALLBACK_TOKEN")` 等

回调 function 全部依赖 secret：`CONTACT_CALLBACK_TOKEN`、`CONTACT_CALLBACK_ENCODING_AES_KEY`、`WECOM_CORP_ID`、`WECOM_OPS_SECRET`（user/get）、`ANON_KEY`（DB 写入）。

### 3.8 name 一致性策略

- name **永远以最新同步值 upsert 覆盖**，不区分昵称/实名（判断"是不是微信昵称"无可靠依据，硬判误伤）。
- 回调 create/update_user 用 `user/get` 快照的 name（已是企微当前值）。
- 全量兜底的 name 是最终权威，纠正一切回调漏的漂移。
- **最坏情况**：昵称入库后，实名纠正最长等到次日凌晨全量（若回调 update 未触发）。可接受；若后续要更快，提全量频率到每 4–6h（46 人配额无压力），或全靠回调补 user/get（基本闭环）。

### 3.9 5s 超时与幂等

- 企微要求回调 5s 内响应，否则重试。处理链：解密(<10ms) + user/get(<300ms) + DB upsert(<200ms) ≈ <600ms，安全。
- **幂等硬要求**（企微重试可能重复投递）：upsert 天然幂等；`SET is_active=false` 天然幂等。同一事件重复处理结果一致。
- user/get 失败（网络/限频）：返回非 200 让企微重试（但注意不要因 DB 写入已成功又重试导致问题——upsert 幂等所以安全）。**策略**：user/get 失败则整个事件返回 500（不部分写库），让企微重试整个事件。

## 4. 数据库迁移

见 §3.4：`database/migrations/017_contact_realtime_sync.sql`。

## 5. 文件清单

**新建**：
- `functions/wecom-contact-callback/index.js` — 回调 function（GET 验证 + POST 解密分派 + user/get 快照）
- `database/migrations/017_contact_realtime_sync.sql` — is_active 软删除列

**修改**：
- `functions/wecom-sync-contacts/index.js` — 兜底改造：upsert 带 is_active + 对齐离职
- `web/lib/scheduler.ts` — 注册独立 03:17 通讯录同步 cron
- `scripts/deploy-functions.sh` — set_secret 两个新 secret
- `deploy/.env.example` — 两个新 secret + 注释

**已更新**（本 spec 之前）：
- `docs/architecture.md` §7.1 功能矩阵 + §7.1.2 章节

## 6. 前置条件（企微后台，用户操作）

1. 登录企微管理后台 → 「管理工具」→「通讯录同步」→ 开启「API 接口同步」。
2. 在该页面获取/设置 **Token** + **EncodingAESKey**（可自定义或让企微生成随机）。
3. **回调 URL** 填 `https://data.shanhaiyiguo.com/functions/wecom-contact-callback`。
4. 企微会立即 GET 验证该 URL——故**回调 function 必须先部署上线 + secret 填好**，企微验证通过才允许保存。
5. 拿到 Token/EncodingAESKey 后填服务器 `deploy/.env`，重跑 `deploy-functions.sh` 注入 secret。
6. **注意**：通讯录变更回调不需要"企业可信 IP"（那是应用调企微 API 的方向；回调是企微→我们，方向相反）。但 `user/get` 拉快照走 App B secret，App B 可信 IP 已配（§7.1）。

## 7. 部署与验证

**部署方式判定**（按 CLAUDE.md）：
- 改 `functions/*/index.js`（新建 callback + 改 sync-contacts）→ **SSH 直调 InsForge API PUT + 清 Deno 缓存**，不走 GHA。
- 改 `web/lib/scheduler.ts`、迁移 `database/migrations/`、`deploy/.env.example`、`scripts/deploy-functions.sh` → **走 GHA**。
- 故本次**两者都改 → SSH 先 PUT function，再 push 走 GHA**。

**验证**：
1. function PUT + 清缓存后，本地/服务器 curl GET 回调 URL 带 echostr 测验证（可用企微提供的调试工具或手动构造签名）。
2. 迁移上线后：`docker exec deploy-postgres-1 psql -U postgres -d insforge -c "\d org_users"` 确认 is_active 列存在。
3. 企微后台填回调 URL，看企微验证是否通过（通过=GET 验证逻辑正确）。
4. 实测：企微后台手动改一个测试员工信息 → 观察回调 function 日志 + 库内 org_users 是否秒级更新。
5. 实测 name 漂移：测试员工"微信昵称→实名"，观察回调是否触发 update、user/get 是否拉到实名；若回调没触发，确认次日全量纠正。
6. 全量兜底：手动 `POST /functions/wecom-sync-contacts`，确认离职对齐生效（企微已删的人 is_active→false）。
7. cron：等 03:17 或手动调 `/api/admin/scheduler/reload` 后看日志 `[scheduler] 注册通讯录同步`。

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| 企微回调 5s 超时 | 处理 <600ms；超时企微重试，幂等安全 |
| 企微回调丢消息 | 每日全量兜底自愈（最长次日） |
| 企微「通讯录同步」功能未开启/Token 不一致 | 前置条件明确；secret 漂移用 deploy-functions.sh upsert 自愈 |
| user/get 限频（高峰） | 通讯录变更频率极低（日级几次），无压力 |
| 回调验证失败返 403 误拦合法企微 | 签名+receiveid 校验严格按协议，先 GET 验证通过再上线 POST |
| is_active UPDATE 权限不足 | 迁移后实测；不足则 GRANT（CLAUDE.md 同款） |

**回退**：
- 回调故障：企微后台关闭回调 URL → 回退到纯全量（现状 + 03:17 调度）。回调 function 不影响全量。
- 全量改造故障：revert sync-contacts（is_active 列保留无害，默认 true）。
- 迁移可保留（is_active 列无副作用）。

## 9. 不做（out of scope）

- 通讯录同步功能专用 secret 的启用（沿用 App B 的 WECOM_OPS_SECRET，不引入）。
- 回调事件审计落表（如 contact_sync_events 日志表）——YAGNI，function 日志 + 全量兜底足够；后续若需追溯再加。
- 部门 `department/get` 补全（部门少且稳定，回调字段够；user 才补 get）。
- 已离职员工 `retail_query_user_perms` override 的自动清理（软删除保留行，override 不孤儿；是否清理离职者权限是业务决策，另议）。
- 把通讯录同步塞进 collect_tasks 表 / 管理界面（它是平台基础设施，独立 cron 即可）。
