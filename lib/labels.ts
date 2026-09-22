/**
 * 面向用户的中文文案。
 *
 * 单独抽出来的原因：同一批标签既要出现在网页上（React 组件），
 * 也要出现在下载的 HTML 报告里（字符串拼接）。各写一份的结果就是
 * 两边措辞慢慢漂移——网页说「未能在原文中定位」、报告说「未能定位」，
 * 用户会以为是两回事。所以这里只留唯一一份。
 */

import type { AmbiguityReason, EvidenceKind, LocateMethod, TrainingFocus } from "./types";

export const KIND_LABEL: Record<EvidenceKind, string> = {
  strength: "亮点",
  minor: "小错",
  major: "严重错误",
};

/**
 * 训练区里每个 focus 的显示名。
 *
 * 放在这里而不是放进 lib/training.ts 的 TRAINING_PLAYBOOK：同一个标签一旦有第二个
 * 真相源，就会出现"网页改了报告没改"，用户看到两种说法会以为是两回事——正是本文件
 * 头注释讲的那个问题。
 *
 * ⚠️ 这个 Record 要求键齐全，所以加了新 focus 忘了写标签会被 TypeScript 挡住。
 * 但**值是不是空串**它管不了，那条由 scripts/selftest.ts 的断言兜。
 */
export const TRAINING_FOCUS_LABEL: Record<TrainingFocus, string> = {
  spelling: "拼写",
  capitalization: "大小写",
  tense: "时态",
  agreement: "主谓一致",
  "noun-article": "可数名词与冠词",
  "sentence-structure": "句子结构",
  chinglish: "中式英语",
  collocation: "搭配",
  "word-choice": "用词",
  "sentence-variety": "句式变化",
  cohesion: "衔接",
  paragraphing: "分段",
  "task-response": "切题",
};

export const METHOD_LABEL: Record<LocateMethod, string> = {
  exact: "逐字命中原文",
  normalized: "忽略大小写/空白后命中",
  fragmented: "引文含省略号，分段命中",
  fuzzy: "模糊命中（引文与原文有出入）",
  none: "未能在原文中定位",
};

/**
 * 定位歧义的文案。short 是卡片上那个小徽章，full 是它的 title。
 *
 * 和 METHOD_LABEL 分开而不是拼在一起：method 说的是"怎么匹配上的"，
 * 歧义说的是"命中的是不是那一处"，两者会同时出现（"逐字命中原文 · 多处匹配"）。
 * 拼成一句会变成"逐字命中但可能不对"这种自己和自己打架的话。
 */
export const AMBIGUITY_LABEL: Record<AmbiguityReason, { short: string; full: string }> = {
  multiple: {
    short: "多处匹配",
    full: "这段文字在原文里出现了不止一次，高亮落在哪一处是按上下文推断的，请对照原文确认",
  },
  approximate: {
    short: "近似匹配",
    full: "这是按词重叠率模糊匹配到的位置，原文里还有别处也差不多，可能不是模型想引的那一句",
  },
};

/** `kind` 是兜底来的，卡片上的徽章要带上这个说明（见 lib/review.ts 的 coerceKind） */
export const KIND_DEGRADED_HINT =
  "模型没有给出这条证据的严重程度（既不是亮点也不是小错/严重错误），已按“小错”处理";
