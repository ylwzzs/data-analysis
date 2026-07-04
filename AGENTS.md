# AGENTS.md

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

## 🔴 质量控制规范（必须执行）

### 1. 设置 Git Hooks（首次必须执行）

```bash
bash scripts/setup-hooks.sh
```

这会启用 pre-commit hook，在每次 `git commit` 前自动运行：
- **lint-staged**: 对修改的 ts/tsx 文件运行 ESLint
- **check-functions.sh**: 检查所有 Edge Function 的语法和结构

### 2. 推送前必须自检

```bash
# 方式一：直接运行完整检查（推荐）
bash scripts/check-functions.sh && cd web && npm run lint && npx tsc --noEmit

# 方式二：让 CI 来检查（推送后 GitHub Actions 会自动运行）
# 但如果 CI 失败，部署会被阻断，需要重新修复推送
```

### 3. CI 质量门禁

每次推送到 `main` 分支，GitHub Actions 会自动运行：
- **Lint**: ESLint 检查前端代码
- **Type Check**: TypeScript 类型检查
- **Function Check**: Edge Function 语法检查

**只有所有检查通过才会部署到生产环境。**

### 4. Edge Function 开发规范

- 每个 function 必须有 `index.js` 或 `index.ts`
- JavaScript 文件必须有 `module.exports = async function(request) { ... }`
- TypeScript 文件必须有导出或 `serve()` (Deno)

### 5. 数据库迁移规范

- 所有迁移脚本必须幂等（使用 `IF NOT EXISTS` / `CREATE OR REPLACE`)
- 迁移末尾加验证断言避免重复创建
- 提交前本地先跑 `bash scripts/migrate.sh` 验证

## 部署流程

### 代码修改后的部署步骤

1. **优先使用 InsForge CLI 更新 edge function**（如果只修改了 function）
   ```bash
   # 通过 InsForge API 更新 function
   mcp__insforge__update_function --slug <function-name> --codeFile functions/<function-name>/index.js
   
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
- 先运行质量门禁（lint + type-check + function check）
- 只有通过检查才会部署到服务器
- 部署时间约 3-4 分钟

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

### CI 质量门禁失败

```bash
# 查看失败原因
gh run view

# 本地运行同样的检查
bash scripts/check-functions.sh
cd web && npm run lint && npx tsc --noEmit
```

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
