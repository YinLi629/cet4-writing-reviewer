/**
 * 面向用户的中文文案。
 *
 * 单独抽出来的原因：同一批标签既要出现在网页上（React 组件），
 * 也要出现在下载的 HTML 报告里（字符串拼接）。各写一份的结果就是
 * 两边措辞慢慢漂移——网页说「未能在原文中定位」、报告说「未能定位」，
 * 用户会以为是两回事。所以这里只留唯一一份。
 */

import type { EvidenceKind, LocateMethod } from "./types";

export const KIND_LABEL: Record<EvidenceKind, string> = {
  strength: "亮点",
  minor: "小错",
  major: "严重错误",
};

export const METHOD_LABEL: Record<LocateMethod, string> = {
  exact: "逐字命中原文",
  normalized: "忽略大小写/空白后命中",
  fragmented: "引文含省略号，分段命中",
  fuzzy: "模糊命中（引文与原文有出入）",
  none: "未能在原文中定位",
};
