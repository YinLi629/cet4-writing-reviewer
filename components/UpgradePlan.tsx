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

          {a.example ? (
            <>
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
              {/*
                示范里的"原句"没能在原文中定位到，说明模型很可能自己写了一句
                原文里没有的话。必须说出来——不说的话，这份示范看起来和真的一样，
                学生照着一条不存在的"原句"去对照，只会更困惑。
                和证据坐标同一个哲学：抄错要能被抓到，而不是装作成功。
              */}
              {a.exampleUnverified && (
                <p className="example-flag">
                  上面那个「原句」没能在原文中逐字找到，模型可能自己造了句子——请以原文为准。
                </p>
              )}
            </>
          ) : (
            /*
              没有示范时**不能留白**：留白和"渲染坏了"长得一模一样。
              但也要说清楚这不是错误，所以用中性配色（.example-flag-quiet）。
            */
            <p className="example-flag example-flag-quiet">
              {a.dimension === "organization"
                ? "本条没有改写示范。结构类的建议有时落不到某一个句子上，照上面那句话做即可。"
                : "本条没有改写示范，模型这次没能给出可照抄的句子——建议按上面那句话自己动手改一遍。"}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

/** 升档建议区的锚点版本，方便被别的区块引用 */
export type { ReviewResult };
