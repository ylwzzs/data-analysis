# 数据分析平台

基于 InsForge 构建的企业数据分析平台，支持数据采集、报表展示、企业微信推送与智能体 MCP 接入。

## 功能

- **数据采集**：API 数据自动采集并存储到对象存储
- **报表展示**：PC 端 + 企微 H5 移动端报表查看
- **企微推送**：定时推送报表消息卡片
- **智能体接入**：MCP 接口供 openclaw 等智能体调用

## 技术栈

- **前端**：Next.js 16, TypeScript, shadcn/ui (Base UI), ECharts, Tailwind v4
- **后端**：InsForge (自托管), PostgreSQL 15, DuckDB, MinIO
- **认证**：企业微信 OAuth

## 项目结构

```
data-analytics-platform/
├── web/                    # Next.js 前端（含 Dockerfile）
│   ├── app/                # App Router (PC 首页/详情 + mobile H5 + auth 回调)
│   ├── components/         # 布局 / 报表 / 图表 / 移动端组件
│   │   └── ui/             # shadcn/ui 组件
│   └── lib/                # API 封装与工具函数
├── functions/              # InsForge Edge Functions
│   ├── wecom-push/         # 定时推送报表到企业微信
│   ├── wecom-oauth/        # 企业微信 OAuth 回调
│   └── mcp/                # MCP Server (Deno，占位)
├── database/migrations/    # PostgreSQL 迁移脚本（幂等，可重复跑）
├── deploy/                 # 部署编排
│   ├── docker-compose.yml          # base 后端栈（dev/prod 共用）
│   ├── docker-compose.override.yml # 本地开发：端口映射到宿主机
│   ├── docker-compose.prod.yml     # 生产：前端 + nginx 网关
│   ├── nginx/                      # nginx-certbot 配置模板
│   └── .env.example
├── scripts/                # migrate / deploy-functions / deploy
├── .github/workflows/      # CI：push to main → SSH 自动部署
└── docs/                   # 设计文档与实现计划
```

## 环境与部署

两套环境共用同一份后端编排（`deploy/docker-compose.yml`），保证本地与生产后端一致：

- **本地开发**：后端栈 + 前端 `npm run dev`（后端端口映射到宿主机）
- **生产**：后端栈 + 容器化前端 + nginx 网关（Let's Encrypt 自动 HTTPS），仅 nginx 暴露 80/443

### 本地开发

1. 起后端栈（InsForge + Postgres + PostgREST + Deno）：
   ```bash
   cd deploy
   cp .env.example .env          # 首次：填 POSTGRES_PASSWORD / JWT_SECRET / ADMIN_PASSWORD
   docker compose up -d           # 自动加载 docker-compose.override.yml，映射端口到宿主机
   bash ../scripts/migrate.sh    # 建表 + 种子数据（幂等，可重复跑）
   ```
   后端端口：7130（API）、7131（auth）、5432（postgres）、5430（postgrest）、7133（deno）。

2. 起前端：
   ```bash
   cd web
   npm install
   ```
   把 `web/.env.example` 复制为 `web/.env.local`，填本实例 URL 与 anon_key：
   ```
   NEXT_PUBLIC_INSFORGE_URL=http://localhost:7130
   NEXT_PUBLIC_INSFORGE_ANON_KEY=<anon_ 前缀的 key，见下>
   ```
   ```bash
   npm run dev
   ```
   - PC 端：http://localhost:3000
   - 移动端：http://localhost:3000/mobile

3. 获取 anon_key（前端匿名读业务表必需）：用 InsForge API key 调 `get-anon-key`（MCP 工具），或登录 dashboard（http://localhost:7130，`admin` / 你设的 `ADMIN_PASSWORD`）查看。

> 镜像加速：本机 npm 官方源极慢，已统一用 `https://registry.npmmirror.com`（见 `web/Dockerfile`、`deploy/.env.example` 的 `NPM_REGISTRY`）。

### 生产部署（GitHub Actions 自动）

架构：push 到 `main` → Action 经 SSH 到服务器执行 `scripts/deploy.sh`。前端在服务器上 build（`NEXT_PUBLIC_INSFORGE_ANON_KEY` 依赖该实例，无法在 CI 预先 build）。

**服务器一次性准备**：
1. 装 Docker（含 compose 插件）、`jq`、`curl`、`git`。
2. `git clone` 本仓库到 `$DEPLOY_PATH`（如 `/opt/data-analytics-platform`）。
3. `cd deploy && cp .env.example .env`，填入生产值（强密码、`JWT_SECRET`、`DOMAIN`、`LETSENCRYPT_EMAIL`、`INSFORGE_API_KEY` 等）。
4. 域名 A 记录指向服务器；放行 80/443（Let's Encrypt HTTP-01 校验需 80）。
5. 仓库 Settings → Secrets 配置：`SSH_HOST`、`SSH_USER`、`SSH_KEY`、`DEPLOY_PATH`。

**首次部署**（解决 anon_key chicken-egg）：
1. 在服务器先手动起后端、取一次 anon_key 回填到 `deploy/.env` 的 `NEXT_PUBLIC_INSFORGE_ANON_KEY`：
   ```bash
   cd $DEPLOY_PATH/deploy
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres postgrest deno insforge
   # 用 INSFORGE_API_KEY 取 anon_key，回填 .env
   ```
2. 之后任意 `git push origin main` 即自动完成全流程：拉代码 → 起后端 → 迁移 → 部署 function + WECOM secrets → build 前端 → 起 nginx（自动签发证书）。

**手动部署**（不走 CI）：在服务器执行 `bash scripts/deploy.sh`。

## 访问

- PC 端：https://data.yourcompany.com
- 移动端：https://data.yourcompany.com/mobile
- MCP 接口：https://data.yourcompany.com/mcp

## 企业微信集成

1. 在企业微信管理后台创建自建应用
2. 配置应用主页为移动端地址
3. 配置 OAuth 回调域名
4. 将 CorpID、AgentID、Secret 填入 `deploy/.env`

## MCP 接入

在 openclaw 配置中添加：

```json
{
  "mcpServers": {
    "insforge": {
      "url": "https://data.yourcompany.com/mcp",
      "transport": "http"
    }
  }
}
```

可用工具：

- `fetch-docs` —— 获取平台文档与数据结构
- `list-reports` —— 列出用户可访问的报表
- `get-report` —— 获取指定报表数据
- `query-table` —— 查询预设数据表

## License

MIT
