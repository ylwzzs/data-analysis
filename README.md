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
├── web/                    # Next.js 前端
│   ├── app/                # App Router (PC 首页/详情 + mobile H5)
│   ├── components/         # 布局 / 报表 / 图表 / 移动端组件
│   │   └── ui/             # shadcn/ui 组件
│   └── lib/                # API 封装与工具函数
├── functions/              # InsForge Edge Functions
│   └── mcp/                # MCP Server (Deno)
├── database/
│   └── migrations/         # PostgreSQL 初始化脚本
├── deploy/                 # 部署配置
│   ├── docker-compose.yml
│   ├── nginx.conf
│   └── .env.example
└── docs/                   # 设计文档与实现计划
```

## 开发

### 前端开发

```bash
cd web
npm install
npm run dev
```

- PC 端：http://localhost:3000
- 移动端：http://localhost:3000/mobile

> 当前前端使用 Mock 数据，接入后端后替换 `web/lib/api.ts` 中的实现。

### 部署

1. 复制环境变量配置：
   ```bash
   cd deploy
   cp .env.example .env
   # 编辑 .env 填入实际配置
   ```

2. 启动服务：
   ```bash
   docker compose up -d
   ```

3. 数据库迁移脚本会在 PostgreSQL 容器首次启动时自动执行。

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
