# CLAUDE.md

## 服务器 SSH 连接

目标服务器连接方式：

```
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@<服务器IP或域名>
```

密钥文件：`/Users/Duo/WPS 云文档/其他/ShanHai-OPS.pem`

### 常用操作

```bash
# 连接服务器
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@DataAnalysis

# 重启 InsForge 服务
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@DataAnalysis "cd /opt/data-analytics-platform/deploy && docker compose restart insforge"

# 清理 Deno 缓存
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@DataAnalysis "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"

# 查看日志
ssh -i /Users/Duo/WPS\ 云文档/其他/ShanHai-OPS.pem root@DataAnalysis "docker logs deploy-insforge-1 --tail 50"
```
