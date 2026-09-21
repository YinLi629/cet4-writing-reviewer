"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ReportView } from "@/components/ReportView";
import { ResultActions } from "@/components/ResultActions";
import { loadResult } from "@/lib/store";
import type { ReviewResult } from "@/lib/types";

/**
 * 结果页。
 *
 * 数据来自 sessionStorage（lib/store.ts）而不是 URL 参数或服务端存储——
 * 这是个单机练习工具，这样作文不会留在服务器上。代价是结果不能跨标签页分享，
 * 想要分享功能的话应该改成服务端存储 + 短 id。
 */
export default function ResultPage() {
  // 三态：null = 还没读；false = 读过了但没有；ReviewResult = 有
  const [result, setResult] = useState<ReviewResult | null | false>(null);

  useEffect(() => {
    setResult(loadResult() ?? false);
  }, []);

  if (result === null) {
    return (
      <div className="container container-narrow">
        <div className="empty-state">
          <p>正在读取批改结果…</p>
        </div>
      </div>
    );
  }

  if (result === false) {
    return (
      <div className="container container-narrow">
        <div className="empty-state">
          <h2>没有找到批改结果</h2>
          <p>
            结果只保存在当前标签页里，关掉或换了标签页就没了。
            <br />
            重新提交一篇作文即可。
          </p>
          <Link href="/review" className="btn btn-primary">
            去批改作文
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="hero hero-compact">
        <h1>批改报告</h1>
        {result.meta.topic && (
          <p className="small">
            <strong>题目：</strong>
            {result.meta.topic}
          </p>
        )}
      </div>

      <ResultActions result={result} />
      <ReportView result={result} />
    </div>
  );
}
