"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BackToTop } from "@/components/BackToTop";
import { ReportView } from "@/components/ReportView";
import { ResultActions } from "@/components/ResultActions";
import { isResultFresh, loadResult } from "@/lib/store";
import type { ReviewResult } from "@/lib/types";

/**
 * 结果页。
 *
 * 数据来自 localStorage（lib/store.ts）而不是 URL 参数或服务端存储——
 * 这是个单机练习工具，这样作文不会留在服务器上。代价是结果不能跨设备、跨浏览器，
 * 想要分享功能的话应该改成服务端存储 + 短 id。
 *
 * 换成 localStorage 之后，这一页能看到**任意旧**的报告（以前最多只能看到当前
 * 标签页里刚做的那份）。所以这里要对过期的报告明说一句——旧的照常显示，
 * 但别让它冒充刚出炉的。
 */
export default function ResultPage() {
  // 三态：null = 还没读；false = 读过了但没有；ReviewResult = 有
  const [result, setResult] = useState<ReviewResult | null | false>(null);
  // 新鲜度只在读出来的时候算一次，不跟着后续渲染重算
  const [fresh, setFresh] = useState(true);

  useEffect(() => {
    const stored = loadResult();
    if (stored) {
      setFresh(isResultFresh(stored.meta.createdAt, Date.now()));
    }
    setResult(stored ?? false);
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
            批改完成后会自动跳到这一页。报告存在这个浏览器里，
            <br />
            换一台设备或换一个浏览器就看不到了。
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

      {!fresh && (
        <div className="alert alert-warn">
          <strong>这不是刚生成的报告</strong>
          它生成于{" "}
          {new Date(result.meta.createdAt).toLocaleString("zh-CN", {
            hour12: false,
          })}
          。报告存在这个浏览器里，所以隔了一段时间再打开这一页，看到的还是上一次那篇。
          批改一篇新的就会把它覆盖掉。
        </div>
      )}

      <ResultActions result={result} />
      <ReportView result={result} />

      {/* 只挂在"有报告"这一支上：另外两支要么是空状态、要么还没读出来，短得滚不动，
          按钮自己也不会出现（它要滚过一屏才浮出来）。
          宽屏分栏之后这一页照样很长——左栏停住不动，但分数和结论会滚出去，
          所以回到顶部在这儿是真有用的 */}
      <BackToTop />
    </div>
  );
}
