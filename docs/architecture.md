# 数据分析平台完整架构文档

> **重要：所有代码实现必须严格按照此架构执行。任何架构变更必须先征得用户同意并更新此文档后再执行。**

---

## 系统总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          数据分析平台架构                                     │
│                          data.shanhaiyiguo.com                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户访问                                                                    │
│  ├── PC 端：企微桌面 / 浏览器                                                │
│  └── 移动端：企微 App                                                        │
│       │                                                                     │
│       ▼                                                                     │
│  nginx 网关（80/443）                                                        │
│  ├── SSL/TLS（Let's Encrypt）                                               │
│  ├── 反向代理                                                                │
│  └── 静态资源                                                                │
│       │                                                                     │
│       ├──► Next.js web（3000）                                               │
│       ├──► InsForge API（7130）                                              │
│       └──► OpenClaw Gateway（18789）                                         │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      核心服务层                                      │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  InsForge 栈                                                        │   │
│  │  ├── postgres（5432）        → PostgreSQL 数据库                    │   │
│  │  ├── postgrest（3000）       → REST API 自动生成                    │   │
│  │  ├── insforge（7130）        → 管理服务 + Edge Function 管理        │   │
│  │  └── deno（7133）            → Edge Function 运行时                 │   │
│  │                                                                     │   │
│  │  数据处理                                                           │   │
│  │  ├── duckdb（9000）          → 三角色服务（转换/计算/查询）          │   │
│  │                                                                     │   │
│  │  前端                                                               │   │
│  │  ├── web（3000）             → Next.js 应用                         │   │
│  │                                                                     │   │
│  │  Agent                                                              │   │
│  │  ├── openclaw（18789）       → 智能助手 + 自然语言查询              │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      外部服务                                        │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │                                                                     │   │
│  │  数据源                                                             │   │
│  │  ├── 乐檬 API                 → 销售数据采集                        │   │
│  │  ├── 美团 API                 → 待接入                              │   │
│  │  ├── 饿了么 API               → 待接入                              │   │
│  │                                                                     │   │
│  │  企业微信                                                           │   │
│  │  ├── OAuth                    → 用户登录                            │   │
│  │  ├── 通讯录 API               → 部门/用户同步                       │   │
│  │  └── 消息推送                 → 告警通知                            │   │
│  │                                                                     │   │
│  │  天翼云 OOS                                                          │   │
│  │  ├── Parquet 存储             → 明细数据归档                        │   │
│  │  └── 内网 endpoint             → 加速访问                            │   │
│  │                                                                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 一、InsForge 核心栈

### 1.1 PostgreSQL（postgres:5432）

**职责**：核心数据存储

**主要表结构**：

| 表名 | 用途 | 数据量 |
|------|------|--------|
| `reports` | 报表定义 | 几十条 |
| `data_files` | 数据文件元数据 | 几百条 |
| `data_sources` | 数据源配置 | 几十条 |
| `auth_credentials` | 数据源凭证（AES加密） | 几十条 |
| `collect_tasks` | 采集任务配置 | 几十条 |
| `collect_logs` | 采集执行日志 | 几千条/天 |
| `org_users` | 企业微信用户 | 几百条 |
| `org_departments` | 企业微信部门 | 几十条 |
| `data_permissions` | 数据权限配置 | 几十条 |
| `report_daily_sales` | 每日门店销售汇总 | 几百条/天 |
| `report_daily_category` | 每日品类汇总 | 几十条/天 |
| `report_weekly_trend` | 周趋势汇总 | 几百条/周 |

**权限模型**：
- Role：`anon`（匿名）、`authenticated`（已登录）、`admin`（管理员）
- RLS：行级安全策略，按部门过滤数据

**连接方式**：
```bash
# SSH 到服务器后
docker exec deploy-postgres-1 psql -U postgres -d insforge
```

---

### 1.2 PostgREST（postgrest:3000）

**职责**：自动 REST API 生成

**工作原理**：
- 读取 PostgreSQL schema
- 自动生成 REST API
- JWT 鉴权 → RLS 策略生效

**API 示例**：
```
GET  /reports                 → 查询报表列表
GET  /reports?id=eq.xxx       → 查询指定报表
POST /collect_logs            → 写入采集日志
```

**鉴权**：
- Header：`Authorization: Bearer <JWT>`
- JWT payload 包含：`sub`（用户ID）、`role`、`departments`（部门列表）

---

### 1.3 InsForge（insforge:7130）

**职责**：管理服务 + Edge Function 管理

**核心功能**：
- 用户/权限管理
- Edge Function CRUD
- Secret 管理
- Storage 管理
- Realtime pub/sub

**端口**：
- 内网：`insforge:7130`
- 外网：通过 nginx 反向代理

**管理界面**：仅管理员可访问（`ADMIN_USERIDS` 白名单）

---

### 1.4 Deno Runtime（deno:7133）

**职责**：Edge Function 运行时

**特性**：
- Deno 环境（CommonJS 模式）
- 60s 超时限制
- Secrets 通过 InsForge API 注入

**已部署 Function**：
| Function | 用途 | 状态 |
|----------|------|------|
| `wecom-oauth` | 企微登录 | ✅ |
| `wecom-sync-contacts` | 通讯录同步 | ✅ |
| `scheduler` | 定时调度调度器 | ✅（备用） |

**注意事项**：
- `Deno.env.get()` 只能读取 function secrets，不能读取 docker-compose env
- 更新 function 后需清理缓存：
  ```bash
  docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno
  ```

---

## 二、数据处理层

### 2.1 DuckDB 服务（duckdb:9000）

**职责**：三角色数据处理服务

```
┌─────────────────────────────────────────────────────────────────┐
│  DuckDB :memory:                                                │
│  端口：9000（内网）                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  角色 1：数据转换                                                │
│  端点：POST /transform                                           │
│  ├── 输入：JSON 明细数据 + 配置                                  │
│  ├── 处理：校验、去重、分片                                       │
│  ├── 输出：Parquet 写入 OOS                                      │
│  └── 状态：✅ 已实现                                             │
│                                                                 │
│  角色 2：计算引擎                                                 │
│  端点：POST /compute                                             │
│  ├── 输入：报表类型 + 日期范围                                    │
│  ├── 处理：read_parquet(OOS) → 聚合计算                          │
│  ├── 输出：结果写入 PostgreSQL                                   │
│  ├── 报表类型：daily_sales / daily_category / weekly_trend      │
│  └── 状态：✅ 已实现                                             │
│                                                                 │
│  角色 3：个性化查询                                               │
│  端点：POST /query                                               │
│  ├── 输入：SQL（OpenClaw 生成）                                   │
│  ├── 处理：鉴权 → read_parquet(OOS) → 执行                       │
│  ├── 输出：查询结果                                               │
│  ├── 鉴权：⏳ 待讨论                                             │
│  └── 状态：⏳ 待实现                                             │
│                                                                 │
│  其他端点：                                                      │
│  ├── GET /health → 健康检查                                     │
│  └── GET /schema → OOS 文件列表                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**S3 配置**：
- Endpoint：`http://xinan-1-internal.zos.ctyun.cn`（内网）
- Bucket：`lemeng-datasource`

**注意事项**：
- 所有列使用 VARCHAR（避免 BigInt 类型混合）
- `CAST(COUNT(*) AS INTEGER)` 避免 BigInt 返回
- 代码在镜像内，修改后需重建镜像

---

## 三、前端层

### 3.1 Next.js Web（web:3000）

**职责**：前端应用 + API Routes

**主要页面**：

| 路径 | 用途 | 鉴权 |
|------|------|------|
| `/login` | 登录页 | 无 |
| `/auth/callback` | 企微回调 | 无 |
| `/` | PC 首页/报表列表 | JWT |
| `/reports/:id` | 报表详情 | JWT |
| `/mobile` | 移动首页 | JWT |
| `/admin/*` | 管理后台 | admin 白名单 |

**API Routes**：

| 路径 | 用途 | 鉴权 |
|------|------|------|
| `/api/admin/collect-lemeng` | 乐檬采集触发 | admin |
| `/api/admin/collect-tasks` | 任务管理 | admin |
| `/api/admin/scheduler/reload` | 调度器管理 | admin |
| `/api/auth/logout` | 登出 | JWT |

**环境变量**：

| 变量 | 用途 |
|------|------|
| `INSFORGE_API_BASE` | InsForge API 地址 |
| `INSFORGE_API_KEY` | anon_key |
| `LEMENG_SECRET_KEY` | 乐檬签名密钥 |
| `DUCKDB_URL` | DuckDB 服务地址 |
| `WECOM_*` | 企微配置 |

**定时调度**：
- 使用 node-cron
- 位于 `lib/scheduler.ts`
- 首次 API 调用时初始化
- 时区：Asia/Shanghai

---

### 3.2 nginx 网关

**职责**：SSL/TLS + 反向代理

**配置**：
- Let's Encrypt 自动证书
- 反向代理到 web:3000、insforge:7130、openclaw:18789
- 静态资源缓存

**企微可信域名验证**：
- `/WW_verify_*.txt` 文件

---

## 四、智能助手层

### 4.1 OpenClaw（openclaw:18789）

**职责**：Agent 服务 + 自然语言查询

**核心功能**：
- 自然语言意图解析
- SQL 生成
- 调用 DuckDB /query 执行查询
- 返回自然语言回答

**端口**：
- 内网：`openclaw:18789`
- 外网：通过 nginx 反向代理（仅管理员）

**配置**：
- Gateway token 认证
- wishub API key（模型提供商）

**集成方式**：
```
用户提问 → OpenClaw → 生成 SQL → DuckDB /query → 返回结果
```

---

## 五、数据采集系统

### 5.1 采集流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  定时触发（node-cron）                                                   │
│  └── 凌晨 2:00                                                          │
│       │                                                                 │
│       ▼                                                                 │
│  Next.js API Route                                                       │
│  ├── /api/admin/collect-lemeng                                          │
│  ├── 调用乐檬 API（分页拉取）                                            │
│  ├── 扁平化嵌套数据                                                      │
│       │                                                                 │
│       ▼                                                                 │
│  DuckDB /transform                                                       │
│  ├── 校验必填字段                                                        │
│  ├── 去重（order_no + order_detail_num）                                 │
│  ├── 按门店分片                                                          │
│  ├── 写入 OOS Parquet                                                   │
│       │                                                                 │
│       ├──► DuckDB /compute（自动触发）                                   │
│       │        │                                                        │
│       │        └──► PostgreSQL 汇总表                                    │
│       │                                                                 │
│       └──► 写入 collect_logs                                            │
│                                                                         │
│  对账重试：3 次                                                          │
│  ├── 不完整 → 5秒后重试                                                  │
│  ├── 3次均失败 → 企微告警                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 数据存储分层

| 层级 | 存储 | 数据 | 查询频率 |
|------|------|------|----------|
| **冷数据** | OOS Parquet | 明细数据（几万条/天） | 低（按需） |
| **热数据** | PostgreSQL | 汇总结果（几百条/天） | 高（分钟级） |

---

## 六、鉴权系统

### 6.1 登录流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  用户访问                                                                │
│       │                                                                 │
│       ▼                                                                 │
│  判断环境                                                                │
│  ├── 企微环境 → 静默 OAuth                                               │
│  ├── 浏览器 → 扫码登录                                                   │
│       │                                                                 │
│       ▼                                                                 │
│  wecom-oauth function                                                    │
│  ├── 企微 code → userid                                                  │
│  ├── upsert org_users                                                    │
│  ├── 签 JWT（含 departments）                                            │
│       │                                                                 │
│       ▼                                                                 │
│  callback 页面                                                           │
│  ├── 写 httpOnly cookie                                                  │
│  └── 写 localStorage（userid 展示）                                      │
│       │                                                                 │
│       ▼                                                                 │
│  middleware                                                              │
│  ├── 检查 cookie                                                         │
│  ├── 无 → 重定向 /login                                                  │
│  ├── 有 → 继续访问                                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 PostgreSQL RLS 鉴权

```
企微通讯录同步 → 用户归属部门
     ↓
登录时 JWT 携带 departments 字段
     ↓
PostgREST 请求带 Authorization: Bearer <JWT>
     ↓
PostgreSQL RLS 策略
     ↓
WHERE departments ?| current_setting('request.jwt.claims.departments')
     ↓
数据库层强制隔离
```

**权限表**：
- `org_users`：用户信息 + department_ids
- `org_departments`：部门信息 + branch_nums（可访问门店）
- `data_permissions`：部门权限配置

### 6.3 DuckDB /query 鉴权

```
OpenClaw 生成 SQL
     ↓
前端 JWT 提取 departments
     ↓
DuckDB 查询 data_permissions
     ↓
注入 branch_num 过滤条件
     ↓
执行 SQL（只返回允许的数据）
```

**鉴权逻辑**：⏳ 待讨论

---

## 七、外部服务集成

### 7.1 企业微信

**配置**：
- Corp ID：`ww8252c1eee248867c`
- Agent ID：`1000008`
- Secret：`WECOM_SECRET` / `WECOM_CONTACTS_SECRET`

**功能**：
| 功能 | API | 状态 |
|------|-----|------|
| 登录 OAuth | `/cgi-bin/oauth2/authorize` | ✅ |
| 用户信息 | `/cgi-bin/user/getuserinfo` | ✅ |
| 部门列表 | `/cgi-bin/department/list` | ✅ |
| 用户列表 | `/cgi-bin/user/list` | ✅ |
| 消息推送 | `/cgi-bin/message/send` | ✅ |

### 7.2 乐檬数据源

**API 地址**：`https://sharef.lemengcloud.com`

**签名算法**：
```
SHA256(auth + timestamp + nonce + branch_nums + scope_ids + SECRET_KEY + url + body + SECRET_KEY)
```

**Secret Key**：`LEMENG_SECRET_KEY`

**采集接口**：
| 接口 | 用途 |
|------|------|
| `/earth-gateway/.../findposorderdetail` | 订单明细 |
| `/earth-gateway/.../countposorderdetail` | 订单计数 |

### 7.3 天翼云 OOS

**配置**：
- Endpoint（内网）：`http://xinan-1-internal.zos.ctyun.cn`
- Endpoint（外网）：`http://xinan-1.zos.ctyun.cn`
- Bucket：`lemeng-datasource`
- Access Key：`OOS_ACCESS_KEY`
- Secret Key：`OOS_SECRET_KEY`

**存储结构**：
```
lemeng-datasource/
└── lemeng/retail_detail/{date}/
    ├── all.parquet              → 合并文件
    ├── branch_num_*.parquet     → 门店分片
    └── _quarantine.parquet      → 校验异常数据
```

---

## 八、运维与监控

### 8.1 告警通知

**企微应用消息**：
- 采集不完整（3次重试后）
- Token 过期
- 采集异常

**实现**：`lib/notify.ts` → `notifyWecom()`

### 8.2 日志查看

```bash
# InsForge 日志
docker logs deploy-insforge-1 --tail 50

# DuckDB 日志
docker logs deploy-duckdb-1 --tail 50

# Web 日志
docker logs deploy-web-1 --tail 50

# Deno 日志
docker logs deploy-deno-1 --tail 50
```

### 8.3 常用运维命令

```bash
# 重启服务
docker compose restart <service>

# 清理 Deno 缓存（更新 function）
docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno

# 数据库操作
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "<SQL>"
```

---

## 九、已确认的架构决策

| 决策项 | 确认结果 | 确认日期 |
|--------|---------|---------|
| InsForge 核心栈部署 | docker-compose 编排 | 早期 |
| PostgREST 自动 API | 已启用 | 早期 |
| DuckDB 单服务三角色 | 转换/计算/查询 | 2026-07-04 |
| 定时调度位置 | node-cron（Next.js 内） | 2026-07-04 |
| 采集逻辑位置 | Next.js API Route | 早期 |
| 明细数据存储 | OOS Parquet（60天） | 2026-07-04 |
| 汇总数据存储 | PostgreSQL | 2026-07-04 |
| 报表查询 | PostgreSQL + PostgREST | 2026-07-04 |
| PostgreSQL 鉴权 | RLS + 部门 ID | 早期 |
| DuckDB /query 鉴权 | 待讨论 | 2026-07-04 |
| OpenClaw 集成 | 自然语言查询 | 早期 |

---

## 十、待实现/待讨论

| 项目 | 状态 | 备注 |
|------|------|------|
| DuckDB /compute 端点 | ✅ 已实现 | 标准报表计算 |
| PostgreSQL 汇总表 | ✅ 已创建 | report_daily_sales 等 |
| 采集后自动触发计算 | ⏳ 待实现 | transform → compute |
| DuckDB /query 鉴权 | ⏳ 待讨论 | OpenClaw 个性化查询 |
| OpenClaw 集成 | ⏳ 待实现 | SQL 生成 + /query 调用 |
| 美团数据源接入 | ⏳ 待讨论 | 架构待确认 |
| 饿了么数据源接入 | ⏳ 待讨论 | 架构待确认 |

---

## 十一、架构变更流程

1. 发现需要变更的需求
2. 提出变更方案 + 方案对比 + 推荐理由
3. 征得用户同意
4. 更新此架构文档
5. 执行代码实现
6. 验证变更效果

**禁止行为**：
- 未更新架构文档直接修改代码
- 擅自改变服务拆分/数据流向
- 未经同意引入新技术栈/外部服务