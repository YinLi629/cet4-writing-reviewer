import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * 开发模式下额外信任哪些来源。
   *
   * 默认只信 localhost。用 cloudflared / ngrok 这类隧道（或者手机连局域网 IP）
   * 打开 dev server 时，浏览器是带着**另一个 Origin** 去要 `/_next/*` 的，
   * Next.js 15.5 会拦掉，只留一行警告。
   *
   * ⚠️ 症状极具迷惑性：拦掉的是客户端 JS，不是 HTML。**页面照常显示**，
   * 但 React 从没水合，于是所有交互都是死的。口令页那个提交按钮尤其坑——
   * 它是**服务端渲染成 disabled 的**（初始 code 是空串），JS 不跑就没有 onChange，
   * 你输了口令按钮也永远不会变成可点。看着像"按钮坏了"，其实是整页没活过来。
   * 诊据：dev 日志里一条 `Cross origin request detected ... to /_next/*`，
   * 且浏览器**从未**发出 POST /api/access。
   *
   * 只在开发模式生效，`next build` 的产物不受影响。换别的隧道就照着加一条。
   */
  allowedDevOrigins: ["*.trycloudflare.com", "localhost:3000", "127.0.0.1:3000"],
};

export default nextConfig;
