import { TRAINING_FOCUS_LABEL } from "@/lib/labels";
import { TRAINING_PLAYBOOK } from "@/lib/training";
import type { TrainingItem } from "@/lib/types";

/**
 * 训练区：按错误类型给出「写作时怎么做 + 平时怎么练」。
 *
 * ## 卡片里有两块来源完全不同的内容，视觉上必须能分开
 *
 * - `reason` 是**模型**给的，说的是"你这篇为什么该练它"；
 * - symptom / howTo / drills / watchOut 是**查表**来的通用练法（lib/training.ts），
 *   同一个类别的所有学生看到的一模一样。
 *
 * 混在一起，学生会以为"拿不准的词换掉"也是模型读了他这篇作文得出的结论。
 * 所以后者包在 `.train-plain`（浅底容器）里，并且顶上带一句 `.train-note`
 * 说明来源。这一句不是客套话，是这张卡片诚实性的全部依据——别删。
 */
export function TrainingPlan({ plan }: { plan: TrainingItem[] }) {
  if (plan.length === 0) return null;

  return (
    <>
      {plan.map((t) => {
        // focus 在写入前已经被 coerceTrainingFocus 收敛过，查表必然命中；
        // 但这里不写 `!` 是因为下面的写法对空表也安全，不必依赖那个前提
        const book = TRAINING_PLAYBOOK[t.focus];
        const label = TRAINING_FOCUS_LABEL[t.focus];

        return (
          <div className="train-card" key={t.focus}>
            <div className="train-head">
              <span className="chip chip-accent">{label}</span>
              {t.linkedEvidenceIds.length > 0 && (
                <span className="train-links">
                  相关证据
                  {t.linkedEvidenceIds.map((id) => (
                    <a className="chip" href={`#card-${id}`} key={id}>
                      {id}
                    </a>
                  ))}
                </span>
              )}
            </div>

            {/* 模型写的诊断：针对这一篇 */}
            <p className="train-reason">{t.reason}</p>

            {/* 查表来的练法：通用 */}
            <div className="train-plain">
              <p className="train-note">
                以下是「{label}」这一类问题的通用练法，不是针对你这一篇写的。
              </p>
              <p className="train-symptom">{book.symptom}</p>

              <p className="train-label">写作时怎么做</p>
              <ul className="plain-list">
                {book.howTo.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>

              <p className="train-label">平时怎么练</p>
              <ul className="plain-list">
                {book.drills.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>

              <p className="train-watch">
                <strong>当心：</strong>
                {book.watchOut}
              </p>
            </div>
          </div>
        );
      })}
    </>
  );
}
