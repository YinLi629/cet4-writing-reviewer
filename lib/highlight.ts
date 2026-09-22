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

/**
 * 原文里的高亮块和证据卡片，是同一组跳转的两端。前缀必须**两端一致、
 * 且网页和导出的 HTML 也一致**——否则链接会在某一端指向不存在的元素，
 * 表现是"点了没反应"，不报错，极难发现。
 */
export const ANCHOR_PREFIX = "anchor-";
export const CARD_PREFIX = "card-";

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

/**
 * 证据 id → 它在原文里对应的**锚点元素 id**。
 *
 * 为什么需要这张表，而不是让每张证据卡片自己拼 `anchor-${e.id}`：
 * 重叠的证据会被合并进**同一个** `<mark>`（见上面 segmentEssay 的合并逻辑），
 * 而一个元素只能有一个 id——那个 id 用的是合并块里的第一条证据。于是：
 *
 *   证据 e1 和 e3 重叠 → 只画出 `<mark id="anchor-e1">`
 *   → e3 的卡片拼出 `#anchor-e3` → 指向不存在的元素 → **点了没反应，也不报错**
 *
 * 所以"某条证据该跳到哪"必须问这张表，不能自己拼。
 *
 * 直接复用 segmentEssay 的结果而不是另写一遍合并逻辑：这样映射和真正渲染出来的
 * `<mark>` 一定一致。两处各写一份的话，改了一处忘了另一处，就会重新长出上面那种
 * 死链接，而且只在"证据恰好重叠"时才复现。
 *
 * 没定位到原文（或区间越界）的证据不在表里——它们本来就没有高亮可跳。
 */
export function anchorMap(essay: string, evidence: Evidence[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const seg of segmentEssay(essay, evidence)) {
    if (!seg.kind || seg.ids.length === 0) continue;
    const anchor = `${ANCHOR_PREFIX}${seg.ids[0]}`;
    for (const id of seg.ids) map.set(id, anchor);
  }
  return map;
}
