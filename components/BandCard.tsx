import { DIMENSION_LABEL } from "@/lib/types";
import type { ReviewResult } from "@/lib/types";

/**
 * 分数板：档次 + 15 分制 + 106.5 分制折算 + 官方档位描述 + 硬统计。
 *
 * 这里显示的档次是服务端按分数查表得到的（见 lib/rubric.ts 的 bandForScore），
 * 不是模型自己报的，所以它和分数永远自洽。
 */
export function BandCard({ result }: { result: ReviewResult }) {
  const { band, score15, score106, stats } = result;

  return (
    <>
      <div className="scoreboard">
        <div className="score-main">
          <div className="score-big">
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

      <div className="card">
        <div className="label-cap">总评</div>
        {result.summary}
      </div>

      {result.strengths.length > 0 && (
        <div className="card">
          <div className="label-cap">做对了什么</div>
          <ul className="plain-list">
            {result.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <h2 className="section-title">维度诊断</h2>
      <div className="dims">
        {result.dimensionScores.map((d) => (
          <div className="dim-card" key={d.dimension}>
            <div className="dim-name">
              <span>{DIMENSION_LABEL[d.dimension]}</span>
              <span className="dim-score">{d.score}/5</span>
            </div>
            <div className="meter">
              <i style={{ width: `${Math.round((d.score / 5) * 100)}%` }} />
            </div>
            <p className="dim-comment">{d.comment}</p>
          </div>
        ))}
      </div>
      <p className="note">
        四级作文采用整体评分法，上面三个维度分只用来显示强弱分布，不参与总分计算。
      </p>
    </>
  );
}
