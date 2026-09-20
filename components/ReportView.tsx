import type { ReviewResult } from "@/lib/types";

import { BandCard } from "./BandCard";
import { EvidenceList } from "./EvidenceList";
import { HighlightedEssay } from "./HighlightedEssay";
import { UpgradePlan } from "./UpgradePlan";

/**
 * 结果页主体。
 *
 * 顺序是有意安排的：先给结论（档次/分数），再给总评与维度，然后才是
 * 行动项（升档建议），最后是支撑材料（证据列表 + 原文批注）。
 * 用户先知道"我多少分、该干什么"，想深究时再往下看依据。
 */
export function ReportView({ result }: { result: ReviewResult }) {
  return (
    <>
      {result.warnings.length > 0 && (
        <div className="alert alert-warn">
          <strong>关于这份报告的可信度</strong>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <BandCard result={result} />

      <h2 className="section-title">升档建议</h2>
      <UpgradePlan plan={result.upgradePlan} />

      <h2 className="section-title">
        证据溯源
        <span className="muted small" style={{ fontWeight: 400, marginLeft: 10 }}>
          每条判断都对应原文的具体位置
        </span>
      </h2>
      <EvidenceList evidence={result.evidence} />

      <h2 className="section-title">
        原文批注
        <span className="muted small" style={{ fontWeight: 400, marginLeft: 10 }}>
          点击高亮可跳到对应证据
        </span>
      </h2>
      <HighlightedEssay essay={result.essay} evidence={result.evidence} />

      <p className="note" style={{ marginTop: 24 }}>
        批改模型：{result.meta.model}　·　耗时 {(result.meta.elapsedMs / 1000).toFixed(1)} 秒　·
        标准版本 {result.meta.rubricVersion}　·　生成于{" "}
        {new Date(result.meta.createdAt).toLocaleString("zh-CN", { hour12: false })}
      </p>
    </>
  );
}
