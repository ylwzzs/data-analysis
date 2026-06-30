# web/Dockerfile
# Next.js 生产镜像（multi-stage + standalone）。
# build 时通过 --build-arg 注入 NEXT_PUBLIC_INSFORGE_URL / NEXT_PUBLIC_INSFORGE_ANON_KEY：
# NEXT_PUBLIC_* 会被内联进客户端产物，必须在 next build 之前就位（运行时改不了）。
#
# 构建示例：
#   docker build \
#     --build-arg NEXT_PUBLIC_INSFORGE_URL=https://data.example.com \
#     --build-arg NEXT_PUBLIC_INSFORGE_ANON_KEY=anon_xxx \
#     -t data-platform-web .
# 实际由 deploy/docker-compose.prod.yml 的 build.args 自动注入。

# ---------- 1. deps：安装依赖 ----------
FROM node:22-alpine AS deps
# 国内构建走 npmmirror 加速（官方源极慢）；海外构建可用
# --build-arg NPM_REGISTRY=https://registry.npmjs.org 覆盖
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry=$NPM_REGISTRY

# ---------- 2. builder：构建产物 ----------
FROM node:22-alpine AS builder
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* 内联到构建产物，需在 next build 之前作为 ENV 就位
ARG NEXT_PUBLIC_INSFORGE_URL
ARG NEXT_PUBLIC_INSFORGE_ANON_KEY
ENV NEXT_PUBLIC_INSFORGE_URL=$NEXT_PUBLIC_INSFORGE_URL
ENV NEXT_PUBLIC_INSFORGE_ANON_KEY=$NEXT_PUBLIC_INSFORGE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- 3. runner：最小运行镜像 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# standalone 产物自带最小 node_modules 与 server.js
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
