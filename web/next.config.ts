import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产构建输出 standalone 产物（自带最小 node_modules + server.js），
  // 供 Dockerfile 的 runner 阶段打包成最小镜像。
  output: "standalone",
  // 明确项目根目录，避免 Next 向上查找时误将上层目录的 lockfile
  // （如 ~/package-lock.json）当作 workspace root。
  turbopack: {
    root: __dirname,
  },
  // 禁 client router cache（RSC payload 缓存），避免跨设备(PC↔移动) stale RSC 致移动端 client navigation 先闪PC再切移动
  experimental: {
    staleTimes: { static: 30, dynamic: 0 },
  },
};

export default nextConfig;
