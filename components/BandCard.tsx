import type { ReviewResult } from "@/lib/types";

import { DiagnosisCard } from "./DiagnosisCard";

/**
 * 分数板：档次 + 15 分制 + 106.5 分制折算 + 官方档位描述 + 硬统计。
 *
 * 这里显示的档次是服务端按分数查表得到的（见 lib/rubric.ts 的 bandForScore），
 * 不是模型自己报的，所以它和分数永远自洽。
 *
 * 总评往后的内容在 DiagnosisCard 里——流式视图要单独用它，而分数板不能提前出现
 * （分数要等上限校正，提前显示会当场跳一次），所以两者必须能分开渲染。
 */
export function BandCard({ result }: { result: ReviewResult }) {
  const { band, score15, score106, stats } = result;

  return (
    <>
      <div className="scoreboard">
        <div className="score-main">
          {/* score-settled 是一次性的落定（缩放+淡入），不是数字滚动：
              滚动会短暂显示 0→4→9 这些不是终值的中间数，这个 app 不做那种事 */}
          <div className="score-big score-settled">
            {score15}
            <small> / 15</small>
          </div>
          <div className="score-106">
            折算 <b>{score106}</b> 分 · 作文满分 106.5
          </div>
          <div className="band-pill">
            {band.label}　{band.range[0]}–{band.range[1]} 分
          </div>
        </div>

        <div className="band-desc">
          <div className="label-cap">本档官方描述</div>
          {band.descriptor}
          <div className="stat-row">
            <span>
              <b>{stats.wordCount}</b> 词
            </span>
            <span>
              <b>{stats.sentenceCount}</b> 句
            </span>
            <span>
              <b>{stats.paragraphCount}</b> 段
            </span>
            <span>
              <b>
                {stats.verifiedCount}/{stats.evidenceCount}
              </b>{" "}
              条证据已定位
            </span>
          </div>
        </div>
      </div>

      <DiagnosisCard
        summary={result.summary}
        strengths={result.strengths}
        dimensionScores={result.dimensionScores}
      />
    </>
  );
}
