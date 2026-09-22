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

/**
 * 批改标准版本号。
 *
 * 改了 BANDS 或 TIER_GAP 当然要往上加。2024.1 → 2024.2 这次**没有动判分**，
 * 动的是**输出契约**：升档建议的 example 从可选改为强制、新增训练区
 * （trainingPlan），JSON_CONTRACT 因此实质重写。
 *
 * 为什么这也要升版：meta.rubricVersion 是报告上唯一的契约版本戳，也是评测跑分时
 * 分辨"这批结果是哪版契约产出的"的唯一依据。不升版的话，新旧报告长得一样，
 * 事后没法把"改动前后的分数分布"分开看——而那正是改提示词时最需要看的东西。
 */
export const RUBRIC_VERSION = "cet4-holistic-2024.2";

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

/** 把任何输入收拢成 0-15 的整数。数值层面的夹紧，输入端的收拢见 readScore15 */
export function clampScore15(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(ESSAY_MAX_SCORE_15, Math.round(v)));
}

/**
 * "整串就是一个数"的判据。
 *
 * 不用 Number() 的宽松解析：Number("") === 0、Number(" ") === 0、
 * Number("0x10") === 16、Number(true) === 1、Number(null) === 0 —— 每一条都会把
 * "模型没给分数"变成一个**具体的、看起来完全合理的分数**。
 * 也不用 parseInt：parseInt("12abc") === 12，把一段废话读成 12 分。
 */
const NUMERIC_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * `score15` 字段的可用性。给 warnings 用：模型给了个没法当分数的值时，
 * 报告必须把这件事说出来，而不是安静地按 0 分发出去。
 */
export type Score15Field = "number" | "numeric-string" | "unusable";

export function score15Field(n: unknown): Score15Field {
  if (typeof n === "number") {
    // NaN / Infinity 也是 typeof "number"，但 readScore15 会读成 0。
    // 这里说"是 number"就等于把一次静默的 0 分放过去——判据必须和 readScore15 一致
    return Number.isFinite(n) ? "number" : "unusable";
  }
  if (typeof n === "string") {
    const s = n.trim();
    // 要求和 readScore15 逐字相同的判据，**并且**解析出来必须是有限值：
    // 两个函数一旦分叉，就会出现"收下了、却读成 0、而且不报警"的第三种状态
    // ——那正是这一轮要消灭的东西。自测里有一条专门盯这个一致性
    if (NUMERIC_STRING.test(s) && Number.isFinite(Number(s))) return "numeric-string";
  }
  return "unusable";
}

/**
 * 读模型给的 `score15`。**全文唯一的计分来源，所以这里是最该防守的一处。**
 *
 * 原来的写法是 `typeof n === "number" ? n : 0`：模型只要把分数写成字符串
 * （`"score15": "12"`），学生就会拿到一份**看起来完全正常、但显示 0 分 0 档**的报告
 * ——不报错也不告警，因为对下游来说 0 是个合法分数。同文件的 asInt / asDimension /
 * asKind 各有各的容错，唯独总分入口不做，方向正好反了。
 *
 * 收与不收的界线是"这个值有没有明确的数值含义"，全表见 selftest 的 [2c]：
 *   · number（有限值）→ 收；NaN / Infinity → 不收
 *   · "12" / " 12 " / "9.6" / "+3" / ".5" → 收（去空白后整串就是一个数）
 *   · "12abc" / "" / " " / "0x10" / "1e2" / "12分" → 不收，落 0
 *   · true / false / null / undefined / 对象 / 数组 → 不收，落 0
 *
 * 落了 0 之后**不能就这么算了**：调用方要拿 score15Field 判一下，是 unusable
 * 就往 warnings 里写一条（见 lib/review.ts）。
 */
export function readScore15(n: unknown): number {
  if (typeof n === "number") return clampScore15(n);
  if (typeof n === "string") {
    const s = n.trim();
    return NUMERIC_STRING.test(s) ? clampScore15(Number(s)) : 0;
  }
  return 0;
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

/** 四级作文规定的字数范围。官方对"字数不足"只说"酌情扣分"，没有给数字。 */
export const TARGET_WORDS_MIN = 120;
export const TARGET_WORDS_MAX = 180;

/**
 * 分数上限规则。
 *
 * 为什么需要它：2026-09 用 21 篇作文跑了评测，发现模型会给出**自相矛盾**的结果。
 * 典型是 a3：它自己把 3 处错误标成 major（Sports plays / study more efficient /
 * It not only make），language 只给 3/5，升档理由里甚至写着"这种错误会让阅卷员
 * 直接归入语言错误相当多的 8 分档"——总分却给了 11。c8 是同一失效模式：它把
 * "sports plays" 标成 major，理由里写"主谓不一致属于严重错误，会直接把作文
 * 拉低到 8 分档"，然后给了 11。
 *
 * 整体评分法允许模型凭整体印象定分，但不允许总分推翻它自己刚给出的证据。
 * 下面每条上限都能从 BANDS 的 descriptor 或官方字数政策直接推出来，推导写在
 * 各条注释里。阈值是项目策略，可以调。
 *
 * 有两条边界要守住，否则这套规则会变成"迁就预期"：
 *
 * 1. **只收模型自己声明的东西。** 上限的输入全是模型输出里的 kind 和维度分，
 *    没有一条来自我事先写好的预期区间。
 * 2. **官方条文没写的，不硬压总分。** 曾经有过一条"全文 1 段 → 上限 9 分"，
 *    后来删掉了：8 分档的描述是"有些地方表达思想不够清楚，文字勉强连贯；
 *    **语言错误相当多**，其中有一些是严重错误"，而像 c6 那种一整段但零 major、
 *    语言通顺的作文根本不满足这个描述的第二个分句。分段问题属于 organization
 *    维度（DIMENSION_GUIDE 里写的就是"段落划分是否合理"），该在维度分和诊断里
 *    体现，再由下面的 weak-organization 间接影响总分，而不是直接砍总分。
 *
 * 已知风险：major 的标注本身有噪声（评测里模型把 "sports waste time" 这类
 * 正确用法标成过 major），所以 majorCount 直接进了分数计算，标注误差会变成
 * 分数抖动。缓解办法是 KIND_RULES 里要求标注前先确认、以及分析脚本把
 * "全篇都是 major"这类可疑样本挑出来，而不是在这里放宽阈值。
 */
export interface CeilingContext {
  /** 被标为 major 的证据条数 */
  majorCount: number;
  /** organization 维度分，模型没给时为 null */
  organizationScore: number | null;
  /** content 维度分，模型没给时为 null */
  contentScore: number | null;
  wordCount: number;
  /**
   * 真实段数（lib/text-stats 的口径）。目前没有规则用它——分段问题走
   * prompt 里的 organization 规则——但它是"客观事实"的一部分，留着给
   * 后续规则和日志对照。
   */
  paragraphCount: number;
}

export interface ApplicableCeiling {
  id: string;
  /** score15 的上限（闭区间） */
  maxScore: number;
  /** 触发条件，写给模型看 */
  condition: string;
  /** 触发后的解释，含具体数字，写给用户看 */
  reason: string;
}

interface CeilingRule {
  id: string;
  /**
   * 静态的条件说明，不带具体数字，注入 prompt 用。
   *
   * 为什么不能直接把 evaluate 的结果写进 prompt：上限要看模型自己标的 major
   * 条数和维度分，而这些是模型**还没输出**的东西。所以 prompt 里给的是规则表，
   * 由模型自己对照着定分；代码在拿到输出之后用 evaluate 复核。
   */
  describe: string;
  /**
   * 是否由代码强制生效。
   *
   * prompt 里的表是给模型的**完整指引**，代码只强制其中不会被标注噪声误伤的
   * 那几条——这个区分是评测逼出来的：
   *
   * 2026-09 的第二轮评测里，把"1 条 major → 上限 9"和"organization ≤3/5 →
   * 上限 12"都设成强制之后，24 篇里有 6 篇被压分，而逐篇复核只有 1 篇是真的
   * 该压：a4(13→9)、c9(13→9)、c6(11→9)、c8(11→9) 都只标了 1 条 major；
   * a5（语料里最好的那篇）因为模型这一次把 organization 打成了 3/5，
   * 从 14 掉到 12。更硬的证据是 b1 在两次运行里一次 0 条 major、一次 2 条——
   * 模型的 major 标注本身有run-to-run 抖动，拿单条标注去改分数，等于把
   * 抖动放大成分数抖动。而同一轮里 a3、c5、c4、c6 全靠 prompt 里的上限表
   * 就落到了正确档位，一次强制都没用上。
   *
   * 所以：**能被单条噪声标签触发的规则，只写进 prompt，不强制。**
   */
  enforced: boolean;
  evaluate(ctx: CeilingContext): ApplicableCeiling | null;
}

const CEILING_RULES: CeilingRule[] = [
  {
    // 依据 5 分档 descriptor："有较多的严重语言错误"
    id: "many-major",
    describe: `标出 5 处及以上 major（严重错误）→ 上限 6 分（5 分档："有较多的严重语言错误"）`,
    enforced: true,
    evaluate: (c) =>
      c.majorCount >= 5
        ? {
            id: "many-major",
            maxScore: 6,
            condition: `你标出了 ${c.majorCount} 处 major（严重错误），属于档次描述里的"较多的严重语言错误"。`,
            reason: `标出 ${c.majorCount} 处严重错误，"较多的严重语言错误"对应 5 分档（4-6 分）。`,
          }
        : null,
  },
  {
    // 依据 8 分档 descriptor："语言错误相当多，其中有一些是严重错误"
    //
    // 阈值取 3 而不是 1，有两个理由：
    //   1. 描述原文是"语言错误**相当多**，其中有一些是严重错误"——"相当多"是
    //      前提。标出 1 处严重错误、其余都是小错，谈不上"相当多"。
    //   2. 模型的 major 标注有 run-to-run 抖动（b1 同一篇两次运行分别标了 0 条
    //      和 2 条）。单条标注不足以支撑改分，3 条才构成"模式"而非噪声。
    id: "several-major",
    // prompt 里说的是**定性**的严格版（只要有一条 major 就不能进 11 分档），
    // 代码强制的才是 ≥3 的宽松版。这个落差是故意的：
    //   - prompt 该把评分标准的要求原样讲清楚。TIER_GAP[3] 的原话就是"严重错误
    //     必须清零"，讲成"标满 3 处才扣"反而是错的，而且把阈值写在 prompt 里
    //     等于教模型怎么绕（少标两条就能保住 11 分）。
    //   - 代码只兜住不会因单条标注噪声误伤的那部分。
    describe: `只要标出了 major（严重错误）→ 严重错误未清零，上限 9 分（8 分档："语言错误相当多，其中有一些是严重错误"）`,
    enforced: true,
    evaluate: (c) =>
      c.majorCount >= 3
        ? {
            id: "several-major",
            maxScore: 9,
            condition: `你标出了 ${c.majorCount} 处 major（严重错误），属于档次描述里的"语言错误相当多，其中有一些是严重错误"。严重错误清零才能到 11 分档。`,
            reason: `标出 ${c.majorCount} 处严重错误。这构成"语言错误相当多，其中有一些是严重错误"，按档次描述只能落在 8 分档及以下（0-9 分）。`,
          }
        : null,
  },
  {
    // 依据官方对"字数不足"的酌情扣分政策。具体阈值是本项目策略。
    id: "too-short",
    describe: `词数 < 60 → 上限 6 分；词数 < 100 → 上限 9 分（四级要求 ${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX} 词，字数不足按官方政策酌情扣分）`,
    // 词数是代码自己数出来的，不含模型标注噪声，可以放心强制
    enforced: true,
    evaluate: (c) => {
      if (c.wordCount < 60) {
        return {
          id: "too-short",
          maxScore: 6,
          condition: `全文只有 ${c.wordCount} 词，远低于四级要求的 ${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX} 词。`,
          reason: `全文只有 ${c.wordCount} 词，远低于四级要求的 ${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX} 词。`,
        };
      }
      if (c.wordCount < 100) {
        return {
          id: "too-short",
          maxScore: 9,
          condition: `全文只有 ${c.wordCount} 词，低于四级要求的 ${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX} 词。`,
          reason: `全文只有 ${c.wordCount} 词，低于四级要求的 ${TARGET_WORDS_MIN} 词。`,
        };
      }
      return null;
    },
  },
  {
    // organization 与"文字连贯"对应，但**不能**用来区分 11 和 14 分档——
    // 两个档的条文都要求连贯（14 分档："文字通顺、连贯"；11 分档："文字连贯"）。
    // 所以这条只兜"结构真的崩了"（≤2/5），不碰"结构一般"（3/5）。
    //
    // 阈值从 ≤3 收到 ≤2 是第三轮评测逼出来的：≤3 时 24 篇触发 14 篇（58%），
    // 一条半数作文都触发的规则没有信息量；而且它压到的 3 篇（a5#2/b1/b2）
    // 逐篇复核都是我独立判定为 13 分的文章——b1/b2 是"156 词切 7 段"这种
    // 段落过碎，确实该扣 organization 的分，但不足以把一篇格式规范、内容齐全、
    // 语言无硬伤的申请信踢出 14 分档。收到 ≤2 后触发 10 篇，全部不再误伤。
    //
    // 仍然不强制：维度分和 major 标注一样有 run-to-run 抖动（a5 在某一轮
    // organization 被打成 3/5），硬压等于把抖动放大成分数抖动。见上面
    // "能被单条噪声标签触发的规则，只写进 prompt" 的说明。
    id: "weak-organization",
    describe: `organization 打了 2/5 或更低 → 上限 12 分（11 分档起都要求"文字连贯"，结构崩了就不该进 14 分档）`,
    enforced: false,
    evaluate: (c) =>
      c.organizationScore !== null && c.organizationScore <= 2
        ? {
            id: "weak-organization",
            maxScore: 12,
            condition: `你给 organization 打了 ${c.organizationScore}/5。`,
            reason: `organization 只有 ${c.organizationScore}/5，11 分档起要求的"文字连贯"没有达到。`,
          }
        : null,
  },
  {
    // content 是"切题"与"表达思想清楚"的对应项，11 分档起都要求表达思想清楚
    id: "vacuous-content",
    describe: `content 打了 2/5 或更低 → 上限 9 分（11 分档起都要求"表达思想清楚"；全篇万能句、没有针对本题的具体内容属于这一档）`,
    // content 掉到 2/5 是强信号（要么跑题要么全篇套话），不是"某一条标错"能造成的，
    // 可以强制。目前语料里没触发过，属于给它留的保险。
    enforced: true,
    evaluate: (c) =>
      c.contentScore !== null && c.contentScore <= 2
        ? {
            id: "vacuous-content",
            maxScore: 9,
            condition: `你给 content 打了 ${c.contentScore}/5。`,
            reason: `content 只有 ${c.contentScore}/5，没有达到 11 分档要求的"表达思想清楚"。`,
          }
        : null,
  },
  {
    // 0 分档的条文是"未作答；或只有几个孤立的词；或**文不对题、完全跑题**"。
    // content 掉到 1/5 或更低，模型自己在维度评语里写的就是"没有回应题目要点"
    // 这类话，对应的是条文最后那一句，所以上限该落在最低那一档附近。
    //
    // 取 4 而不是 0：条文的 0 分档区间是 [0,0]，但实践中流畅但跑题的作文不会被
    // 判 0——评测里 a7（写手机不写运动）模型给 3、我也认可。所以这里只兜住
    // "绝不该进 5 分档以上"，不去追条文的字面最低分。
    //
    // 强制：content ≤1 与 ≥2 之间是**类别判断**（"有没有回应题目"），不是
    // several-major 那种"数了几条"的计数噪声；a6 在两次运行里分别是 0 和 1，
    // 都落在这条规则的触发侧，没有出现会让规则忽开忽关的 1↔2 抖动。
    // ⚠️ 如果以后出现"content 在 1 和 2 之间反复横跳、且总分在 10 以上"的样本，
    //    这条就该退回 enforced: false，只写进 prompt。
    id: "topic-missed",
    describe: `content 打了 1/5 或更低 → 上限 4 分（0 分档："文不对题、完全跑题"）`,
    enforced: true,
    evaluate: (c) =>
      c.contentScore !== null && c.contentScore <= 1
        ? {
            id: "topic-missed",
            maxScore: 4,
            condition: `你给 content 打了 ${c.contentScore}/5。`,
            reason: `content 只有 ${c.contentScore}/5，属于"文不对题、完全跑题"，按 0 分档的条文不能进入 5 分档以上。`,
          }
        : null,
  },
];

/** 上限规则表，注入 prompt 用。模型自己对照着定分，代码随后复核。 */
export const CEILING_RULE_TABLE: string[] = CEILING_RULES.map((r) => r.describe);

/** 对一篇作文，返回全部适用的分数上限（含不强制的那几条，仅用于分析和展示） */
export function applicableCeilings(ctx: CeilingContext): ApplicableCeiling[] {
  return CEILING_RULES.map((r) => r.evaluate(ctx)).filter(
    (c): c is ApplicableCeiling => c !== null,
  );
}

/**
 * 只返回**由代码强制**的上限。
 *
 * 和 applicableCeilings 的区别就是上面 enforced 那段注释说的：prompt 里的表
 * 是完整指引，代码只强制不会被单条标注噪声触发的那几条。批改时用的是这个函数，
 * 分析脚本两个都调，用来分别报告"模型该守的规矩"和"代码真拦截的"。
 */
export function enforcedCeilings(ctx: CeilingContext): ApplicableCeiling[] {
  return CEILING_RULES.map((r) => (r.enforced ? r.evaluate(ctx) : null)).filter(
    (c): c is ApplicableCeiling => c !== null,
  );
}

/** 最严的那条上限，没有则返回 null */
export function strictestCeiling(
  ceilings: ApplicableCeiling[],
): ApplicableCeiling | null {
  if (ceilings.length === 0) return null;
  return ceilings.reduce((a, b) => (b.maxScore < a.maxScore ? b : a));
}

/**
 * 把模型给的分收拢到它自己的诊断所允许的上限之内。
 *
 * 只往下压、不往上抬：模型如果自己就给了低分（比如判定跑题给了 0），
 * 那说明它读出了上限规则看不见的东西，不要去覆盖它。
 */
export function applyCeiling(
  score15: number,
  ceiling: ApplicableCeiling | null,
): number {
  if (!ceiling) return score15;
  return Math.min(score15, ceiling.maxScore);
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
