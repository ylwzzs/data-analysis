# notify plugin

OpenClaw native tool-plugin：统一通知出口。OpenClaw 主动发企微通知时调 `send_notify`，转发到 `functions/wecom-notify`（App B / Agent 1000009 发送）。架构文档 `docs/architecture.md` §7.1.1。

## 组件

| 文件 | 作用 |
|---|---|
| `index.js` | 入口：`definePluginEntry` + factory `registerTool(send_notify)`，读 `ctx.requesterSenderId`（解析 `@sender`）+ `process.env.AGENT_API_KEY`，POST 到 wecom-notify |
| `openclaw.plugin.json` | manifest：`contracts.tools:["send_notify"]` + `activation.onStartup:true`（全局）+ `skills:["./skills"]` |
| `skills/notify/SKILL.md` | 教模型何时/如何发通知（参数、收件人规则、不发场景、编造铁律） |
| `package.json` | `openclaw.extensions:["./index.js"]`（入口在 **tracked** 路径，非 `dist/`——区别于 data-query-plugin 的 gitignored dist） |

## 数据流

```
OpenClaw 决定主动通知（skill 判定该发）
  → send_notify({ content, touser? })
  → factory 闭包取 ctx.requesterSenderId（解析 "@sender" 收件人）
  → POST http://insforge:7130/functions/wecom-notify  body={agent_api_key, content, title, touser, msgtype}
  → wecom-notify：鉴权 → gettoken(App B) → message/send
  → 返回 { ok, sent_to }
```

`AGENT_API_KEY` 留 openclaw 容器 env（compose 注入，同 data-query），不进 LLM/用户上下文。`NOTIFY_URL` 默认 `http://insforge:7130/functions/wecom-notify`，如需覆盖在容器 env 设 `NOTIFY_URL`。

## 前置条件

- openclaw 容器 env 有 `AGENT_API_KEY`（与 wecom-notify function secret、agent-query 同值）—— 见 `deploy/docker-compose.prod.yml`（已注入）。
- `functions/wecom-notify` 已部署 + App B（1000009）可信 IP 已配（§7.1）。

## 部署（openclaw 是手动 SSH 部署面，GHA 不推 openclaw/）

```bash
# 1. 同步插件到服务器持久路径
scp -r openclaw/notify-plugin \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/

# 2. 容器内 link 安装（写 openclaw.json 的 plugins.{entries,allow}）
ssh root@data.shanhaiyiguo.com "docker exec deploy-openclaw-1 \
  node openclaw.mjs plugins install -l /home/node/.openclaw/plugins/notify-plugin"

# 3. 重启 gateway 加载
ssh root@data.shanhaiyiguo.com "docker restart deploy-openclaw-1"

# 4. 验证
ssh root@data.shanhaiyiguo.com "docker exec deploy-openclaw-1 node openclaw.mjs plugins inspect notify --runtime"
ssh root@data.shanhaiyiguo.com "docker exec deploy-openclaw-1 node openclaw.mjs skills list"
```

## 卸载注意

同 data-query：`plugins uninstall --force` 会残留 `plugins.load.paths` 指向已删目录 → gateway 崩溃循环。卸后用 `openclaw doctor --fix` 或手动清 `openclaw.json` 的 `load.paths`。
