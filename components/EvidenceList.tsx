import { KIND_LABEL, METHOD_LABEL } from "@/lib/labels";
import { DIMENSION_LABEL } from "@/lib/types";
import type { EvidenceListItem, PendingEvidence } from "@/lib/types";

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
 */
export function EvidenceList({ evidence }: { evidence: EvidenceListItem[] }) {
  if (evidence.length === 0) {
    return <div className="card">本次没有产出证据条目。</div>;
  }

  return (
    <>
      {evidence.map((e) => {
        const pending = isPending(e);

        return (
          <div className={`ev-card ev-card-${e.kind}`} key={e.id} id={`card-${e.id}`}>
            <div className="ev-head">
              <span className={`badge badge-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
              <span className="chip">{DIMENSION_LABEL[e.dimension]}</span>
              {pending ? (
                <span className="ev-loc pulse-soft">定位中…</span>
              ) : e.start !== null && e.end !== null ? (
                <span className="ev-loc" title={METHOD_LABEL[e.locateMethod]}>
                  原文第 {e.start}–{e.end} 字符 · {METHOD_LABEL[e.locateMethod]}
                </span>
              ) : (
                <span className="ev-loc ev-loc-bad" title={METHOD_LABEL[e.locateMethod]}>
                  未能在原文中定位
                </span>
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

function isPending(e: EvidenceListItem): e is PendingEvidence {
  return "pending" in e;
}
