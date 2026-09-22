"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buildReportHtml } from "@/lib/report-html";
import { clearResult, downloadReport, reportFilename, saveDraft } from "@/lib/store";
import type { ReviewResult } from "@/lib/types";

/**
 * 结果页的操作条：下载 HTML 报告 / 打印 / 返回输入界面 / 再批一篇。
 *
 * 报告是在浏览器端用 buildReportHtml 现场生成的——同一个函数，
 * 只是把 React 渲染换成拼字符串，所以下载下来的报告内容和页面上看到的一致。
 *
 * 「返回输入界面」和「批改另一篇」**不是同一件事**，两个都留着是有意的：
 *   · 返回 —— 报告原封不动地留着（它还能再下载），只是回输入页；
 *   · 再批一篇 —— 把报告清掉，等于表态"这份我不要了"。
 * 少了前者，用户想回去改一下原文再批一次时，唯一的路是那个会删报告的按钮。
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

  /**
   * 回输入页，但**不动这份报告**。
   *
   * 顺手把原文写回草稿：用户点这个按钮想要的不是"看一个空表单"，而是把这篇文章
   * 拿回去改。原文就在这份报告里，让他重新手打一遍是最差的选择。
   *
   * 落成草稿而不是直接把文本塞进表单，是因为输入页现在把草稿摆成一个「恢复它」
   * 按钮（见 EssayForm 的 pendingDraft），这条路径正是那个按钮的用途之一。
   * 代价是**目标档次带不回来**——它没被写进 ReviewResult（meta 里只有题目），
   * 要不要补进契约是另一个决定，这里不顺手改数据结构。
   */
  const handleBack = () => {
    saveDraft({ essay: result.essay, topic: result.meta.topic, targetBandLevel: "" });
    router.push("/review");
  };

  const handleNew = () => {
    clearResult();
    // 回批改页，不是首页：首页是那个开播页，从这里跳回去等于把人赶出流程
    router.push("/review");
  };

  return (
    <div className="row-between result-actions">
      <div className="btn-row">
        <button type="button" className="btn btn-primary" onClick={handleDownload} disabled={busy}>
          下载 HTML 批改报告
        </button>
        <button type="button" className="btn" onClick={() => window.print()}>
          打印 / 存 PDF
        </button>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn"
          onClick={handleBack}
          title="回输入页，这份报告仍然留在这个浏览器上"
        >
          返回输入界面
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleNew}
          title="清掉这份报告，回输入页写新的一篇"
        >
          批改另一篇
        </button>
      </div>
    </div>
  );
}
