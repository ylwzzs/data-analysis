import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 明确项目根目录，避免 Next 向上查找时误将上层目录的 lockfile
  // （如 ~/package-lock.json）当作 workspace root。
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
