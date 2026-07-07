# 企微三应用隔离 + 统一通知服务 · 设计文档

- **日期**：2026-07-07
- **状态**：已与用户确认设计，待写实现计划
- **相关**：`docs/architecture.md` §7.1（将同步更新）、§4.3（OpenClaw 通知链路）

---

## 1. 背景与问题

### 1.1 现状（代码实证）

当前系统**只用一个企微自建应用**（`WECOM_CORP_ID` + `WECOM_AGENT_ID`=1000008 + `WECOM_SECRET`），它一人扛了四件事：

| 能力 | 代码位置 | 用的 secret |
|---|---|---|
| OAuth 登录 | `functions/wecom-oauth` | `WECOM_SECRET` |
| 通讯录同步 | `functions/wecom-sync-contacts` | `WECOM_SECRET` |
| 告警通知 | `web/lib/notify.ts` → `notifyWecom()` | `WECOM_SECRET`，且 `touser` 写死 `ZhangDuo` |
| 报表推送 | `functions/wecom-push` | `WECOM_SECRET` |

OpenClaw 的 wecom 对话 channel 是另一套独立配置（`openclaw/.env` 的 `WECOM_*` 为注释占位、标注"用户自行配置"，prod 在容器 env）。

### 1.2 根因

> 企微通讯录 API（`department/list`、`user/list`）**只返回「该应用通讯录可见范围」内的人和部门**。老应用可见范围只到总经办，故同步只得到一小撮人（YangWei 拉不到即此原因，见架构文档 §4.3）。

注：代码从未使用独立的「通讯录同步助手」secret（CLAUDE.md / §7.1 提到的 `WECOM_CONTACTS_SECRET` 是**死配置**，代码无引用）。

### 1.3 痛点

1. 通讯录同步不全 → 部门制权限（迁移 015）对不在可见范围的人失效。
2. `notifyWecom` 写死 `touser:'ZhangDuo'` → 只有单人收得到告警。
3. secret 散落在 web 容器 env + 两个 function，耦合在一个应用上。

---

## 2. 目标

- 通讯录**全量同步**（覆盖全部成员）。
- 建立**统一消息通知服务**，收口所有告警/通知，支持多收件人/广播，并对 OpenClaw 暴露。
- 应用职责**隔离**：报表应用、同步/通知应用、OpenClaw bot 各自独立。
- 不破坏现有 OAuth、报表、OpenClaw 对话能力。

---

## 3. 架构设计

### 3.1 三应用拓扑

| 应用 | 可见范围 | 用途 | secret 归属 | 使用方 |
|---|---|---|---|---|
| **App A · 报表应用**（老应用 1000008） | 仅有权限的人 | OAuth 登录 + 报表页展示（软门禁） | `WECOM_SECRET`（不动） | `wecom-oauth`、前端 |
| **App B · 同步/通知应用**（新建） | **全部成员** + 通讯录读取权限 | ① 通讯录全量同步 ② 统一消息通知 | 新增 `WECOM_OPS_SECRET` / `WECOM_OPS_AGENT_ID` | sync function、`wecom-notify` function |
| **App C · OpenClaw bot**（独立） | 按需 | OpenClaw 对话 channel（收发 DM） | openclaw 容器 env（不在 web 管辖） | OpenClaw 自管 |

- `WECOM_CORP_ID` 三个应用共用（同 corp），不新增。
- App A **不改代码**——本就被 OAuth 专用；"收窄"只是把同步/通知两件事从它身上搬到 App B。可见范围保持「仅有权限的人」（正好作报表访问软门禁）。
- App C 不在本次代码改动范围，仅确认其独立。

### 3.2 数据流

**① 通讯录全量同步（App B）**

```
scheduler(web) ──定时/手动──► wecom-sync-contacts（改读 WECOM_OPS_SECRET）
                                  ├── gettoken(App B)
                                  ├── department/list + user/list   ← 全量
                                  └── upsert org_users / org_departments
```

**② 统一通知（App B）—— 所有告警/通知收口到一个 function**

```
web (scheduler / collect-lemeng) ─┐
                                  ├─ POST /functions/wecom-notify ─► 企微 App B ─► 员工
OpenClaw（主动通知）───────────────┘   {agent_api_key, content, title?, touser?, msgtype?}
                                        鉴权：agent_api_key === AGENT_API_KEY
                                        凭据单点：App B secret 仅存于本 function secret
```

---

## 4. 组件改动清单

| 文件 | 改动 | 部署方式 |
|---|---|---|
| `functions/wecom-notify/index.js` | **新建**：统一通知服务（gettoken → message/send） | SSH 直调 PUT |
| `functions/wecom-sync-contacts/index.js` | secret `WECOM_SECRET` → `WECOM_OPS_SECRET` | SSH 直调 PUT |
| `functions/wecom-push/index.js` | secret/agentid → `WECOM_OPS_*`（低优先，顺带收口） | SSH 直调 PUT |
| `web/lib/notify.ts` | `notifyWecom(title,content)` **签名不变**，内部从直发企微 → POST `wecom-notify`（带 `AGENT_API_KEY`） | GHA |
| `web/lib/scheduler.ts`、`web/app/api/admin/collect-lemeng/route.ts` | **不动**（调用签名不变） | — |
| `deploy/.env.example` | 加 `WECOM_OPS_SECRET` / `WECOM_OPS_AGENT_ID` / `NOTIFY_DEFAULT_TUSERS`；删 `WECOM_CONTACTS_SECRET`；注明 web 容器新增 `AGENT_API_KEY` 注入 | 配置 |
| `deploy/docker-compose.prod.yml` | web 服务 env 加 `AGENT_API_KEY: ${AGENT_API_KEY:-}` | 配置 |
| `docs/architecture.md` | §7.1 改三应用拓扑 + 新增「统一通知服务」小节 + §4.3 OpenClaw 通知改走 `wecom-notify` + §9 决策表补一行 | 文档 |

---

## 5. 通知服务接口（`functions/wecom-notify`）

```
POST /functions/wecom-notify
鉴权：body.agent_api_key === AGENT_API_KEY（与 agent-query 同款；OpenClaw 插件已用此传法）；不符 → 401

Body:
{
  content:  string,                              // 必填，消息正文
  title?:   string,                              // 可选，markdown 标题
  touser?:  string,                              // 可选，缺省 = NOTIFY_DEFAULT_TUSERS
                                                //   "ZhangDuo" | "ZhangDuo|YangWei" | "@all"
  msgtype?: "markdown" | "text" | "textcard"     // 缺省 markdown
}

Response: { ok: boolean, errcode: number, errmsg: string, sent_to: string }
```

- **默认收件人**：env `NOTIFY_DEFAULT_TUSERS`（`|` 分隔），替代写死的单 `ZhangDuo`。
- **调用方可覆盖** `touser`：OpenClaw 精确发给某人就传，不传走默认管理员组。
- **`@all` 广播**：允许，靠 `AGENT_API_KEY` 门禁防滥用（anon_key 公开，绝不能让它调通知）。

---

## 6. 配置变更

```bash
# deploy/.env 新增（App B = 同步/通知应用）
WECOM_OPS_SECRET=<新全员应用的 Secret>
WECOM_OPS_AGENT_ID=<新全员应用的 AgentId>
NOTIFY_DEFAULT_TUSERS=ZhangDuo          # 告警默认收件人，| 分隔

# 删除死配置
# WECOM_CONTACTS_SECRET   ← 代码从未读取，清除
```

- `AGENT_API_KEY` 注入新增**第 4 处** web 容器（原 duckdb / agent-query function secret / openclaw 之外），供 `notifyWecom` 调 function 时带。该 key 仅服务端（非 `NEXT_PUBLIC_`），不进前端 bundle。

---

## 7. 错误处理与已知限制

- **token 每次调用现取**：edge function 无可靠跨调用状态；告警量低（仅故障触发），可接受。量起来再加 Postgres 缓存。
- **通知 fire-and-forget**：function 内部吞掉企微 errcode 仅记日志，不阻断调用方（与现状一致）。
- **InsForge 挂了告警发不出**：方案 A 固有代价。InsForge 挂本身就是大故障，可接受；如需兜底，以后加「InsForge 不可用时 web 直发」降级路径（YAGNI，暂不做）。

---

## 8. 部署与验证

### 8.1 前置（用户手动）

企微后台新建 App B → 可见范围设**全部成员** + 开**通讯录读取**权限 → 取 Secret / AgentId 填入 `deploy/.env`。

### 8.2 function 侧（SSH 直调 InsForge API，不走 GHA）

1. `deploy-functions.sh` 设新 secret：`WECOM_OPS_SECRET` / `WECOM_OPS_AGENT_ID` / `NOTIFY_DEFAULT_TUSERS`；为 `wecom-notify` 设 `AGENT_API_KEY`。
2. PUT `wecom-notify`（新）、`wecom-sync-contacts`（改）、`wecom-push`（改）。
3. 清 Deno 缓存：`docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno`。

### 8.3 web 侧（GHA）

`notify.ts` 改薄客户端 + compose 注入 `AGENT_API_KEY` → commit push。

### 8.4 验证

- **同步**：手动 `POST /functions/wecom-sync-contacts` → `org_users` 人数应从「总经办一小撮」跳到全员（YangWei 进入）。
- **通知**：`curl POST /functions/wecom-notify -d '{agent_api_key, content:"测试"}'` → 默认管理员收到。
- **OpenClaw**：让 bot 触发一次主动通知 → 走 `wecom-notify` → 到达。

---

## 9. 范围边界（不做）

- App C（OpenClaw bot）配置：OpenClaw 自管，web 不碰，仅确认其独立。
- 通知路由规则表（按事件类型分发）：env 默认组够用，等真有需求再上 DB。
- token 缓存、降级直发路径：量到再做。

---

## 10. 实现顺序（遵循 CLAUDE.md 架构变更流程）

1. **更新 `docs/architecture.md`**（CLAUDE.md 要求：架构文档先于代码）—— §7.1 三应用拓扑 + 统一通知服务小节 + §4.3 链路订正 + §9 决策表。
2. function 侧：新建 `wecom-notify` + 改 `wecom-sync-contacts` / `wecom-push` + 设 secret。
3. web 侧：`notify.ts` 薄客户端 + compose 注入 `AGENT_API_KEY`。
4. 验证（§8.4）。

---

## 11. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 应用拓扑 | 三应用完全隔离 | 职责最清净；报表/同步通知/bot 互不耦合 |
| 通知服务位置 | edge function `functions/wecom-notify`（方案 A） | 凭据单点；复用 OpenClaw→function 内网调用模式（与 agent-query 一致）；顺手修 `touser` 写死 |
| 通知服务鉴权 | 复用 `AGENT_API_KEY` | OpenClaw 已持有，与 agent-query 同源；减少 secret 碎片化 |
| 通讯录同步 secret | `WECOM_OPS_SECRET`（App B） | App B 全员可见 + 通讯录读取，覆盖全量 |
| 默认收件人 | env `NOTIFY_DEFAULT_TUSERS` | 替代写死的单 `ZhangDuo`；YAGNI，不上 DB |
