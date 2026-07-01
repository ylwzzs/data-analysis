# data-analytics-platform 项目分析报告

**日期**：2026-07-01  
**分析框架**：分层审计法（基础设施 → 后端 → 前端 → 安全 → 业务逻辑）  
**分析方法**：superpowers brainstorming 流程

---

## 一、项目概述

### 1.1 项目性质

企业数据分析平台，集成企业微信（企微）推送与登录，面向企业内部用户提供报表查看与数据推送服务。

### 1.2 技术栈

| 层级 | 技术 |
|-----|------|
| **后端** | InsForge（自托管 BaaS：PostgreSQL + PostgREST + Deno edge functions） |
| **前端** | Next.js 16（App Router + Server Components）+ React 19 + shadcn/ui + ECharts |
| **认证** | 企微 OAuth（H5 snsapi_base + PC 扫码）+ HS256 JWT |
| **部署** | GitHub Actions rsync + 服务器 Docker build + 天翼云镜像 + nginx-certbot |

### 1.3 核心功能

- 企微扫码登录（PC）+ 静默授权（H5）
- 报表查看（PC + 移动端）
- 定时推送报表摘要到企微（textcard 消息）
- 数据源管理（占位，待开发）

### 1.4 最近开发重点

- ✅ 完整登录鉴权：登录后才能看报表
- ✅ 企微客户端内自动静默 H5 授权（刚修：UA 自动分流）
- ✅ callback redirect 用 X-Forwarded-Host 构造 origin（刚修：避免 0.0.0.0:3000）

---

## 二、基础设施层分析

### 2.1 部署架构

```
用户访问（HTTPS）
    ↓
nginx-certbot（网关）
    ├─→ / → web:3000（Next.js）
    └─→ /api|/functions → insforge:7130（PostgREST + Edge Functions）
    ↓
┌─────────────┬─────────────┬─────────────┬─────────────┐
│ web:3000    │ insforge    │ postgres    │ deno        │
│ (Next.js)   │ (7130)      │ (5432)      │ (7133)      │
└─────────────┴─────────────┴─────────────┴─────────────┘
```

### 2.2 部署链路

| 阶段 | 执行方 | 耗时 |
|-----|-------|------|
| rsync 代码 | GHA runner（境外） | ~10s |
| SSH 触发 | GHA → appleboy/ssh-action | ~5s |
| 后端启动 | deploy.sh | ~30s |
| 数据库迁移 | migrate.sh | ~5s |
| Functions 部署 | deploy-functions.sh | ~10s |
| 前端 Build | 服务器 Docker build | ~40s |
| Push 镜像 | 服务器 → 天翼云 | ~20s |
| 起网关 | compose up web nginx | ~10s |

**总耗时**：~1m20s（实测）

### 2.3 Docker Compose 结构

- `docker-compose.yml`：基础后端栈（postgres + postgrest + deno + insforge）
- `docker-compose.override.yml`：开发端口映射（5432/7130/7131）
- `docker-compose.prod.yml`：生产叠加（web 容器 + nginx 网关，后端仅 loopback）

### 2.4 网络与安全

- HTTPS：Let's Encrypt 自动签发/续期
- 端口暴露：仅 80/443 对公网，后端仅 loopback
- 企微可信域名：`/WW_verify_*.txt` 挂载到 nginx

### 2.5 基础设施风险

| 风险 | 影响 |
|-----|------|
| **🔴 单点故障**：单服务器，无高可用 | 服务器宕机 → 全站不可用 |
| **🔴 无备份策略**：数据库未配置备份 | 数据丢失无法恢复 |

---

## 三、后端层分析

### 3.1 数据库设计

**表结构**：

| 表 | 用途 | 索引 |
|---|------|-----|
| reports | 报表配置 | created_at DESC |
| data_sources | 数据源配置 | - |
| data_files | 数据文件记录 | source_id, ingested_at DESC |
| org_users | 企微用户同步 | - |
| org_departments | 企微部门同步 | - |
| data_permissions | 数据权限配置 | - |
| query_logs | 查询审计日志 | user_id, executed_at DESC |

**设计特点**：
- ✅ 幂等迁移（`IF NOT EXISTS` / `DROP IF EXISTS`）
- ✅ JSONB 灵活性（metrics、chart_config）
- ✅ 触发器自动维护 updated_at

### 3.2 PostgREST 配置与权限

**权限模型**：

- anon role：已被 `003_auth.sql` REVOKE SELECT on 业务表
- authenticated role：JWT 验签后切换，可读业务表

**权限边界**：
- ✅ 强制认证：业务表必须 authenticated 才能读
- 🔴 **无 RLS**：`data_permissions` 表设计了权限配置，但未启用行级安全

### 3.3 Deno Edge Functions

| 函数 | 功能 |
|-----|------|
| wecom-oauth | code → userid → JWT（7天有效） |
| wecom-push | 定时推送报表摘要到企微 |
| mcp | MCP server（占位） |

### 3.4 后端层风险

| 风险 | 影响 |
|-----|------|
| **🔴 无 RLS**：所有 authenticated 用户可读全部数据 | 无数据隔离 |
| **🔴 JWT 无吊销**：用户离职后 token 仍有效 7 天 | 安全隐患 |
| **⚠️ Secrets 明文注入**：deploy-functions.sh POST 明文 | 日志泄露风险 |
| **⚠️ 无 API 限流**：未配置频率限制 | 滥用风险 |
| **⚠️ 缺少软删除**：无 deleted_at 字段 | 无法恢复 |
| **⚠️ 缺外键约束**：reports.created_by 未关联 org_users | 数据完整性依赖应用层 |
| **⚠️ 审计不全**：query_logs 仅记录 wecom-push | 覆盖不全 |

---

## 四、前端层分析

### 4.1 路由结构

- `/`：首页（报表列表，受保护）
- `/reports/[id]`：报表详情（受保护）
- `/sources`：数据源管理（受保护）
- `/mobile`：移动端首页（受保护）
- `/login`：登录页（不受保护）
- `/auth/callback`：OAuth 回调（Route Handler）

### 4.2 认证流程

```
用户访问受保护页面
    ↓
middleware 检查 cookie
    ↓（无 token）
/login 页面
    ├─→ 企微客户端（UA wxwork）→ 自动静默 H5 授权
    └─→ 普通浏览器 → 企微扫码登录
    ↓
/auth/callback
    ├─→ exchangeWecomCode → wecom-oauth function
    ├─→ 写 cookie（insforge_access_token + wecom_userid）
    └─→ redirect 到 next 或 /mobile
```

### 4.3 API Client 设计

- per-request client：每次调用从 cookie 读 token
- snake_case → camelCase 映射封装

### 4.4 前端层风险

| 风险 | 影响 |
|-----|------|
| **⚠️ 无错误边界**：API 错误未捕获 | 页面崩溃显示 500 |
| **⚠️ 无 Suspense/loading**：无渐进加载 | 用户体验差 |
| **⚠️ 无类型安全**：手动断言 data as ReportRow[] | 运行时错误风险 |
| **⚠️ 移动端适配不足**：/mobile 页面结构与 PC 相似 | 小屏体验一般 |

---

## 五、安全审计

### 5.1 认证安全

| 维度 | 现状 | 风险 |
|-----|------|-----|
| JWT 签名 | HS256 手写，密钥共享 | ⚠️ 中（无密钥轮转） |
| JWT 有效期 | 7天硬过期，无 refresh | ⚠️ 中 |
| JWT 吊销 | 无吊销机制 | 🔴 高 |
| Cookie 存储 | httpOnly + secure + sameSite=lax | ✅ 低 |

### 5.2 数据安全

| 维度 | 现状 | 风险 |
|-----|------|-----|
| 业务表权限 | anon REVOKE，authenticated 可读 | ✅ 低 |
| 行级安全 | 未启用 | 🔴 高（无数据隔离） |
| 敏感字段 | org_users.mobile/email 暴露 | 🔴 高 |
| 数据加密 | PostgreSQL 明文存储 | ⚠️ 中 |
| 备份加密 | 未配置备份 | 🔴 高 |

### 5.3 API 安全

| 维度 | 现状 | 风险 |
|-----|------|-----|
| PostgREST 认证 | JWT Bearer 验签 | ✅ 低 |
| PostgREST 限流 | 未配置 | ⚠️ 中 |
| Edge Function 认证 | 无调用限制 | ⚠️ 中 |
| CORS | nginx 未限制 origin | ⚠️ 中 |

### 5.4 配置安全

| 维度 | 现状 | 风险 |
|-----|------|-----|
| Secrets 存储 | .env 文件 + InsForge secrets API | ⚠️ 中（明文） |
| Secrets 注入 | POST 明文 JSON | ⚠️ 中（日志泄露） |
| 默认密码 | docker-compose 有 fallback 默认值 | 🔴 高（dev 可能沿用） |
| .env 入库 | .gitignore 已排除 | ✅ 低 |

### 5.5 运维安全

| 维度 | 现状 | 风险 |
|-----|------|-----|
| HTTPS | Let's Encrypt 自动签发/续期 | ✅ 低 |
| 端口暴露 | 仅 80/443 对公网 | ✅ 低 |
| 日志审计 | query_logs 仅记录 wecom-push | ⚠️ 中 |
| 监控告警 | 未配置 | 🔴 高 |
| 备份恢复 | 未配置 | 🔴 高 |
| 高可用 | 单服务器 | 🔴 高 |

---

## 六、用户补充需求（鉴权与页面适配）

### 6.1 页面适配需求

所有页面都要有 **PC 和移动端两套适配**。

### 6.2 鉴权机制改进

**核心理念**：「**环境检测优先于登录检测**」

```
用户访问任意页面
    ↓
middleware 检测环境
    ├─→ 企微客户端内（UA wxwork）
    │       ├─→ PC 端 → 自动静默授权 → 跳 /
    │       └─→ 移动端 → 自动静默授权 → 跳 /mobile
    │       （不混跳：移动环境不跳 PC 页面，PC 环境不跳移动页面）
    │
    └─→ 企微客户端外
            ├─→ 已登录 → 放行，跳 /
            └─→ 未登录 → 跳 /login（仅显示企微扫码登录）
```

**关键规则**：
1. 企微客户端内：按设备类型自动鉴权，跳转对应页面
2. 企微客户端外：统一跳 PC 登录页，仅支持企微扫码登录
3. 不混跳：移动环境不跳 PC 页面，PC 环境不跳移动页面

---

## 七、风险总结与改进路线图

### 7.1 风险矩阵

| 优先级 | 问题 | 影响 |
|-------|------|-----|
| **P0（立即）** | 单点故障 | 全站不可用 |
| **P0（立即）** | 企微通讯录未同步 | 权限控制缺少基础数据 |
| **P0（立即）** | RLS 未启用 | 无数据隔离 |
| **P0（立即）** | JWT 无吊销 | 离职用户 token 仍有效 |
| **P1（短期）** | Secrets 明文注入 | 日志泄露 |
| **P1（短期）** | 无 API 限流 | 滥用风险 |
| **P1（短期）** | 无监控告警 | 故障无感知（用户已知，单点部署） |
| **P2（中期）** | 无错误边界 | 页面崩溃 |
| **P2（中期）** | 无 Suspense/loading | 体验差 |
| **P2（中期）** | 缺少软删除 | 无法恢复 |
| **P2（中期）** | 审计不全 | 覆盖不全 |
| **P3（长期）** | 移动端适配不足 | 小屏体验一般 |
| **P3（长期）** | 鉴权环境检测滞后 | 混跳问题 |

> **注**：基础设施风险（单点故障、无备份）已降级，用户已知权衡，暂不处理。

### 7.2 修复路线图

**第一阶段：权限体系建设（P0）**

- 企微通讯录同步（新建 function: wecom-sync-contacts）
- 登录时 JWT 携带部门信息
- 报表表加 `allowed_departments` 字段
- 启用 RLS（reports/data_files/data_sources）
- JWT 吊销机制（黑名单表 + middleware 检查）

**第二阶段：可靠性提升（P1）**

- Secrets 加密传输
- API 限流（PostgREST PGRST_MAX_ROWS）
- 敏感字段脱敏（org_users.mobile/email）

**第三阶段：体验优化（P2-P3）**

- 前端错误边界 + Suspense
- 数据库软删除 + 外键约束
- 审计完善（前端 API 也写 query_logs）
- 移动端响应式优化
- 鉴权环境检测优先化改造

---

## 九、权限限制实现方案（用户确认）

### 9.1 方案选择

采用 **方案 A：RLS + 部门 ID**（数据库层强制隔离）

### 9.2 核心理念

```
企微通讯录同步 → 用户归属部门
     ↓
登录时 JWT 携带部门信息
     ↓
PostgreSQL RLS 策略：按部门过滤报表
     ↓
数据库层强制隔离，绕过应用层也无法越权
```

### 9.3 实现步骤

| 序号 | 改动 | 文件 |
|-----|------|------|
| 1 | 新建通讯录同步 function | `functions/wecom-sync-contacts/index.js` |
| 2 | 登录时查询部门 + JWT 加部门 | `functions/wecom-oauth/index.js` |
| 3 | 报表表加权限字段 | `database/migrations/004_report_permissions.sql` |
| 4 | 启用 RLS | `database/migrations/005_rls.sql` |
| 5 | 定时同步任务 | InsForge schedule 或 cron |

### 9.4 RLS 策略示例

```sql
-- 用户只能看到自己部门有权限的报表
CREATE POLICY reports_department_policy ON reports
  FOR SELECT TO authenticated
  USING (
    allowed_departments ?| string_to_array(
      current_setting('request.jwt.claims.departments', true),
      ','
    )
    OR allowed_departments = '["*"]'::jsonb  -- 全员可见
  );
```

---

## 十、关键结论

> 这是一个**功能完整但权限体系缺失**的 MVP 项目。认证链路已打通，但企微通讯录未同步、RLS 未启用，无法实现部门/员工级权限隔离。建议立即建设权限体系（通讯录同步 + RLS），再逐步优化体验。

**核心改进优先级**：
1. **立即**：企微通讯录同步 + RLS + JWT 吊销
2. **短期**：限流 + Secrets 加密
3. **中期**：错误处理 + 软删除 + 审计完善
4. **长期**：移动端优化 + 鉴权环境检测优先化

---

**下一步**：进入 writing-plans 阶段，制定详细实现计划。