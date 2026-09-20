import { DIMENSION_LABEL } from "@/lib/types";
import type { ReviewResult, UpgradeAction } from "@/lib/types";

/**
 * 升档建议。
 *
 * 每条建议都挂在具体证据上（linkedEvidenceIds），点击可以跳到对应的证据卡片，
 * 让「该做什么」和「原文哪里有问题」是对得上的，而不是一段独立的泛泛之谈。
 */
export function UpgradePlan({ plan }: { plan: UpgradeAction[] }) {
  if (plan.length === 0) {
    return <div className="card">本次没有生成升档建议。</div>;
  }

  return (
    <>
      {plan.map((a, i) => (
        <div className="up-card" key={`${a.dimension}-${i}`}>
          <div className="up-head">
            <span className="pri">优先 {i + 1}</span>
            <span className="chip">{DIMENSION_LABEL[a.dimension]}</span>
            {a.linkedEvidenceIds.length > 0 && (
              <span className="up-links">
                对应证据
                {a.linkedEvidenceIds.map((id) => (
                  <a className="chip chip-accent" href={`#card-${id}`} key={id}>
                    {id}
                  </a>
                ))}
              </span>
            )}
          </div>

          <p className="up-action">{a.action}</p>
          <p className="up-rationale">{a.rationale}</p>

          {a.example && (
            <div className="example">
              <div className="example-row">
                <span className="example-tag example-before">原</span>
                <span>{a.example.before}</span>
              </div>
              <div className="example-row">
                <span className="example-tag example-after">改</span>
                <span>{a.example.after}</span>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** 升档建议区的锚点版本，方便被别的区块引用 */
export type { ReviewResult };
