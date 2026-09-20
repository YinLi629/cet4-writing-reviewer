/**
 * 把证据区间切分成互不重叠的高亮块。
 *
 * 为什么单独一个模块：HTML 报告（拼字符串）和结果页（渲染 React 节点）
 * 需要完全一致的切分结果。各自实现一遍迟早会漂移，导致同一篇作文在
 * 网页上和下载的报告里高亮位置不一样。
 */

import type { Evidence, EvidenceKind } from "./types";

export interface Segment {
  text: string;
  start: number;
  end: number;
  /** null 表示这段没有高亮 */
  kind: EvidenceKind | null;
  /** 命中这一段的证据 id，可能有多条（重叠时合并） */
  ids: string[];
}

function severity(kind: EvidenceKind): number {
  if (kind === "major") return 3;
  if (kind === "minor") return 2;
  return 1;
}

/**
 * 切分原文。重叠或相邻的证据区间会合并成一个块——
 * 嵌套 <mark> 既画不出正确颜色，也会让链接跳转失去目标。
 */
export function segmentEssay(essay: string, evidence: Evidence[]): Segment[] {
  const spans = evidence
    .filter((e) => e.verified && e.start !== null && e.end !== null)
    .map((e) => ({
      start: e.start as number,
      end: e.end as number,
      id: e.id,
      kind: e.kind,
    }))
    // 区间非法（起点在终点之后、或越界）的直接丢掉，否则下面的切片会错位
    .filter((s) => s.start >= 0 && s.end > s.start && s.end <= essay.length)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  if (spans.length === 0) {
    return essay ? [{ text: essay, start: 0, end: essay.length, kind: null, ids: [] }] : [];
  }

  interface Cluster {
    start: number;
    end: number;
    ids: string[];
    kind: EvidenceKind;
  }

  const clusters: Cluster[] = [];
  for (const s of spans) {
    const last = clusters[clusters.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      if (!last.ids.includes(s.id)) last.ids.push(s.id);
      if (severity(s.kind) > severity(last.kind)) last.kind = s.kind;
    } else {
      clusters.push({ start: s.start, end: s.end, ids: [s.id], kind: s.kind });
    }
  }

  const segments: Segment[] = [];
  let cursor = 0;

  for (const c of clusters) {
    if (c.start > cursor) {
      segments.push({
        text: essay.slice(cursor, c.start),
        start: cursor,
        end: c.start,
        kind: null,
        ids: [],
      });
    }
    segments.push({
      text: essay.slice(c.start, c.end),
      start: c.start,
      end: c.end,
      kind: c.kind,
      ids: c.ids,
    });
    cursor = c.end;
  }

  if (cursor < essay.length) {
    segments.push({
      text: essay.slice(cursor),
      start: cursor,
      end: essay.length,
      kind: null,
      ids: [],
    });
  }

  return segments;
}
