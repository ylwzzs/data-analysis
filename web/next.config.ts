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
};

export default nextConfig;
