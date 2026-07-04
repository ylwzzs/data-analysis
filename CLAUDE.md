# CLAUDE.md

## 架构变更规则（重要）

**架构和方案一旦确定，不得擅自更改。任何架构调整、方案变更必须先征得用户同意后再执行。**

这包括但不限于：
- 服务拆分/合并
- 技术栈更换
- 数据流向调整
- 组件新增/删除
- 存储方案变更

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
