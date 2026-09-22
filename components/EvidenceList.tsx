import { CARD_PREFIX } from "@/lib/highlight";
import { AMBIGUITY_LABEL, KIND_DEGRADED_HINT, KIND_LABEL, METHOD_LABEL } from "@/lib/labels";
import { DIMENSION_LABEL } from "@/lib/types";
import type { Evidence, EvidenceListItem, PendingEvidence } from "@/lib/types";

/**
 * 证据列表。
 *
 * 每条证据都带坐标和定位方式：坐标是服务端在原文里算出来的，
 * 定位方式则用来表态这条引用有多可信。定位失败的会明确标红，
 * 而不是给一个看起来精确、实际错位的下划线。
 *
 * 流式批改期间喂进来的是 PendingEvidence（还没定位的候选），它**没有**
 * start/end/verified/locateMethod 这几个字段——所以这里用 `pending` 判别，
 * 而不是去看坐标是不是 null。"还没开始定位"和"定位失败"必须分开显示：
 * 前者是"定位中…"，后者才是那条标红的警告。
 *
 * ## 反向跳转
 *
 * 坐标那一行是**指回原文批注的链接**（`anchors` 给出该跳到哪个元素）。
 * 用朴素 `<a href="#...">` 而不是 onClick，有三个好处：键盘和朗读器天然可用、
 * 浏览器后退键能退回来、导出的 HTML 里同样有效——那份文件是零 JS 的。
 * 跳过去的那个高亮块由 CSS 的 `:target` 自己亮起来（见 globals.css）。
 *
 * `anchors` 是选填的：流式批改期间证据还没定位，没有锚点，也没必要传。
 */
export function EvidenceList({
  evidence,
  anchors,
}: {
  evidence: EvidenceListItem[];
  /** 证据 id → 原文锚点元素 id，由 lib/highlight.ts 的 anchorMap 算出来 */
  anchors?: Map<string, string>;
}) {
  if (evidence.length === 0) {
    return <div className="card">本次没有产出证据条目。</div>;
  }

  return (
    <>
      {evidence.map((e) => {
        const pending = isPending(e);

        return (
          <div className={`ev-card ev-card-${e.kind}`} key={e.id} id={`${CARD_PREFIX}${e.id}`}>
            <div className="ev-head">
              <span
                className={`badge badge-${e.kind}`}
                title={e.kindDegraded ? KIND_DEGRADED_HINT : undefined}
                data-degraded={e.kindDegraded ? "1" : undefined}
              >
                {KIND_LABEL[e.kind]}
              </span>
              <span className="chip">{DIMENSION_LABEL[e.dimension]}</span>
              {pending ? (
                <span className="ev-loc pulse-soft">定位中…</span>
              ) : (
                <LocatedLabel evidence={e} anchors={anchors} />
              )}
            </div>

            <blockquote className="quote">{e.quote}</blockquote>
            <p className="ev-comment">{e.comment}</p>
            {e.suggestion && (
              <p className="ev-suggestion">
                <strong>建议：</strong>
                {e.suggestion}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * 已经定位过的证据，右上角那一小块：坐标 + 定位方式。
 *
 * 单独拆出来是因为它有三种长相（正常、越界、没定位到），全塞进调用处那个
 * 三元表达式里会变成一团读不出层次的条件嵌套。只收 `Evidence`——
 * "还在定位中"那一种在调用处就分流出去了。
 */
function LocatedLabel({
  evidence,
  anchors,
}: {
  evidence: Evidence;
  anchors?: Map<string, string>;
}) {
  const method = METHOD_LABEL[evidence.locateMethod];

  if (evidence.start === null || evidence.end === null) {
    return (
      <span className="ev-loc ev-loc-bad" title={method}>
        未能在原文中定位
      </span>
    );
  }

  const text = `原文第 ${evidence.start}–${evidence.end} 字符 · ${method}`;
  // 歧义徽章和定位方式**并列**，不能被它顶替：徽章上写着"逐字命中原文"的同时
  // 还挂着"多处匹配"，才是这份引文真实的可信度（见 lib/types.ts 的 AmbiguityReason）
  const amb = evidence.ambiguity ? AMBIGUITY_LABEL[evidence.ambiguity] : null;
  const ambChip = amb ? (
    <span className="amb" title={amb.full}>
      {amb.short}
      {evidence.hitCount && evidence.hitCount > 1 ? `（${evidence.hitCount} 处）` : ""}
    </span>
  ) : null;

  // 没有对应的高亮块就不做成链接——那会是个点了没反应的死链。
  // 什么时候会没有：这条证据没通过 verified，或者它的区间越出了原文长度，
  // 两种情况下 segmentEssay 都不会为它画出 <mark>
  const anchor = anchors?.get(evidence.id);
  if (!anchor) {
    return (
      <>
        <span className="ev-loc" title={method}>
          {text}
        </span>
        {ambChip}
      </>
    );
  }

  return (
    <>
      <a
        className="ev-loc ev-loc-link"
        href={`#${anchor}`}
        title={`${method} —— 点击跳到原文的这一处`}
      >
        {text}
      </a>
      {ambChip}
    </>
  );
}

function isPending(e: EvidenceListItem): e is PendingEvidence {
  return "pending" in e;
}
