"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buildReportHtml } from "@/lib/report-html";
import { clearResult, downloadReport, reportFilename } from "@/lib/store";
import type { ReviewResult } from "@/lib/types";

/**
 * 结果页的操作条：下载 HTML 报告 / 打印 / 再批一篇。
 *
 * 报告是在浏览器端用 buildReportHtml 现场生成的——同一个函数，
 * 只是把 React 渲染换成拼字符串，所以下载下来的报告内容和页面上看到的一致。
 */
export function ResultActions({ result }: { result: ReviewResult }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const handleDownload = () => {
    setBusy(true);
    try {
      const html = buildReportHtml(result);
      downloadReport(html, reportFilename(result));
    } finally {
      setBusy(false);
    }
  };

  const handleNew = () => {
    clearResult();
    router.push("/");
  };

  return (
    <div className="row-between" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" onClick={handleDownload} disabled={busy}>
          下载 HTML 批改报告
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          打印 / 存 PDF
        </button>
      </div>

      <button type="button" className="btn btn-ghost" onClick={handleNew}>
        批改另一篇
      </button>
    </div>
  );
}
