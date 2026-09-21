import type { ReviewResult } from "@/lib/types";

import { BandCard } from "./BandCard";
import { EvidenceList } from "./EvidenceList";
import { HighlightedEssay } from "./HighlightedEssay";
import { UpgradePlan } from "./UpgradePlan";

import { Reveal } from "./Reveal";

/**
 * 结果页主体。
 *
 * 顺序是有意安排的：先给结论（档次/分数），再给总评与维度，然后才是
 * 行动项（升档建议），最后是支撑材料（证据列表 + 原文批注）。
 * 用户先知道"我多少分、该干什么"，想深究时再往下看依据。
 *
 * 每一节套一层 Reveal（往下滚时上移淡入）。能用在这里，是因为这一页的数据
 * 一次性到位、渲染完就不动了；流式视图里每个 SSE 帧都在替换子节点，进场动画
 * 会被反复重放，所以那边一个都没有。
 */
export function ReportView({ result }: { result: ReviewResult }) {
  return (
    <>
      {result.warnings.length > 0 && (
        <Reveal>
          <div className="alert alert-warn">
            <strong>关于这份报告的可信度</strong>
            <ul>
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </Reveal>
      )}

      {/* 60ms 的延迟：让分数板跟在标题后面落定，而不是和它抢同一帧 */}
      <Reveal delayMs={60}>
        <BandCard result={result} />
      </Reveal>

      <Reveal>
        <h2 className="section-title">升档建议</h2>
        <UpgradePlan plan={result.upgradePlan} />
      </Reveal>

      <Reveal>
        <h2 className="section-title">
          证据溯源
          <span className="section-sub">每条判断都对应原文的具体位置</span>
        </h2>
        <EvidenceList evidence={result.evidence} />
      </Reveal>

      <Reveal>
        <h2 className="section-title">
          原文批注
          <span className="section-sub">点击高亮可跳到对应证据</span>
        </h2>
        <HighlightedEssay essay={result.essay} evidence={result.evidence} />
      </Reveal>

      <p className="note report-meta">
        批改模型：{result.meta.model}　·　耗时 {(result.meta.elapsedMs / 1000).toFixed(1)} 秒　·
        标准版本 {result.meta.rubricVersion}　·　生成于{" "}
        {new Date(result.meta.createdAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
    </>
  );
}
