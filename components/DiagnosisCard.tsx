import { DIMENSIONS, DIMENSION_LABEL } from "@/lib/types";
import type { DimensionScore } from "@/lib/types";

/**
 * 总评 + 做对了什么 + 维度诊断。
 *
 * 从 BandCard 里抽出来，是因为流式批改要在同一个页面上一段段地填进来，
 * 而分数板（ScoreCard）必须等结果才出现——两者出现的时机完全不同，
 * 留在同一个组件里就只能靠条件渲染硬凑。
 *
 * `partial` 是给流式视图用的：内容还没到齐时把缺的那块渲染成"生成中"占位，
 * 而不是让版块凭空消失又出现。最终报告传默认值 false，DOM 与抽取前逐字节一致。
 */
/**
 * 两条错开的灰条，表示"这段文字还在路上"。
 *
 * 是骨架、不是进度条：条的长度是固定的装饰，不随已收到的字符数变化。
 * 见 globals.css 里 .skeleton 的注释——总量未知时，任何按时间爬的进度都是骗人。
 */
function SkeletonLines() {
  return (
    <>
      <span className="skeleton skeleton-line-1" />
      <span className="skeleton skeleton-line-2" />
    </>
  );
}

export interface DiagnosisCardProps {
  /** 还没拿到时传 undefined —— 只有流式视图会这样 */
  summary: string | undefined;
  strengths: string[];
  dimensionScores: DimensionScore[];
  /** 这是渐进内容，缺的部分渲染占位而不是省略。最终结果传 false（默认） */
  partial?: boolean;
}

export function DiagnosisCard({
  summary,
  strengths,
  dimensionScores,
  partial = false,
}: DiagnosisCardProps) {
  return (
    <>
      <div className="card">
        <div className="label-cap">总评</div>
        {summary === undefined && partial ? <SkeletonLines /> : summary}
      </div>

      {(strengths.length > 0 || partial) && (
        <div className="card">
          <div className="label-cap">做对了什么</div>
          {strengths.length > 0 ? (
            <ul className="plain-list">
              {strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : (
            <SkeletonLines />
          )}
        </div>
      )}

      <h2 className="section-title">维度诊断</h2>
      <div className="dims">
        {/*
          按 DIMENSIONS 顺序遍历、而不是直接渲染 dimensionScores：
          流式期间三个维度是陆续到达的，直接 map 会让卡片一边生成一边换位置。
          最终结果里 parseDimensionScores 保证三项齐全且就是这个顺序（见 lib/review.ts），
          所以这条路对最终渲染是恒等变换。
        */}
        {DIMENSIONS.map((dim) => {
          const score = dimensionScores.find((d) => d.dimension === dim);
          if (score) {
            return (
              <div className="dim-card" key={dim}>
                <div className="dim-name">
                  <span>{DIMENSION_LABEL[dim]}</span>
                  <span className="dim-score">{score.score}/5</span>
                </div>
                {/*
                  key={score.score} 不是装饰：占位分支和真值分支是同一个 DOM 节点，
                  React 会就地复用，于是 grow 关键帧在 width:0% 时就已经跑完了，
                  真值到达只会瞬间跳到位。换 key 让它重挂载，条形才会长出来。
                  上面的 aria-* 让屏幕阅读器拿到同一个数——进度条是视觉，
                  数字才是数据，两者不能只有一个是真的。
                */}
                <div
                  className="meter"
                  role="meter"
                  aria-valuenow={score.score}
                  aria-valuemin={0}
                  aria-valuemax={5}
                  aria-label={`${DIMENSION_LABEL[dim]}维度分`}
                >
                  <i
                    key={score.score}
                    style={{ width: `${Math.round((score.score / 5) * 100)}%` }}
                  />
                </div>
                <p className="dim-comment">{score.comment}</p>
              </div>
            );
          }

          if (!partial) return null;

          return (
            <div className="dim-card" key={dim}>
              <div className="dim-name">
                <span>{DIMENSION_LABEL[dim]}</span>
                <span className="dim-score">—/5</span>
              </div>
              {/* 空槽位对屏幕阅读器没有信息，标成装饰；分数还没到，也就没有 meter 语义 */}
              <div className="meter" aria-hidden="true">
                <i style={{ width: "0%" }} />
              </div>
              <div className="dim-comment">
                <span className="skeleton skeleton-line-1" />
              </div>
            </div>
          );
        })}
      </div>
      <p className="note">
        四级作文采用整体评分法，上面三个维度分只用来显示强弱分布，不参与总分计算。
      </p>
    </>
  );
}
