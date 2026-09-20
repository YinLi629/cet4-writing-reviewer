/**
 * 批改提示词。
 *
 * ⚠️ 这个文件是整个项目里唯一"业务规则集中"的地方，也是**替换点**：
 * 如果你之后拿到了真正的 english-exam-writing-reviewer Skill，只需要改
 * buildReviewPrompt 的实现（把 SKILL.md 的规则搬进来），让它继续返回
 * { system, user } 两个字符串即可，其余代码一行都不用动。
 *
 * 前提是模型输出的 JSON 结构保持不变——结构定义见下面 JSON_CONTRACT，
 * 解析与校验在 lib/review.ts。
 */

import {
  BANDS,
  DIMENSION_GUIDE,
  EVIDENCE_KIND_GUIDE,
  ESSAY_MAX_SCORE_106,
  ESSAY_MAX_SCORE_15,
  RUBRIC_VERSION,
  tierGapFor,
} from "./rubric";
import { DIMENSIONS } from "./types";

/** 证据条数下限。太少说明模型没认真读，会触发重试。 */
export const MIN_EVIDENCE = 5;
/** 证据条数上限。防止模型把整篇作文拆成一百条，报告没法看。 */
export const MAX_EVIDENCE = 15;

/**
 * 要求模型返回的 JSON 结构。
 * 之所以把它写进 prompt 而不是只依赖 response_format=json_object，
 * 是因为后者只保证"是合法 JSON"，不保证字段对。
 */
const JSON_CONTRACT = `{
  "score15": 整数，0 到 15。整体印象分，四级作文唯一的计分依据。
  "summary": "总评，2-4 句中文。先说档次观感，再点出最关键的 1-2 个问题或优点。不要复述分数。",
  "strengths": ["这篇作文确实做对的地方，中文，1-4 条。没有就返回空数组，不要硬凑。"],
  "dimensionScores": [
    {
      "dimension": "content | language | organization 三选一，三项都要出现",
      "score": 整数 0-5，仅用于诊断强弱分布，不参与总分,
      "comment": "该维度的中文诊断，1-3 句，必须具体到这篇作文，不要套话"
    }
  ],
  "evidence": [
    {
      "dimension": "content | language | organization",
      "kind": "strength | minor | major",
      "quote": "从学生作文里【逐字复制】的片段，见下方硬性要求",
      "comment": "这条证据说明了什么，中文，1-2 句",
      "suggestion": "如何改进。kind 为 strength 时可以省略"
    }
  ],
  "upgradePlan": [
    {
      "priority": 整数，1 是最该先做的,
      "dimension": "content | language | organization",
      "action": "具体要做什么，中文，一句话，必须可执行。不要写“多练习”“注意语法”这类无法落地的建议。",
      "rationale": "为什么这样做能升档——要对应到档次描述里的具体差距",
      "example": {
        "before": "原文中的写法（尽量逐字来自原文）",
        "after": "改写后的写法"
      }
    }
  ]
}`;

const QUOTE_RULES = `【关于 quote 的硬性要求——违反会导致证据无法定位，报告里会标红】
1. quote 必须是从学生作文中**逐字复制**的连续片段，一个字符都不能改。
2. 禁止改写、禁止纠正拼写、禁止补全省略、禁止翻译、禁止合并相隔的句子。
   - 原文写 "he go to school"，你就抄 "he go to school"，不要抄成 "he goes to school"。
3. 长度控制在 5-40 个词之间。太短（如单个词）会定位到多处，太长会难以精确。
4. 必须保留原文的大小写和标点。
5. 如果确实需要跳过中间内容，只能用省略号 "..." 连接两段**各自逐字**的片段，
   系统会分段定位。不要在省略号两侧夹杂自己的改写。
6. 不要引用学生作文里不存在的句子。宁可少给一条证据，也不要编造。`;

const KIND_RULES = `【关于 kind 的判定】
- strength：${EVIDENCE_KIND_GUIDE.strength}
- minor：${EVIDENCE_KIND_GUIDE.minor}
- major：${EVIDENCE_KIND_GUIDE.major}

严格区分 minor 与 major。时态混乱、主谓不一致、句子结构残缺、可数名词与冠词系统性误用、
中式英语导致语义不通——这些是 major。个别笔误、单处搭配不当、大小写疏漏——这些是 minor。
不要把所有错误都标成 major，那等于没有区分度。`;

function formatBandTable(): string {
  return BANDS.map(
    (b) =>
      `- ${b.label}（${b.range[0]}-${b.range[1]} 分）：${b.descriptor}`,
  ).join("\n");
}

export interface ReviewPromptInput {
  essay: string;
  topic?: string;
  /** 目标档次 level。给了就在升档建议里对着这个目标写。 */
  targetBandLevel?: number;
  /** 当前档 level，用于取档次差距。第一轮调用时未知，可不传。 */
  currentBandLevel?: number;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  rubricVersion: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): BuiltPrompt {
  const { essay, topic, targetBandLevel, currentBandLevel } = input;

  const system = `你是一位全国大学英语四级考试（CET-4）作文阅卷员，有多年阅卷经验。
你的任务是批改一篇学生作文，输出档次判断、诊断意见、原文证据与升档建议。

【评分方法：整体评分法】
四级作文采用整体评分法。你需要看完全文后凭整体印象给出一个 0-${ESSAY_MAX_SCORE_15} 的整数分，
而不是把几个维度的分数加起来。维度分（content/language/organization）只用于告诉学生
强弱分布，绝对不参与总分计算。

【档次表】
${formatBandTable()}

你只负责给 score15 这个整数。档次名称由系统按分数查表得出，你不需要在输出里写档次名。
请严格按上面的档次描述来定分：描述里写"少量语言错误"就是 11 分档，
写"语言错误相当多，其中有一些是严重错误"就是 8 分档，不要凭感觉上浮。

【三个诊断维度】
${DIMENSIONS.map((d) => `- ${DIMENSION_GUIDE[d]}`).join("\n")}

${QUOTE_RULES}

${KIND_RULES}

【证据条数】
至少 ${MIN_EVIDENCE} 条，最多 ${MAX_EVIDENCE} 条。要覆盖 language 维度为主，
但 content 和 organization 也必须有证据，不能三个维度里有两个是空的。
如果作文确实写得很好，strength 类证据可以占多数，但依然要指出仍可改进之处。

【升档建议】
给 3-5 条，按 priority 从 1 开始递增排序。每条都必须是这篇作文**具体可执行**的动作，
并配一个 before/after 改写示范。禁止出现"多背单词""多练习写作"这类放之四海而皆准的废话。

【输出格式】
只输出一个 JSON 对象，不要输出任何解释文字，不要用 Markdown 代码块包裹。结构如下：
${JSON_CONTRACT}`;

  const gap =
    currentBandLevel !== undefined
      ? `\n【当前档位到目标的差距（升档建议请对着这个写）】\n${tierGapFor(currentBandLevel, targetBandLevel)}\n`
      : targetBandLevel !== undefined
        ? `\n【学生的目标档位】${BANDS.find((b) => b.level === targetBandLevel)?.label ?? "未知"}。升档建议请对着这个目标写。\n`
        : "";

  const topicBlock = topic?.trim()
    ? `【作文题目 / 要求】\n${topic.trim()}\n\n请据此判断是否切题、是否回应了题目要求的要点。`
    : `【作文题目 / 要求】\n（学生没有提供题目。请在 summary 里说明：缺少题目，是否切题这一项无法完全判断，你的评价基于文章自身的完整性与逻辑。）`;

  const user = `${topicBlock}
${gap}
【学生作文原文】
<<<ESSAY_START>>>
${essay}
<<<ESSAY_END>>>

请按上述 JSON 结构输出批改结果。注意 quote 字段必须是 <<<ESSAY_START>>> 与 <<<ESSAY_END>>> 之间
原文的逐字复制。`;

  return { system, user, rubricVersion: RUBRIC_VERSION };
}

/**
 * 折算分只是放在这里方便报告排版引用，真正的计算在 lib/rubric.ts 的 toScore106。
 * 留这个常量是为了让报告文案能说明"作文占 106.5 分"。
 */
export const ESSAY_MAX_SCORE_106_HINT = ESSAY_MAX_SCORE_106;
