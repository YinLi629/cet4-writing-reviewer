"use client";

import { segmentEssay } from "@/lib/highlight";
import { KIND_LABEL } from "@/lib/labels";
import type { Evidence } from "@/lib/types";

/**
 * 原文批注视图。
 *
 * 用的是和服务端 HTML 报告完全相同的 segmentEssay（lib/highlight.ts），
 * 所以网页上和下载的报告里高亮位置一定一致。
 *
 * 点高亮跳到对应证据卡片；点证据卡片上的「原文」链接则跳回这里。
 */
export function HighlightedEssay({
  essay,
  evidence,
}: {
  essay: string;
  evidence: Evidence[];
}) {
  const segments = segmentEssay(essay, evidence);
  const located = evidence.filter((e) => e.verified).length;

  /**
   * 跳到对应证据卡片，并让它闪一下。
   *
   * 闪烁直接改那张卡片的 class（.is-flash，见 globals.css）。原先的做法是往 DOM 里
   * 注入一个 <style> 标签——因为证据卡片在 EvidenceList 里，两个组件没有共享状态。
   * 那条路会在 DOM 里留下一堆只为一处高亮存在的 style 元素，改 class 就够了。
   */
  const jumpToCard = (id: string) => {
    const el = document.getElementById(`card-${id}`);
    if (!el) return;
    // 系统开了"减少动态效果"就不要平滑滚动：真正难受的是那段位移，不是闪烁
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });

    el.classList.remove("is-flash");
    void el.offsetWidth; // 强制回流：连着点同一个高亮两次，动画也要能重放
    el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), 1600);
  };

  return (
    <>
      <div className="essay-box">
        {segments.map((seg, i) => {
          if (!seg.kind) return <span key={i}>{seg.text}</span>;

          const primaryId = seg.ids[0];
          const extra = seg.ids.length > 1 ? `（另有 ${seg.ids.length - 1} 条证据指向此处）` : "";

          return (
            <mark
              key={i}
              className={`ev ev-${seg.kind}`}
              id={`anchor-${primaryId}`}
              title={`对应证据 ${seg.ids.join("、")}${extra} —— 点击查看`}
              role="button"
              tabIndex={0}
              onClick={() => jumpToCard(primaryId)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  jumpToCard(primaryId);
                }
              }}
            >
              {seg.text}
            </mark>
          );
        })}
      </div>

      <div className="legend">
        <span>
          <i className="k-strength" />
          {KIND_LABEL.strength}
        </span>
        <span>
          <i className="k-minor" />
          {KIND_LABEL.minor}
        </span>
        <span>
          <i className="k-major" />
          {KIND_LABEL.major}
        </span>
        <span className="muted">
          共 {evidence.length} 条证据，{located} 条已定位到原文
          {evidence.length > located ? `，${evidence.length - located} 条未能定位` : ""}
        </span>
      </div>
    </>
  );
}
