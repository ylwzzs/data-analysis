# deploy/nginx/user_conf.d/server.conf.tpl
# nginx 网关配置模板（jonasal/nginx-certbot 会自动签发并填入 Let's Encrypt 证书）。
# __DOMAIN__ 由 scripts/deploy.sh 从 .env 的 DOMAIN 替换为真实域名，生成同目录 server.conf。
#
# 流量分流：
#   / /mobile /reports /sources /settings /auth/*  → web:3000（前端 Next.js，含 OAuth 回调页）
#   /api /functions /dashboard /mcp               → insforge:7130（InsForge API + edge function）
# 注意：本项目用企微自建 OAuth（不走 InsForge auth provider），InsForge 7131 不对外，
#       避免劫持前端的 /auth/callback 路由。

server {
    listen 443 ssl;
    http2 on;
    server_name __DOMAIN__;

    # 证书由 nginx-certbot 自动签发到 /etc/letsencrypt/live/<domain>/
    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 数据导入等上传体积
    client_max_body_size 50m;

    # 企微可信域名验证文件（域名根路径，由 deploy/nginx/verify/ 挂载）
    location ~ ^/WW_verify_.*\.txt$ {
        root /etc/nginx/verify;
        default_type text/plain;
    }

    # ---------- 前端 Next.js（默认路由，含所有页面与 /auth/callback）----------
    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- InsForge API ----------
    location /api {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---------- InsForge Edge Functions ----------
    location /functions {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }

    # ---------- InsForge Dashboard ----------
    location /dashboard {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # ---------- MCP Server（edge function 代理，长超时）----------
    location /mcp {
        proxy_pass http://insforge:7130;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
