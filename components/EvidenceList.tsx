import { KIND_LABEL, METHOD_LABEL } from "@/lib/labels";
import { DIMENSION_LABEL } from "@/lib/types";
import type { Evidence } from "@/lib/types";

/**
 * 证据列表。
 *
 * 每条证据都带坐标和定位方式：坐标是服务端在原文里算出来的，
 * 定位方式则用来表态这条引用有多可信。定位失败的会明确标红，
 * 而不是给一个看起来精确、实际错位的下划线。
 */
export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return <div className="card">本次没有产出证据条目。</div>;
  }

  return (
    <>
      {evidence.map((e) => {
        const locatable = e.start !== null && e.end !== null;

        return (
          <div className={`ev-card ev-card-${e.kind}`} key={e.id} id={`card-${e.id}`}>
            <div className="ev-head">
              <span className={`badge badge-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
              <span className="chip">{DIMENSION_LABEL[e.dimension]}</span>
              {locatable ? (
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
