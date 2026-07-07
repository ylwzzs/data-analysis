# data-query plugin

OpenClaw native tool-plugin：把可信企微 userid 透传到 agent-query 网关，实现**全局工具 + 后端按人鉴权**的零售数据查询（架构文档 `docs/architecture.md` §4.3）。

## 为什么是 native plugin 而非远程 MCP

OpenClaw 核心每轮把企微 `fromUser` 注入 native plugin tool 的 `toolContext.requesterSenderId`，但**不会**透传给 `mcp.servers`。要拿可信 userid 做按人鉴权，只能用 native plugin 的 **factory 形式** `api.registerTool((toolContext) => toolDef)`。

## 组件

| 文件 | 作用 |
|---|---|
| `dist/index.js` | 入口：`definePluginEntry` + factory `registerTool`，读 `toolContext.requesterSenderId` + `process.env.AGENT_API_KEY`，POST 到 agent-query 网关 |
| `openclaw.plugin.json` | manifest：`contracts.tools:["query_retail_data"]` + `activation.onStartup:true`（全局）+ `skills:["./skills"]` |
| `skills/retail-query/SKILL.md` | 教模型何时/如何查询（retail_detail 列、汇总表、DuckDB/PG 写法、规则） |
| `package.json` | `openclaw.extensions:["./dist/index.js"]`；无 npm 运行时依赖（不用 typebox，parameters 用纯 JSON schema） |

## 数据流

```
企微用户提问
  → OpenClaw core 注入 toolContext.requesterSenderId = <wecom userid>
  → query_retail_data.execute({sql})
  → POST http://insforge:7130/functions/agent-query  body={sql, userId, agent_api_key}
  → 网关：认证 → get_user_perms(userId) → SQL 白名单 → 引擎路由(DuckDB/PG) → 审计
  → 返回 {engine, perms, rowCount, data}（行按 branch_nums、成本列按 can_see_cost 脱敏）
```

`AGENT_API_KEY` 留在 openclaw 容器 env（compose 注入），不进 LLM/用户上下文。

## 部署（openclaw 是手动 SSH 部署面，GHA 不推 openclaw/）

```bash
# 1. 同步插件源码到服务器持久路径（openclaw/state 是挂载卷）
scp -r openclaw/data-query-plugin \
  root@data.shanhaiyiguo.com:/opt/data-analytics-platform/openclaw/state/plugins/

# 2. 容器内 link 安装（自动写 openclaw.json 的 plugins.{entries,allow}）
ssh root@data.shanhaiyiguo.com "docker exec deploy-openclaw-1 \
  node openclaw.mjs plugins install -l /home/node/.openclaw/plugins/data-query-plugin"

# 3. 重启 gateway 加载
ssh root@data.shanhaiyiguo.com "docker restart deploy-openclaw-1"

# 4. 验证
docker exec deploy-openclaw-1 node openclaw.mjs plugins list
docker exec deploy-openclaw-1 node openclaw.mjs plugins inspect data-query --runtime
docker exec deploy-openclaw-1 node openclaw.mjs skills list
```

## 前置条件

- openclaw 容器 env 有 `AGENT_API_KEY`（与 agent-query function secret 同值）+ `AGENT_QUERY_URL`（默认 `http://insforge:7130/functions/agent-query`）—— 见 `deploy/docker-compose.prod.yml`。
- agent-query 网关、`get_user_perms`、`execute_sql_rls`、DuckDB 权限视图均已部署（§4.2）。

## 卸载注意

`plugins uninstall --force` 会残留 `plugins.load.paths` 指向已删目录，致 gateway 崩溃。卸载后用 `openclaw doctor --fix` 或手动清 `openclaw.json` 的 `load.paths`。
