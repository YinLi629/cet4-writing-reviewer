import type { Metadata, Viewport } from "next";
import Link from "next/link";

import { ThemeToggle } from "@/components/ThemeToggle";
import { buildThemeScript, THEME_COLORS } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "四级作文批改",
  description:
    "CET-4 作文批改工具：档次判定、分数折算、逐条证据溯源、升档建议与可下载的 HTML 批改报告。",
};

export const viewport: Viewport = {
  // 浅色是默认。用户在开关里选了深色时，那段内联脚本和 applyTheme 会改这个 meta。
  // 这里不用 viewport.themeColor 的媒体查询写法：用户手动选的深浅和系统偏好
  // 可以不一致，那时媒体查询给出的颜色是错的。
  themeColor: THEME_COLORS.light,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning 是因为下面那段脚本在 React 水合之前就往 <html> 上
    // 写了 data-theme / data-reveal-ready，服务端渲染的 HTML 里没有这两个属性
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 必须阻塞、必须在水合之前：晚一帧就会先闪一下浅色 */}
        <script dangerouslySetInnerHTML={{ __html: buildThemeScript() }} />
      </head>
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                <svg viewBox="0 0 32 32" fill="none">
                  <path
                    d="M9.5 16.5l4.4 4.4L22.6 11.6"
                    stroke="currentColor"
                    strokeWidth="3.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              四级作文批改
              <span>证据溯源版</span>
            </Link>
            <div className="header-spacer" />
            <ThemeToggle />
          </div>
        </header>

        <main>{children}</main>

        <div className="container">
          <footer className="site-footer">
            评分依据 CET-4 作文整体评分法（15 分制，折算满分 106.5 分）。
            <br />
            结果为模型辅助评判，仅供练习参考，不代表真实考试成绩。作文内容仅用于本次批改，不落库存储。
          </footer>
        </div>
      </body>
    </html>
  );
}
