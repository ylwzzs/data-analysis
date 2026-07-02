# OpenClaw 数据分析助手

OpenClaw 是一个个人 AI 助手框架，本项目将其配置为企微数据分析机器人。

## 架构

```
企微消息 → OpenClaw Gateway → LLM (DeepSeek-V4-Flash)
                ↓
         工具调用 (HTTP)
                ↓
         InsForge REST API
                ↓
         PostgreSQL 数据库
```

## 目录结构

```
openclaw/
├── .env                    # 环境变量（包含 API Key）
├── state/                  # OpenClaw 状态目录
│   └── openclaw.json       # 主配置文件（JSON5 格式）
└── workspace/              # Agent 工作目录
```

## 配置说明

### 1. 模型提供商

已配置自定义提供商 `wishub`，使用 OpenAI 协议兼容接口：

- **Base URL**: `https://wishub-x6.ctyun.cn/v1`
- **模型**: `DeepSeek-V4-Flash`
- **API Key**: 在 `.env` 文件中设置 `WISHUB_API_KEY`

### 2. 企微 Channel

需要用户自行配置企微 channel。参考步骤：

1. 在企微管理后台创建自建应用
2. 获取 `corpId`、`agentId`、`secret`
3. 配置消息回调 URL：`https://data.shanhaiyiguo.com/webhook/wecom`
4. 设置 `token` 和 `encodingAesKey`
5. 在 `openclaw.json` 中取消注释 channels 配置并填入值

### 3. 数据查询工具

Agent 通过 HTTP 工具调用 InsForge REST API：

- **get_user_permissions**: 查询用户权限
- **get_table_schema**: 获取表结构
- **execute_query**: 执行 SQL 查询
- **save_audit_log**: 保存审计日志

## 部署

### 本地测试

```bash
# 启动 openclaw
cd deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d openclaw

# 查看日志
docker compose logs -f openclaw

# 访问 Control UI
open http://127.0.0.1:18789
```

### 服务器部署

```bash
# 推送代码触发 GitHub Actions
git push origin main

# 或手动部署
ssh root@data.shanhaiyiguo.com
cd /opt/data-analytics-platform/deploy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d openclaw
```

## 管理

### 进入容器

```bash
docker exec -it deploy-openclaw-1 bash
```

### 查看配置

```bash
docker exec deploy-openclaw-1 cat /home/node/.openclaw/openclaw.json
```

### 重启 Gateway

```bash
docker exec deploy-openclaw-1 node dist/index.js gateway restart
```

## 参考资料

- [OpenClaw 官方文档](https://docs.openclaw.ai)
- [企微机器人接入](https://open.work.weixin.qq.com/help2/pc/21657)
- [自定义模型提供商配置](https://docs.openclaw.ai/gateway/config-tools#custom-providers-and-base-urls)
