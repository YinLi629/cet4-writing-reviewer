/**
 * 全国大学英语四级考试（CET-4）作文评分标准。
 *
 * 两条要点，决定了这个文件为什么是"有分量"的而不是装饰：
 *
 * 1. 四级作文采用**整体评分法**（holistic scoring）。阅卷员看完全文后凭整体印象
 *    给出一个档次，而不是把几个维度的分数加起来。所以这里 score15 是唯一的
 *    计分来源，DIMENSIONS 下的诊断分只用于反馈，绝不参与总分。任何"内容 4 分 +
 *    语言 3 分 + 结构 4 分 = 11 分"的算法都是错的。
 *
 * 2. 档次是**按分数阈值判定**的，不是让模型自己报档次名。模型只负责给一个
 *    0-15 的整数分，档次由下面的 BANDS 表查出来。这样模型不会自创档位边界。
 */

import type { Band, Dimension, EvidenceKind } from "./types";

/** 批改标准版本号。改了 BANDS 或 TIER_GAP 就该往上加。 */
export const RUBRIC_VERSION = "cet4-holistic-2024.1";

/** 作文在 710 分制中的满分 */
export const ESSAY_MAX_SCORE_106 = 106.5;

/** 15 分制满分 */
export const ESSAY_MAX_SCORE_15 = 15;

/**
 * 档次表，按档位从高到低排列。
 * range 是官方公布的 15 分制区间（闭区间）。
 */
export const BANDS: Band[] = [
  {
    level: 5,
    label: "14 分档",
    range: [13, 15],
    descriptor:
      "切题。表达思想清楚，文字通顺、连贯。基本上无语言错误，仅有个别小错。",
  },
  {
    level: 4,
    label: "11 分档",
    range: [10, 12],
    descriptor: "切题。表达思想清楚，文字连贯，但有少量语言错误。",
  },
  {
    level: 3,
    label: "8 分档",
    range: [7, 9],
    descriptor:
      "基本切题。有些地方表达思想不够清楚，文字勉强连贯；语言错误相当多，其中有一些是严重错误。",
  },
  {
    level: 2,
    label: "5 分档",
    range: [4, 6],
    descriptor: "基本切题。表达思想不清楚，连贯性差。有较多的严重语言错误。",
  },
  {
    level: 1,
    label: "2 分档",
    range: [1, 3],
    descriptor:
      "条理不清，思路紊乱，语言支离破碎或大部分句子均有错误，且多数为严重错误。",
  },
  {
    level: 0,
    label: "0 分档",
    range: [0, 0],
    descriptor: "未作答；或只有几个孤立的词；或文不对题、完全跑题。",
  },
];

const TOP_LEVEL = 5;

/**
 * 按 15 分制分数查档次。
 *
 * 用阈值而不是区间包含，是因为这样对任何分数（含小数）都有唯一确定的结果，
 * 不会出现 9.5 掉进 [7,9] 与 [10,12] 之间缝隙的情况。
 */
export function bandForScore(score15: number): Band {
  const s = clampScore15(score15);
  if (s >= 13) return BANDS[0];
  if (s >= 10) return BANDS[1];
  if (s >= 7) return BANDS[2];
  if (s >= 4) return BANDS[3];
  if (s >= 1) return BANDS[4];
  return BANDS[5];
}

export function bandByLevel(level: number): Band | undefined {
  return BANDS.find((b) => b.level === level);
}

/** 15 分制 → 106.5 分制，保留一位小数 */
export function toScore106(score15: number): number {
  const raw = (clampScore15(score15) / ESSAY_MAX_SCORE_15) * ESSAY_MAX_SCORE_106;
  return Math.round(raw * 10) / 10;
}

/** 把任何输入收拢成 0-15 的整数 */
export function clampScore15(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(ESSAY_MAX_SCORE_15, Math.round(v)));
}

/**
 * 档与档之间的具体差距。
 *
 * 这是"升档建议"能落到实处的原因：建议不是泛泛地说"多练语法"，而是直接
 * 对上官方描述里从这一档到下一档到底多了/少了什么要求。
 */
export const TIER_GAP: Record<number, string> = {
  0: "从 0 分档到 2 分档：需要写出成篇的英文，至少能看出一个明确的立场或话题，而不是几个孤立单词。",
  1: "从 2 分档到 5 分档：需要做到基本切题，让读者能大致看懂你想说什么（哪怕表达仍不清楚），并且要让多数句子在语法上成立，把“支离破碎”变成“有较多错误但读得下去”。",
  2: "从 5 分档到 8 分档：需要把“表达思想不清楚”变成“基本说得清”，把“连贯性差”变成“勉强连贯”——即段落之间有衔接词、句与句有逻辑推进；同时把严重语言错误从“较多”降到“有一些”。",
  3: "从 8 分档到 11 分档：需要做到完全切题、思想表达清楚、文字连贯，并把“相当多语言错误、含严重错误”压到“只有少量语言错误”——严重错误（时态、主谓一致、句子结构残缺、可数不可数误用）必须清零。",
  4: "从 11 分档到 14 分档：差距只在语言质量。需要把“少量语言错误”降到“基本无错误、仅个别小错”，同时提升通顺度：用词更准确、句式有变化、连接自然，读起来不像外语。",
  5: "已是最高档。此档位没有更高目标，建议转向稳定性：在考场限时条件下也能稳定写出这一档的水平。",
};

/**
 * 取得从当前档到目标档的差距描述。
 * targetLevel 缺省时取高一层；已是最高档时返回该档的稳定性说明。
 */
export function tierGapFor(currentLevel: number, targetLevel?: number): string {
  const target = targetLevel ?? currentLevel + 1;
  if (target <= currentLevel) return TIER_GAP[currentLevel];
  if (currentLevel >= TOP_LEVEL) return TIER_GAP[TOP_LEVEL];

  // 跨多档时，把中间每一段差距都串起来，避免只说最后一跳。
  const parts: string[] = [];
  for (let lv = currentLevel; lv < Math.min(target, TOP_LEVEL); lv++) {
    parts.push(TIER_GAP[lv]);
  }
  return parts.join("\n");
}

/** 目标档的合法范围校验 */
export function isValidBandLevel(level: unknown): level is number {
  return typeof level === "number" && BANDS.some((b) => b.level === level);
}

/**
 * 维度诊断时给模型的指引。
 *
 * 再次强调：这三项只输出观察，不产生分数。总分走整体评分。
 */
export const DIMENSION_GUIDE: Record<Dimension, string> = {
  content:
    "内容：是否切题（有没有回应题目要求的每一个要点）、观点是否明确、论证是否有支撑、有没有跑题或凑字数。",
  language:
    "语言：语法准确性（时态、主谓一致、单复数、冠词、介词搭配、句子结构完整性）、词汇是否恰当与多样、拼写与大小写。请特别区分「严重错误」（影响理解或属基础语法崩塌）与「小错」（笔误、个别搭配不当）。",
  organization:
    "结构：段落划分是否合理、有没有主题句、句间与段间的衔接手段（连接词、指代）是否自然、整体是否连贯、有无逻辑跳跃。",
};

/** 证据定性说明，注入 prompt 用，约束模型怎么归类 */
export const EVIDENCE_KIND_GUIDE: Record<EvidenceKind, string> = {
  strength: "亮点，值得保留的做法",
  minor: "小错，笔误或个别搭配不当，不影响理解",
  major: "严重错误，基础语法崩塌或影响理解",
};

/** 各维度在诊断分上的满分 */
export const DIMENSION_MAX = 5;
