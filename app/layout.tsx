import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "四级作文批改",
  description:
    "CET-4 作文批改工具：档次判定、分数折算、逐条证据溯源、升档建议与可下载的 HTML 批改报告。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              四级作文批改
              <span>证据溯源版</span>
            </Link>
            <div className="header-spacer" />
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
