# CLAUDE.md

## 架构变更规则（重要）

**所有代码实现必须严格按照架构文档执行。**

架构文档位置：`docs/architecture.md`

核心规则：
1. **架构先行**：任何新功能、改动必须先查看架构文档，确认架构是否支持
2. **变更流程**：如需修改架构，必须先征得用户同意 → 更新架构文档 → 再执行代码实现
3. **禁止擅自变更**：不得在未更新架构文档的情况下擅自改变服务拆分、数据流向、技术栈、存储方案等

这包括但不限于：
- 服务拆分/合并
- 技术栈更换
- 数据流向调整
- 组件新增/删除
- 存储方案变更
- 接口设计变更
- 鉴权方案变更

在讨论架构时，应给出完整的方案对比和推荐理由，等用户确认后再实施。

## 服务器 SSH 连接

目标服务器连接方式：

```
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@data.shanhaiyiguo.com
```

密钥文件：`/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem`

### 常用操作

```bash
# 连接服务器
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com

# 重启 InsForge 服务
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart insforge"

# 清理 Deno 缓存（用于更新 edge function）
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"

# 查看日志
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker logs deploy-insforge-1 --tail 50"

# 数据库操作
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c '<SQL>'"
```

## 部署流程

### 代码修改后的部署步骤

1. **优先使用 InsForge CLI 更新 edge function**（如果只修改了 function）
   ```bash
   # 通过 InsForge API 更新 function
   mcp__insforge__update-function --slug <function-name> --codeFile functions/<function-name>/index.js
   
   # 清理 Deno 缓存使更新生效
   ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
   ```

2. **否则推送到 GitHub 触发 CI/CD**
   ```bash
   git add . && git commit -m "feat: xxx" && git push origin main
   ```

3. **检查 GitHub Action 部署状态**
   ```bash
   gh run list --limit 3
   gh run watch  # 实时监控最新 run
   ```

4. **验证部署成功**
   - 检查前端：`https://data.shanhaiyiguo.com`
   - 检查 API：`curl -s https://data.shanhaiyiguo.com/api/health`
   - 检查 function：`curl -s -X POST https://data.shanhaiyiguo.com/functions/<function-name>`

### GitHub Action CI/CD

项目已配置自动部署：
- 推送到 `main` 分支自动触发
- 构建前端并部署到服务器
- 部署时间约 2-3 分钟

## 测试流程

### 在生产环境测试

1. **企微客户端测试**（推荐）
   - 在企微移动端/PC 端内打开链接测试
   - 测试登录、页面布局、功能等

2. **API 测试**
   ```bash
   # 测试通讯录同步
   curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
   
   # 测试健康检查
   curl -s https://data.shanhaiyiguo.com/api/health
   ```

3. **数据库验证**
   ```bash
   ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'SELECT * FROM org_users;'"
   ```

## 常见问题

### Deno 缓存导致 function 不更新
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

### 数据库权限问题
```bash
ssh -i "/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c 'GRANT INSERT, SELECT, UPDATE ON org_users, org_departments TO anon, authenticated;'"
```

### 重新登录获取姓名
- 清除浏览器 cookie 或访问 `/login` 触发重新授权

## 开发流程问题总结（2026-07-04）

### 核心问题

**每次新增功能都要反复调试，验证周期长，效率低。**

根因是 **验证周期太长** + **幂等设计缺失** + **环境配置碎片化**。

---

### 问题链分析

#### 案例：商品档案采集功能开发

**第一次失败**：迁移文件不幂等
- 触发器重复创建 → `ERROR: trigger already exists`
- INSERT 无 ON CONFLICT → `ERROR: duplicate key value`
- 修复：加 `DROP TRIGGER IF EXISTS` + `ON CONFLICT DO UPDATE`

**第二次失败**：VARCHAR 长度不够
- 商品名称/编号超长 → `ERROR: value too long for type character varying(100)`
- 修复：`ALTER COLUMN ... TYPE VARCHAR(200/500)`

**第三次失败**：GHA 部署失败
- `INSFORGE_API_KEY` 无效 → function 部署 401
- GHA Step 4 失败，跳过 Step 5（前端构建）
- 新增的 `/api/admin/collect-items` 路由未部署

**第四次失败**：环境变量读取错误
- `NEXT_PUBLIC_INSFORGE_ANON_KEY` 在容器中不存在
- 代码 fallback 到 `''`，PostgREST 返回 401

---

### 系统性问题清单

#### 1. API Key 管理不透明
- InsForge 的 API Key 生成/验证机制不明
- Key 过期或无效时无自动更新
- `deploy/.env` 中的 Key 可能是部署时生成，后失效

#### 2. GHA 部署脚本脆弱
- `deploy-functions.sh` 用 `curl -sf`（失败立即退出）
- 无 retry 或错误容忍机制
- Step 4 失败导致 Step 5 完全跳过

#### 3. 验证周期太长
- 本地无法完整测试（需要 InsForge + PostgREST + PostgreSQL 完整栈）
- push → GHA → 服务器验证，单次验证 30分钟-2小时
- 失败后诊断困难（SSH 查日志，多层调用链）

#### 4. 幂等设计缺失
- 迁移文件不幂等（trigger 重复创建、INSERT 无 ON CONFLICT）
- function 部署逻辑判断 POST/PUT，但 curl 404 检测可能失败

#### 5. 环境变量碎片化
- `INSFORGE_API_KEY` 在 `deploy/.env`（后端调用）
- `INSFORGE_API_KEY` 需注入 web 容器（SDK 使用）
- `NEXT_PUBLIC_INSFORGE_ANON_KEY` 前端专用
- 新增功能漏配变量就出问题

---

### 改进措施

#### 立即可做

**1. 迁移文件强制幂等模板**（已创建 `database/MIGRATION_TEMPLATE.md`）
```sql
-- 标准模板
DROP TRIGGER IF EXISTS xxx ON table;
CREATE TRIGGER xxx ...

INSERT INTO table (...) VALUES (...) ON CONFLICT (id) DO UPDATE SET ...;
```

**2. VARCHAR 字段统一大长度**
- 编号/编码：VARCHAR(200)
- 名称：VARCHAR(500)
- 类别/分类：VARCHAR(200)
- 状态/类型：VARCHAR(50)

**3. 本地快速测试脚本**
```bash
# 不走 GHA，直接在容器内测试
ssh server "docker exec deploy-web-1 node -e '<测试代码>'"
```

#### 中期改进

**4. 统一环境变量管理**
- 所有变量集中在 `deploy/.env`
- `docker-compose.prod.yml` 只引用 `${VAR}`
- 新增功能检查清单：后端 env + 前端 env + 容器注入

**5. GHA 部署容错**
- function 部署失败不阻断前端构建
- 关键步骤加 retry（3 次，间隔 5s）
- 失败时输出详细错误（不吞 `curl` 输出）

**6. InsForge API Key 自愈**
- 检测 Key 无效时自动重新生成
- 或部署脚本从 Dashboard 获取最新 Key

#### 长期改进

**7. 本地开发环境镜像生产**
- `docker-compose.dev.yml` 模拟完整栈
- 本地能测完整流程再 push

**8. 数据库 Schema 类型生成**
- 从 PostgreSQL 生成 TypeScript 类型
- 避免 VARCHAR 长度反复修改

---

### 新增功能开发检查清单

**代码开发**
- [ ] 迁移文件用幂等模板
- [ ] **外部系统数据字段用 TEXT，不要用 VARCHAR**
- [ ] 环境变量：后端 + 前端 + 容器注入

**本地验证**
- [ ] TypeScript 编译通过
- [ ] 迁移 SQL 语法正确
- [ ] 新增 API 路由存在

**部署验证**
- [ ] GHA 成功（5 steps 全绿）
- [ ] 容器镜像已更新（时间戳检查）
- [ ] 新功能可访问

**数据验证**
- [ ] 数据写入正确
- [ ] 权限正确（anon/authenticated）
- [ ] RLS 策略（如需要）

---

### 关键教训

| 问题 | 教训 |
|-----|-----|
| 迁移文件不幂等 | 所有 DDL 必须先 `DROP IF EXISTS` / `IF NOT EXISTS` |
| VARCHAR 反复改 | **外部系统数据一律用 TEXT，VARCHAR 只用于自己控制的枚举字段** |
| 环境变量漏配 | 新增功能必须检查三处：后端 env、前端 env、容器注入 |
| GHA 失阻断整个部署 | 关键步骤加容错，失败不阻断后续步骤 |
| 容器跑旧代码 | 部署后必须检查容器创建时间 vs 镜像构建时间 |
| API Key 无效 | 部署脚本检测 Key 有效性，无效时自动获取新 Key |
| nginx 配置语法错误 | location 必须在 server block 内，不能独立成文件 |
| PostgREST schema 缓存 | 修改表结构后必须重启 PostgREST |
