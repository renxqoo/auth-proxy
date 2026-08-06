import type { NextConfig } from "next";

/**
 * admin-web 配置。
 *
 * rewrites:把 /admin/web/* 同源代理到中间层 server。
 *   这样浏览器页面和 server API 同源,session cookie 自动携带,无跨域问题。
 *   开发期:server 跑在 localhost:3000
 *   生产:server 在 docker 内网(server:3000),由 nginx 统一入口
 */
const serverBase = process.env.SERVER_BASE_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  output: "standalone", // docker 用:产物自包含
  basePath: "/admin", // nginx 把 /admin/* 路由到这里;页面用 /admin 前缀
  async rewrites() {
    return [
      {
        source: "/web/:path*", // basePath 下:/admin/web/* → server
        destination: `${serverBase}/admin/web/:path*`,
      },
    ];
  },
};

export default nextConfig;
