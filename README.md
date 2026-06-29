# 数据分析平台

基于 InsForge 构建的企业数据分析平台。

## 功能

- 数据采集：API 数据自动采集存储
- 报表展示：PC 端 + 移动端报表查看
- 企微推送：定时推送报表消息
- 智能体接入：MCP 接口支持

## 技术栈

- 前端：Next.js 14+, TypeScript, shadcn/ui, ECharts
- 后端：InsForge, PostgreSQL, DuckDB, MinIO
- 认证：企业微信 OAuth

## 开发

```bash
cd web
npm install
npm run dev
```

## 部署

见 `deploy/` 目录。
