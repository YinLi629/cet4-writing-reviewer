/**
 * 离线自测。不联网、不需要 API key，只验证"能被代码确定"的那部分逻辑：
 * 证据定位、档次查表、分数折算、高亮切分、HTML 转义、模型输出的防御性解析。
 *
 * 跑法： npm run selftest
 */

import { getAccessCode, hasAccessCode, verifyAccessCode } from "../lib/access";
import { chatJSON, LLMError, openChatStream } from "../lib/deepseek";
import { locateQuote, attachLocations } from "../lib/evidence";
import { ANCHOR_PREFIX, anchorMap, segmentEssay } from "../lib/highlight";
import { scanJsonPrefix, type ScanResult, type ScannedMember } from "../lib/json-stream";
import { METHOD_LABEL, TRAINING_FOCUS_LABEL } from "../lib/labels";
import { MAX_EVIDENCE } from "../lib/prompt";
import {
  buildFailureUpsert,
  buildPeek,
  buildSuccessAndCount,
  buildSweep,
} from "../lib/rate-limit-sql";
import {
  clientKeyFrom,
  clearedFailureState,
  configFromEnv,
  FAIL_DECAY_SECS,
  FAIL_TIER1_COUNT,
  FAIL_TIER1_LOCK_SECS,
  FAIL_TIER2_COUNT,
  FAIL_TIER2_LOCK_SECS,
  HOUR_SECS,
  isLocked,
  isNewStreak,
  isOverLimit,
  LOCK_STREAK_CAP_SECS,
  lockSecsFor,
  nextFailureState,
  type FailureState,
  type RateLimitPolicy,
} from "../lib/rate-limit";
import {
  ACCESS_DENIED_MESSAGE,
  humanizeWait,
  lockedAfterFailureMessage,
  lockedMessage,
  MISSING_CONFIG_MESSAGE,
  penalizeAccessFailure,
} from "../lib/access-gate";
import {
  createMemoryStore,
  persistenceMode,
  SWEEP_RETENTION_WINDOWS,
  withFallback,
  type RateLimitGate,
} from "../lib/rate-limit-store";
import { buildReportHtml, escapeHtml, renderHighlightedEssay } from "../lib/report-html";
import { MAX_BODY_BYTES, readJsonBody } from "../lib/request-body";
import {
  applicableCeilings,
  applyCeiling,
  bandForScore,
  CEILING_RULE_TABLE,
  clampScore15,
  readScore15,
  score15Field,
  enforcedCeilings,
  strictestCeiling,
  toScore106,
  tierGapFor,
  type CeilingContext,
} from "../lib/rubric";
import {
  __internals,
  coerceExample,
  coerceKind,
  locateExampleQuote,
  normalizeInput,
  reviewEssay,
  reviewEssayStream,
} from "../lib/review";
import { createSseFrameParser, encodeSseFrame, SSE_RESPONSE_HEADERS } from "../lib/sse";
import {
  coerceDraft,
  isDraftEmpty,
  isResultFresh,
  loadDraft,
  RESULT_FRESH_MS,
  saveDraft,
} from "../lib/store";
import { computeStats } from "../lib/text-stats";
import {
  coerceTrainingFocus,
  TRAINING_FOCUS_DIMENSION,
  TRAINING_FOCUSES,
  TRAINING_PLAYBOOK,
} from "../lib/training";
import {
  deadlineCode,
  deadlineFor,
  deadlineMessage,
  FIRST_FRAME_DEADLINE_MS,
  readPhase,
  silenceHint,
  SILENCE_HINT_SECONDS,
  STREAM_STALL_DEADLINE_MS,
} from "../lib/watchdog";
import {
  MAX_QUOTE_CHARS,
  MAX_TOPIC_CHARS,
  type Evidence,
  type ReviewResult,
  type ReviewStreamEvent,
  type TrainingFocus,
} from "../lib/types";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      实际: ${JSON.stringify(detail)}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), {
    actual,
    expected,
  });
}

/**
 * 去掉 SQL 里的 `--` 注释。
 *
 * 下面那些断言扫的是 SQL 文本，而文本里带着写给读者看的注释——注释里会提到
 * `$3 = 10` 这类东西，甚至可能被写得更像代码。断言应该只看**真正会执行的部分**，
 * 否则改一句注释就能让测试变红（或者更糟：让本该变红的测试保持绿）。
 */
function stripSqlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
console.log("\n[1] 证据定位");

const ESSAY = `I am a student want to join your volunteer program.
I very like help other people. When I see your poster, I am very exciting.

Last year I also join a activity about clean the park. I think I have many advantage.`;

// 逐字命中
const exact = locateQuote(ESSAY, "I very like help other people.");
eq("逐字命中：method", exact.method, "exact");
eq("逐字命中：切片正确", ESSAY.slice(exact.start!, exact.end!), "I very like help other people.");

// 大小写与空白差异 → 归一化命中
const norm = locateQuote(ESSAY, "i   very like   help other people.");
eq("忽略大小写/空白：method", norm.method, "normalized");
eq("忽略大小写/空白：切片正确", ESSAY.slice(norm.start!, norm.end!), "I very like help other people.");

// 引文被模型包了引号、首尾加了省略号 → 清洗后仍应命中
const wrapped = locateQuote(ESSAY, '"I very like help other people."');
eq("剥掉包裹引号后命中", wrapped.method, "exact");
// 引号两侧的空白也要一起剥掉（清洗正则改写成非回溯形式后的回归）
eq("引号外带空白也能剥掉", locateQuote(ESSAY, '  "  I very like help other people.  "  ').method, "exact");
// 两层包裹（中文弯引号套英文直引号）
eq("两层包裹引号也能剥", locateQuote(ESSAY, `“‘I very like help other people.’”`).method, "exact");

// 省略号分段
const frag = locateQuote(ESSAY, "I am a student want to join ... I am very exciting.");
eq("省略号分段：method", frag.method, "fragmented");
check("省略号分段：跨越正确区间", frag.start === 0 && frag.end! > 100, frag);

// 分段数量上限：每段都要单独定位一次，塞满省略号的引文会把开销放大成平方级
const SEG_ESSAY = Array.from({ length: 40 }, (_, i) => `segment${i}`).join(" and ");
const dotsFor = (n: number) =>
  Array.from({ length: n }, (_, i) => `segment${i}`).join(" ... ");
eq("分段数在限内仍然定位", locateQuote(SEG_ESSAY, dotsFor(10)).method, "fragmented");
eq("分段数超限则放弃定位", locateQuote(SEG_ESSAY, dotsFor(30)).method, "none");

// İ(U+0130) 小写化会展开成 "i" + 组合点两个 code unit。早期实现里归一化
// 字符串多出一个字符、而坐标映射只多推了一次，两个数组从此错位，
// 后面所有坐标整体偏移 1 —— 高亮画错地方，而且不报任何错。
const TURKISH = "İstanbul is big. My favourite colour is blue and I like it.";
const turkish = locateQuote(TURKISH, "my favourite colour is blue");
eq("İ 之后仍能归一化命中", turkish.method, "normalized");
eq(
  "İ 不会让坐标漂移（切片仍在原文中对得上）",
  TURKISH.slice(turkish.start!, turkish.end!),
  "My favourite colour is blue",
);
// 引文里本身带 İ 的逐字命中不受影响
eq("含 İ 的引文逐字命中", locateQuote(TURKISH, "İstanbul is big.").method, "exact");

// 模糊命中：改了几个词
const fuzzy = locateQuote(ESSAY, "Last year I also joined a activity about cleaning the park");
eq("模糊命中：method", fuzzy.method, "fuzzy");

// 编造的引文 → 定位失败
const bogus = locateQuote(ESSAY, "This sentence does not exist anywhere in the essay at all.");
eq("编造引文：定位失败", bogus.method, "none");
eq("编造引文：坐标为 null", bogus.start, null);

// 同一句话出现两次，两条证据应落在不同位置
const REPEAT = "I like English. Some text here. I like English.";
const locatedRepeat = attachLocations(REPEAT, [
  { id: "e1", dimension: "language", kind: "minor", quote: "I like English.", comment: "a" },
  { id: "e2", dimension: "language", kind: "minor", quote: "I like English.", comment: "b" },
]);
eq("重复句：第一条落在第一处", locatedRepeat[0].start, 0);
// "I like English." 占 0-14，" Some text here. " 再占 15-31，所以第二处在 32
eq("重复句：第二条落在第二处", locatedRepeat[1].start, 32);
check(
  "重复句：两条不重叠",
  locatedRepeat[0].end! <= locatedRepeat[1].start!,
  locatedRepeat,
);

// ---------------------------------------------------------------------------
// [1b] 定位歧义：找到了，但可能找错了
//
// 上面那条"重复句"是**正确**处理：同一句话被两条证据引用时各占一处。
// 这一节盯的是它旁边那个安静得多的失败模式——只有一条证据、而原文里有好几处
// 都能匹配。这时定位代码仍然取第一处、仍然报 method: "exact"、仍然 verified，
// 报告上带着"逐字命中原文"的徽章高亮到**别的那一句**上，用户没有任何线索。
//
// 所以断言的不是"取哪一处"（那本来就只能是猜），而是**这件事有没有被说出来**。
// method 一个字都不许变：它回答"怎么匹配上的"，那几处确实都是逐字命中。
// ---------------------------------------------------------------------------
console.log("\n[1b] 定位歧义");

const AMBI = "He is tall. The weather is nice today. He is tall.";
const ambigShort = locateQuote(AMBI, "He is tall.");
eq("多处逐字命中：仍然报 exact（匹配方式没有疑问）", ambigShort.method, "exact");
eq("多处逐字命中：仍然算定位成功", ambigShort.start !== null, true);
eq("多处逐字命中：歧义原因", ambigShort.ambiguity, "multiple");
eq("多处逐字命中：候选处数", ambigShort.hitCount, 2);
// 用切片断言而不是写死下标：写死的话，改一个字符就要重算一遍魔数，
// 而真正要钉住的是"它落在了某一处完整的那句话上"
eq(
  "多处逐字命中：落在第一处完整的那句话上（当下最合理的猜测）",
  AMBI.slice(ambigShort.start!, ambigShort.end!),
  "He is tall.",
);

// 只出现一次的引文不该被染上歧义——否则每条证据都挂着徽章，用户很快就学会无视它
const ambigNone = locateQuote(AMBI, "The weather is nice today.");
eq("唯一命中：没有歧义", ambigNone.ambiguity, undefined);
eq("唯一命中：没有候选数", ambigNone.hitCount, undefined);

// 归一化路径同样有多处命中的问题（大小写/空白不同，但确实是同一句话）
const AMBI_CASE = "he is tall. Some filler sentence. HE IS TALL.";
const ambigNorm = locateQuote(AMBI_CASE, "He is tall.");
eq("归一化后多处命中：仍报 normalized", ambigNorm.method, "normalized");
eq("归一化后多处命中：同样标出歧义", ambigNorm.ambiguity, "multiple");

// 归一化路径的候选数：这里不该算上被 claimed 占掉的那些，
// 否则同一批引文的数量统计会随证据顺序漂移
const ambigNormClaimed = locateQuote(AMBI_CASE, "He is tall.", [[0, 11]]);
eq("候选数与是否被占用无关（统计不随排序漂移）", ambigNormClaimed.hitCount, 2);
eq(
  "候选数与是否被占用无关：落点让给了空着的那处",
  AMBI_CASE.slice(ambigNormClaimed.start!, ambigNormClaimed.end!),
  "HE IS TALL.",
);

// 模糊匹配：落在哪一处本来就只是近似。窗口长度会取 n-1/n/n+1 三种，
// 同一处命中会产生好几个重叠窗口，所以数"几处"必须先按区间合并
const FUZZY_ESSAY =
  "Last year I also join a activity about cleaning the park. " +
  "Some other words in between here. " +
  "Last year I also joined an activity about cleaning the park.";
const fuzzyMulti = locateQuote(
  FUZZY_ESSAY,
  "Last year I also joined a activity about cleaning the park",
);
eq("模糊匹配：方法仍是 fuzzy", fuzzyMulti.method, "fuzzy");
eq("模糊匹配：多处近似时标出歧义", fuzzyMulti.ambiguity, "multiple");
eq(
  "模糊匹配：重叠窗口按区间合并后只算 2 处（不把一次命中数成三四次）",
  fuzzyMulti.hitCount,
  2,
);

// attachLocations 要把歧义贴到 Evidence 上——渲染层读的就是那两个字段
const ambiAttached = attachLocations(AMBI, [
  { id: "e1", dimension: "language", kind: "minor", quote: "He is tall.", comment: "a" },
]);
eq("attachLocations：歧义被贴到证据上", ambiAttached[0].ambiguity, "multiple");
eq("attachLocations：候选数一并带上", ambiAttached[0].hitCount, 2);

// 没定位上的条目不该带歧义："有多处候选"和"根本没找到"是两句互相打架的话
const ambiMiss = attachLocations(AMBI, [
  { id: "e1", dimension: "language", kind: "minor", quote: "Nowhere to be seen.", comment: "a" },
]);
eq("没定位上的条目：verified 为假", ambiMiss[0].verified, false);
eq("没定位上的条目：不挂歧义（那是自相矛盾的说法）", ambiMiss[0].ambiguity, undefined);

// ---------------------------------------------------------------------------
console.log("\n[2] 档次查表与分数折算");

eq("0 分 → 0 分档", bandForScore(0).label, "0 分档");
eq("1 分 → 2 分档", bandForScore(1).label, "2 分档");
eq("3 分 → 2 分档", bandForScore(3).label, "2 分档");
eq("4 分 → 5 分档", bandForScore(4).label, "5 分档");
eq("7 分 → 8 分档", bandForScore(7).label, "8 分档");
eq("10 分 → 11 分档", bandForScore(10).label, "11 分档");
eq("12 分 → 11 分档", bandForScore(12).label, "11 分档");
eq("13 分 → 14 分档", bandForScore(13).label, "14 分档");
eq("15 分 → 14 分档", bandForScore(15).label, "14 分档");
eq("越界负数被夹住", bandForScore(-5).label, "0 分档");
eq("越界超上限被夹住", bandForScore(99).label, "14 分档");
eq("小数四舍五入", clampScore15(9.6), 10);

eq("15 分 → 106.5", toScore106(15), 106.5);
eq("9 分 → 63.9", toScore106(9), 63.9);
eq("0 分 → 0", toScore106(0), 0);

check("升档差距：有对应文案", tierGapFor(3).includes("8 分档到 11 分档"), tierGapFor(3));
check("升档差距：跨档时串起中间档", tierGapFor(1, 3).split("从").length - 1 >= 2, tierGapFor(1, 3));

// ---------------------------------------------------------------------------
console.log("\n[2b] 分数上限（模型的分不能突破它自己的诊断）");

// 默认是一篇"没有任何问题"的作文：150 词、4 段、无 major、维度满分
const ctx = (over: Partial<CeilingContext> = {}): CeilingContext => ({
  majorCount: 0,
  organizationScore: 5,
  contentScore: 5,
  wordCount: 150,
  paragraphCount: 4,
  ...over,
});
// 代码实际强制的那一层
const ceil = (over: Partial<CeilingContext> = {}) =>
  strictestCeiling(enforcedCeilings(ctx(over)));

eq("各方面正常 → 不设上限", ceil(), null);
// 1-2 条 major 不强制：模型的 major 标注有 run-to-run 抖动（b1 两次运行
// 分别标了 0 条和 2 条），单条标注不足以支撑改分
eq("1 条 major → 不强制（留给 prompt 指引）", ceil({ majorCount: 1 }), null);
eq("2 条 major → 不强制", ceil({ majorCount: 2 }), null);
// prompt 里对 major 讲的是定性版（只要有一条就不许进 11 分档），比代码严。
// 同时也守住"别把这条的阈值写进 prompt"——写进去等于教模型少标两条来绕开上限。
// （many-major 的"5 处及以上"不受此限：那条本来就是公开的、极严的数字，
//   而且少报到 4 条以下也躲不开上面这条定性规则。）
check(
  "prompt 对 major 讲的是定性版、没暴露 3 条这个阈值",
  CEILING_RULE_TABLE.some((s) => s.includes("只要标出了 major")) &&
    !CEILING_RULE_TABLE.some((s) => /标出 3 处/.test(s)),
  CEILING_RULE_TABLE,
);
eq("3 条 major → 上限 9", ceil({ majorCount: 3 })?.maxScore, 9);
eq("4 条 major → 上限 9", ceil({ majorCount: 4 })?.maxScore, 9);
eq("5 条 major → 上限 6", ceil({ majorCount: 5 })?.maxScore, 6);
eq("9 条 major → 上限 6", ceil({ majorCount: 9 })?.maxScore, 6);
eq("词数 99 → 上限 9", ceil({ wordCount: 99 })?.maxScore, 9);
eq("词数 100 → 不设上限（刚好达标线）", ceil({ wordCount: 100 }), null);
eq("词数 110 → 不设上限", ceil({ wordCount: 110 }), null);
eq("词数 <60 → 上限 6", ceil({ wordCount: 59 })?.maxScore, 6);
// 分段问题**不**直接砍总分：8 分档的描述要求"语言错误相当多"，而单段但语言
// 通顺的作文（评测里的 c6）不满足这个描述。分段走 organization 维度，
// 由 weak-organization 间接影响总分。
eq("单段长文不直接压总分", ceil({ paragraphCount: 1, wordCount: 154 }), null);
eq("单段短文只按字数算（40 词 → 6）", ceil({ paragraphCount: 1, wordCount: 40 })?.maxScore, 6);
// organization 的软规则：写进 prompt 但代码不强制。
// 阈值是 ≤2 而不是 ≤3——11 分档和 14 分档的条文**都**要求"连贯"，
// 所以 organization 分根本区分不了这两档，只该兜"结构真的崩了"。
// 3/5 表示"段落划分一般"，评测里 b1/b2（156 词切 7 段）就是这个分，
// 它们被判 13 分是对的，不该被规则压。
eq("organization 3/5 → 不设上限（一般，不是崩）", ceil({ organizationScore: 3 }), null);
eq("organization 2/5 → 仍在 prompt 的完整规则表里（上限 12）", strictestCeiling(applicableCeilings(ctx({ organizationScore: 2 })))?.maxScore, 12);
eq("organization 1/5 → 还在表里", strictestCeiling(applicableCeilings(ctx({ organizationScore: 1 })))?.maxScore, 12);
eq("organization 2/5 → 代码不强制", ceil({ organizationScore: 2 }), null);
eq("content 2/5 → 上限 9", ceil({ contentScore: 2 })?.maxScore, 9);
eq("content 1/5 → 上限 4（文不对题）", ceil({ contentScore: 1 })?.maxScore, 4);
eq("content 0/5 → 上限 4", ceil({ contentScore: 0 })?.maxScore, 4);
eq("content 3/5 → 不设上限（一般，不是套话）", ceil({ contentScore: 3 }), null);
eq("content 4/5 → 不设上限", ceil({ contentScore: 4 }), null);
// a6 复现：模型自己写"全文没有一处提到 sports、没有回应题目要点"，content 给 1，
// 总分却给 5。0 分档的条文（文不对题）必须把它压下来。
eq("a6 复现：content 1 时 5 分被压到 4", applyCeiling(5, ceil({ contentScore: 1 })), 4);
// 但这条不该碰好作文：content 3 的 c9（13 分）和 content 2 的 c7（6 分）都不动
eq("content 3 的 13 分不动", applyCeiling(13, ceil({ contentScore: 3 })), 13);
eq("content 2 的 6 分不动（上限不抬分）", applyCeiling(6, ceil({ contentScore: 2 })), 6);
eq("多条命中取最严的", ceil({ majorCount: 6, contentScore: 2 })?.maxScore, 6);
// content 1（上限 4）比 many-major（上限 6）更严，取 4
eq("多条命中取最严的：文不对题压过大量严重错误", ceil({ majorCount: 6, contentScore: 1 })?.maxScore, 4);
eq("缺维度分时不误判", ceil({ organizationScore: null, contentScore: null }), null);
eq("未强制的规则不出现在强制层里", enforcedCeilings(ctx({ organizationScore: 1 })).length, 0);

// 这条是 2026-09 评测里 a3 的复现：模型自己标了 major、language 只给 3/5，
// 总分却给了 11。上限必须把它压回 8 分档。
eq("a3 复现：3 条 major 时 11 分被压到 9", applyCeiling(11, ceil({ majorCount: 3 })), 9);
eq("a3 复现：压完之后落在 8 分档", bandForScore(applyCeiling(11, ceil({ majorCount: 3 }))).label, "8 分档");
eq("只压不抬：模型给的 0 分不动", applyCeiling(0, ceil({ majorCount: 3 })), 0);
eq("没上限时分毫不动", applyCeiling(13, ceil()), 13);
// 1 条 major 的好作文不该被压：a4 在两次运行里分别得到 0 条和 1 条 major
eq("1 条 major 时 13 分不动（不误伤好作文）", applyCeiling(13, ceil({ majorCount: 1 })), 13);

// ---------------------------------------------------------------------------
// [2c] score15 的入口收拢（全文唯一的计分来源）
//
// 这是整轮里最该防守的一处：`score15` 是**唯一**决定分数和档次的值，而它原来的
// 校验是全部入口里最弱的（`typeof n === "number" ? n : 0`）。模型把分数写成字符串
// 时，学生拿到一份看起来完全正常、实际 0 分 0 档的报告，不报错也不告警。
//
// 这张表逐条列出"什么算数、什么不算"。判据的边界都在这里钉着，因为任何一条放宽
// 都会重新打开那个静默出错的入口。特别是**不能拿 Number() 来兜底**：
// Number("") === 0、Number(" ") === 0、Number("0x10") === 16、Number(true) === 1，
// 每一条都会把"模型没给分数"变成一个具体的、看起来合理的分数。
// ---------------------------------------------------------------------------
console.log("\n[2c] score15 的入口收拢");

// —— 该收的 ——
eq("数字原样通过", readScore15(12), 12);
eq("0 是合法分数（不是“没给”）", readScore15(0), 0);
eq("15 是合法分数", readScore15(15), 15);
eq("数字字符串被收下（模型的常见写法）", readScore15("12"), 12);
eq("带空白的数字字符串", readScore15(" 12 "), 12);
eq("带正号的数字字符串", readScore15("+3"), 3);
eq("小数按四舍五入进整数档", readScore15(9.6), 10);
eq("小数落在 .5 上按四舍五入", readScore15("8.5"), 9);
eq("省略整数部分的写法", readScore15(".5"), 1);
eq("越界超上限被夹紧", readScore15(99), 15);
eq("越界负数被夹紧", readScore15(-3), 0);

// —— 不该收的：每一条都必须落 0，而且必须能被 score15Field 认出来 ——
const unusable: Array<[string, unknown]> = [
  ["空字符串", ""],
  ["纯空白", "   "],
  ["数字后面跟着废话", "12abc"],
  ["数字开头的中文", "12分"],
  ["十六进制写法（Number 会读成 16）", "0x10"],
  ["科学计数法（Number 会读成 100）", "1e2"],
  ["NaN 字符串", "NaN"],
  ["Infinity 字符串", "Infinity"],
  ["布尔 true（Number 会读成 1）", true],
  ["布尔 false（Number 会读成 0，看着像正常分数）", false],
  ["null（Number 会读成 0）", null],
  ["undefined", undefined],
  ["数字 NaN", Number.NaN],
  ["数字 Infinity", Number.POSITIVE_INFINITY],
  ["数组", [12]],
  ["对象", { score15: 12 }],
  ["空对象", {}],
];
for (const [label, value] of unusable) {
  eq(`不收：${label} → 0 分`, readScore15(value), 0);
  eq(`不收：${label} → 能被认出是无效值`, score15Field(value), "unusable");
}

// 收下的那几种要能和"无效"区分开，否则 lib/review.ts 那条警告会误报
eq("数字 → 字段是 number", score15Field(12), "number");
eq("数字字符串 → 字段是 numeric-string", score15Field("12"), "numeric-string");
eq("带空白的数字字符串也算 numeric-string", score15Field(" 12 "), "numeric-string");

// clampScore15 是数值层的夹紧，保持原样：readScore15 收不下的值一律落 0，
// 而 clampScore15 仍然只认 number（它是给已经确定是数字的调用方用的）
eq("clampScore15 对非数字仍然落 0", clampScore15("12" as never), 0);
eq("clampScore15 对数字照旧夹紧", clampScore15(9.6), 10);

// —— 两个函数必须永远一致 ——
// readScore15 决定分数，score15Field 决定"要不要出声"。两者判据一分叉，
// 就会出现介于"读出来了"和"报了警"之间的第三种状态：分数是 0，而没人告诉用户。
// 那正是这一轮要消灭的静默出错，所以这里穷举着钉一遍。
// （这条在写的时候真抓到过一个：NaN 是 typeof "number"，score15Field 说它是
//   number，而 readScore15 读成 0——一份 0 分报告，零条警告。）
const consistencyProbe: unknown[] = [
  12, 0, 15, 9.6, -3, 99, Number.NaN, Number.POSITIVE_INFINITY, "12", " 12 ", "+3", "8.5", ".5",
  "99999", "9".repeat(400),
  ...unusable.map(([, value]) => value),
];
let inconsistent = 0;
for (const value of consistencyProbe) {
  if (score15Field(value) === "unusable" && readScore15(value) !== 0) inconsistent += 1;
}
eq(
  `一致性：${consistencyProbe.length} 个值里，没有一个"判为无效却读出了非 0 分"`,
  inconsistent,
  0,
);
// 反向也要成立：能被判为有效的值不该读到 0 分（负数/0 例外，那是真的夹紧）
let silentlyZero = 0;
for (const value of consistencyProbe) {
  const field = score15Field(value);
  if (field !== "unusable" && readScore15(value) === 0) {
    if (!(typeof value === "number" && value <= 0)) silentlyZero += 1;
  }
}
eq(`一致性：判为有效的值也不会悄悄读成 0 分`, silentlyZero, 0);

// ---------------------------------------------------------------------------
console.log("\n[3] 文本统计");

const stats = computeStats("Hello world. This is a test!\n\nSecond paragraph here.");
eq("词数", stats.wordCount, 9);
eq("句数", stats.sentenceCount, 3);
eq("段数", stats.paragraphCount, 2);
eq("空文本词数", computeStats("").wordCount, 0);
eq("空文本段数", computeStats("").paragraphCount, 0);

// ---------------------------------------------------------------------------
console.log("\n[4] 输入校验");

const bad = (essay: unknown) => {
  try {
    normalizeInput({ essay } as never);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
check("空作文被拒", bad("") !== null);
check("过短作文被拒", bad("too short") !== null);
// 作文没有字数上限（2026-09 取消的）。原来这里断言的是一条 8000 字符的上限，
// 现在反过来钉住"不再有上限"。真正拦住超长输入的是 request-body.ts 的 128 KB
// 请求体上限，那一步在 JSON.parse 之前就返回 413，走不到 normalizeInput。
check("超长作文不再被拒", bad("a".repeat(20000)) === null);
check("正常作文通过", bad("This is a long enough essay to be graded properly.") === null);

// 题目也要有上限：它会原样进 prompt，不限的话 token 成本成倍放大，
// 而且比作文正文更适合藏提示注入
const badTopic = (topic: unknown) => {
  try {
    normalizeInput({
      essay: "This is a long enough essay to be graded properly.",
      topic,
    } as never);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
check("不传题目通过", badTopic(undefined) === null);
check(`题目恰好到上限（${MAX_TOPIC_CHARS}）通过`, badTopic("a".repeat(MAX_TOPIC_CHARS)) === null);
check("超长题目被拒", badTopic("a".repeat(MAX_TOPIC_CHARS + 1)) !== null);

// ---------------------------------------------------------------------------
console.log("\n[5] 模型输出的防御性解析");

const messy = __internals.parseEvidence([
  { dimension: "language", kind: "MAJOR", quote: "I very like help", comment: "错误" },
  { dimension: "bogus-dim", kind: "minor", quote: "some quote", comment: "应被丢弃" },
  { dimension: "content", kind: "minor", quote: "", comment: "空引文应被丢弃" },
  "not an object",
  { dimension: "organization", kind: "strength", quote: "I think I have many advantage", comment: "ok" },
]);
eq("非法维度被丢弃、空引文被丢弃、非对象被丢弃", messy.length, 2);
eq("kind 大小写被归一", messy[0].kind, "major");
check("id 连续生成", messy[0].id === "e1" && messy[1].id === "e2", messy.map((m) => m.id));

// 引文长度上限是性能护栏：证据定位的模糊匹配是平方量级的，
// 一条超长引文能让单条定位从毫秒涨到秒
const quoted = __internals.parseEvidence([
  { dimension: "language", kind: "minor", quote: "x".repeat(MAX_QUOTE_CHARS + 1), comment: "超长，应被丢弃" },
  { dimension: "language", kind: "minor", quote: "x".repeat(MAX_QUOTE_CHARS), comment: "恰好到上限，应保留" },
]);
eq("超长引文被丢弃、恰好到上限的保留", quoted.length, 1);
eq("保留下来的确实是那条到上限的", quoted[0]?.comment, "恰好到上限，应保留");

const warnings: string[] = [];
const dims = __internals.parseDimensionScores(
  [{ dimension: "content", score: 99, comment: "x" }],
  3,
  warnings,
);
eq("三个维度都被补齐", dims.length, 3);
eq("超范围分数被夹到 5", dims.find((d) => d.dimension === "content")!.score, 5);
eq("维度顺序固定", dims.map((d) => d.dimension), ["content", "language", "organization"]);
check("缺维度会产生 warning", warnings.length === 1, warnings);

const plan = __internals.parseUpgradePlan(
  [
    { priority: 9, dimension: "language", action: "先修时态", rationale: "r" },
    { priority: 2, dimension: "language", action: "先修时态", rationale: "r" }, // 与上一条重复
    { priority: 2, dimension: "content", action: "明确立场", rationale: "r" },
    { dimension: "organization", action: "加衔接词", rationale: "r", example: { before: "he go to school", after: "he goes to school" } },
    { priority: 1, dimension: "language", action: "", rationale: "空 action 应被丢弃" },
  ],
  [
    { id: "e1", dimension: "language", kind: "major", quote: "q", comment: "c", start: 0, end: 1, verified: true, locateMethod: "exact" },
  ],
  3,
  undefined,
  // essay 参数（第 5 个）是为了核查 example.before 在不在原文里，见 lib/review.ts
  "he go to school every day.",
);
eq("空 action 被丢弃、重复被去重", plan.length, 3);
eq("priority 被规整为连续的 1..n", plan.map((p) => p.priority), [1, 2, 3]);
check(
  "未指定关联证据的会自动挂同维度证据",
  plan.find((p) => p.dimension === "language")!.linkedEvidenceIds.includes("e1"),
  plan,
);
const withEx = plan.find((a) => a.dimension === "organization")!;
eq("example 保留下来", withEx.example, { before: "he go to school", after: "he goes to school" });
// before 逐字在原文里 → 不该被打上"编造"标记（eq 看不见 undefined 值的键，所以用 in）
check("能定位的 example 不打 exampleUnverified", !("exampleUnverified" in withEx), withEx);
check("给了 example 就不打 exampleMissing", !("exampleMissing" in withEx), withEx);
eq(
  "没给 example 的会被标出来（不是静默留白）",
  plan.filter((a) => a.exampleMissing === true).length,
  2, // 先修时态 / 明确立场 两条没给，加衔接词那条给了
);

// ---------------------------------------------------------------------------
// [5b] kind 的兜底必须留下痕迹
//
// `kind` 同时喂给展示（颜色）和判分（按 major 条数算的分数上限）。原来的兜底是
// 无声的：不是三个合法值就一律返回 minor（**最轻**的一档），于是一次字段异常会
// 悄悄把"3 条以上严重错误 → 上限 9 分""5 条以上 → 上限 6 分"整条掐掉，
// 模型的 11 分照旧发出去，报告上没有任何异常——这才是它比"丢弃"更危险的地方。
//
// 兜底值不变（仍是 minor），变的是**这件事被记下来**：coerceKind 返回 degraded，
// parseEvidenceItem 把它落到 kindDegraded 上，assembleResult 再据此出一条警告。
// ---------------------------------------------------------------------------
console.log("\n[5b] kind 的兜底留下痕迹");

eq("strength 原样通过", coerceKind("strength"), { kind: "strength", degraded: false });
eq("major 原样通过", coerceKind("major"), { kind: "major", degraded: false });
eq("minor 原样通过", coerceKind("minor"), { kind: "minor", degraded: false });
// 归一化逻辑不动：大小写和空白是排版噪声，不是模型的错误
eq("大小写被归一，不算降级", coerceKind("MAJOR"), { kind: "major", degraded: false });
eq("首尾空白被裁掉，不算降级", coerceKind("  minor "), { kind: "minor", degraded: false });

// 这些都必须降级为 minor **并且**被标记出来
const badKinds: Array<[string, unknown]> = [
  ["自造的档位", "severe"],
  ["中文的严重程度", "严重错误"],
  ["别的体系的用词", "error"],
  ["空字符串", ""],
  ["缺失（undefined）", undefined],
  ["null", null],
  ["数字", 3],
  ["布尔", true],
  ["对象", { kind: "major" }],
  ["数组", ["major"]],
];
for (const [label, value] of badKinds) {
  eq(`兜底：${label} → minor`, coerceKind(value).kind, "minor");
  eq(`兜底：${label} → 留下痕迹`, coerceKind(value).degraded, true);
}

// 落到证据条目上：降级的那条要带 kindDegraded，正常的那条不能带
const kinded = __internals.parseEvidence([
  { dimension: "language", kind: "severe", quote: "I very like help", comment: "自造档位" },
  { dimension: "language", kind: "MAJOR", quote: "I also want join", comment: "正常" },
]);
// 关键：**条目保留**。丢弃它会让证据条数缩水，进而触发"证据偏少"的警告甚至
// BAD_MODEL_OUTPUT——把一个字段写错升级成"这次批改失败"，代价不成比例
eq("降级的条目被保留下来（不是丢弃）", kinded.length, 2);
eq("降级的那条按 minor 处理", kinded[0].kind, "minor");
eq("降级的那条带上了标记", kinded[0].kindDegraded, true);
eq("正常的那条不带标记", kinded[1].kindDegraded, undefined);
eq("正常的那条仍是 major（大小写归一不受影响）", kinded[1].kind, "major");

// ---------------------------------------------------------------------------
console.log("\n[5c] 训练区与升档示范的核查");

// --- 练法查表必须是"满"的 --------------------------------------------------
//
// `Record<TrainingFocus, TrainingPlaybook>` 已经保证**键齐全**（漏一个键
// TypeScript 直接报错），但保证不了**内容非空**——`howTo: []`、`symptom: ""`
// 都是合法类型。而空内容才是真正会流到学生眼前的那种故障，所以两条都得断言。
for (const focus of TRAINING_FOCUSES) {
  const book = TRAINING_PLAYBOOK[focus];
  check(`练法表：${focus} 有 symptom`, book.symptom.trim().length > 0, book.symptom);
  check(`练法表：${focus} 有 watchOut`, book.watchOut.trim().length > 0, book.watchOut);
  check(`练法表：${focus} 至少 3 条 howTo`, book.howTo.length >= 3, book.howTo.length);
  check(`练法表：${focus} 至少 2 条 drills`, book.drills.length >= 2, book.drills.length);
  check(
    `练法表：${focus} 没有空条目`,
    [...book.howTo, ...book.drills].every((s) => s.trim().length > 0),
    [...book.howTo, ...book.drills],
  );
}

// 条数绊线。加类别是**有意**的动作，改动这一行就说明你想过了——这才是它的用处。
eq("练法表覆盖 13 个类别", TRAINING_FOCUSES.length, 13);
check("TRAINING_FOCUSES 无重复", new Set(TRAINING_FOCUSES).size === TRAINING_FOCUSES.length);

// 没有标签，卡片头就是一片空白；TypeScript 挡得住"漏键"，挡不住"值是空串"
for (const focus of TRAINING_FOCUSES) {
  check(`标签表：${focus} 有非空标签`, (TRAINING_FOCUS_LABEL[focus] ?? "").trim().length > 0);
}

// 维度映射只在"模型没给关联证据"时兜底。映射错了，卡片上的"相关证据"
// 会链到一篇毫不相干的原文片段上——比不链更让人困惑。
const VALID_DIMENSIONS = ["content", "language", "organization"];
for (const focus of TRAINING_FOCUSES) {
  check(
    `维度映射：${focus} 指向合法维度`,
    VALID_DIMENSIONS.includes(TRAINING_FOCUS_DIMENSION[focus]),
    TRAINING_FOCUS_DIMENSION[focus],
  );
}

// --- focus 的收敛：归一化"写法"，拒绝"未知语义" -----------------------------
eq("spelling 原样通过", coerceTrainingFocus("spelling"), "spelling");
eq("带连字符的类别原样通过", coerceTrainingFocus("noun-article"), "noun-article");
// 大小写和两端空白是排版噪声，不是模型的理解错误。整篇只有 1-3 条训练项，
// 因为首字母大写就**整条丢掉**，代价和收益完全不成比例（对比 kind 的降级处理）。
eq("大写被归一，不算非法", coerceTrainingFocus("SPELLING"), "spelling");
eq("两端空白被裁掉", coerceTrainingFocus("  tense "), "tense");
eq("混写被归一", coerceTrainingFocus("Noun-Article"), "noun-article");

// 这些是**真的认不出来**，必须返回 null，不能兜底到某一类：
// kind 兜错只是颜色偏轻，focus 兜错是配出一整套**错误的练法**，比少一条糟得多。
const badFocuses: Array<[string, unknown]> = [
  ["拼错的单词", "speling"],
  ["中文标签", "时态"],
  ["自造类别", "grammar"],
  ["别家体系的用词", "vocabulary"],
  ["空字符串", ""],
  ["纯空白", "   "],
  ["undefined", undefined],
  ["null", null],
  ["数字", 3],
  ["布尔", true],
  ["对象", { focus: "tense" }],
  ["数组", ["tense"]],
];
for (const [label, value] of badFocuses) {
  eq(`不收：${label} → null`, coerceTrainingFocus(value), null);
}

// --- 训练项解析 -------------------------------------------------------------
const TRAIN_EVIDENCE: Evidence[] = [
  { id: "e1", dimension: "language", kind: "major", quote: "q1", comment: "c", start: 0, end: 2, verified: true, locateMethod: "exact" },
  { id: "e2", dimension: "language", kind: "minor", quote: "q2", comment: "c", start: 3, end: 5, verified: true, locateMethod: "exact" },
  { id: "e3", dimension: "organization", kind: "minor", quote: "q3", comment: "c", start: 6, end: 8, verified: true, locateMethod: "exact" },
];

// 这一条 fixture 一次覆盖四种丢弃路径：非法 focus、重复 focus、空 reason、超上限
const trained = __internals.parseTrainingPlan(
  [
    { focus: "tense", reason: "全文 6 处时态来回跳" },
    { focus: "TENSE", reason: "重复类别，应被去重" },
    { focus: "spelling", reason: "反复拼错 accommodate" },
    { focus: "grammar", reason: "自造类别，整条应被丢弃" },
    { focus: "chinglish", reason: "   " },
    { focus: "cohesion", reason: "段落之间没有过渡" },
    { focus: "paragraphing", reason: "第 4 条，应被上限截掉" },
  ],
  TRAIN_EVIDENCE,
);
eq("非法 focus / 空 reason 丢弃、重复去重、超出上限截断", trained.length, 3);
eq("留下的是最先出现的 3 条", trained.map((t) => t.focus), ["tense", "spelling", "cohesion"]);
eq("去重保留的是第一条", trained[0].reason, "全文 6 处时态来回跳");

// 模型没给关联证据 → 按 focus 对应的维度自动挂（照抄 parseUpgradePlan 的做法）
check("language 类自动挂上 language 的证据", trained[0].linkedEvidenceIds.includes("e1"), trained[0]);
check("language 类不会挂上 organization 的证据", !trained[0].linkedEvidenceIds.includes("e3"), trained[0]);
check("cohesion 挂的是 organization 的证据", trained[2].linkedEvidenceIds.includes("e3"), trained[2]);

// 模型给了就用模型的，但不存在的 id 一律剔除——否则卡片上会出现点了没反应的死链
const explicitLinked = __internals.parseTrainingPlan(
  [{ focus: "tense", reason: "r", linkedEvidenceIds: ["e2", "e999", 42] }],
  TRAIN_EVIDENCE,
);
eq("只保留真实存在的证据 id", explicitLinked[0].linkedEvidenceIds, ["e2"]);

// 整节消失是**正常降级**，不是故障：不显示空壳，也不报 warning
eq("全非法 → 空数组", __internals.parseTrainingPlan([{ focus: "grammar", reason: "r" }], TRAIN_EVIDENCE), []);
eq("不是数组 → 空数组", __internals.parseTrainingPlan("nope", TRAIN_EVIDENCE), []);
eq("undefined → 空数组", __internals.parseTrainingPlan(undefined, TRAIN_EVIDENCE), []);
eq("空数组 → 空数组", __internals.parseTrainingPlan([], TRAIN_EVIDENCE), []);

// --- coerceExample：把"敷衍的示范"挡在门外 -----------------------------------
eq(
  "正常示范原样通过",
  coerceExample({ before: "he go", after: "he goes" }),
  { before: "he go", after: "he goes" },
);
eq(
  "两端空白被清掉",
  coerceExample({ before: "  he go  ", after: "  he goes  " }),
  { before: "he go", after: "he goes" },
);
// before === after 是最容易漏过去的一种敷衍：字段齐全、格式合法、报告上看起来
// 和正常示范一模一样，但学生照着看什么也学不到。必须当成"没给"处理。
eq("before 与 after 相同 → 无效", coerceExample({ before: "he go", after: "he go" }), undefined);
eq("缺 after → 无效", coerceExample({ before: "he go" }), undefined);
eq("缺 before → 无效", coerceExample({ after: "he goes" }), undefined);
eq("全是空白 → 无效", coerceExample({ before: "   ", after: "  " }), undefined);
eq("非字符串 → 无效", coerceExample({ before: 1, after: 2 }), undefined);
eq("null → 无效", coerceExample(null), undefined);
eq("字符串 → 无效", coerceExample("he go"), undefined);
eq("数组 → 无效", coerceExample([]), undefined);
// 长度护栏放在这里而不是 locateExampleQuote：这是纯函数，能被断言。
// 模型偶尔会把整段贴进 before，而模糊定位是平方量级。
eq(
  "before 超过 MAX_QUOTE_CHARS → 无效",
  coerceExample({ before: "x".repeat(MAX_QUOTE_CHARS + 1), after: "y" }),
  undefined,
);
check(
  "刚好等于 MAX_QUOTE_CHARS 仍然有效",
  coerceExample({ before: "x".repeat(MAX_QUOTE_CHARS), after: "y" }) !== undefined,
);

// --- locateExampleQuote：本轮最关键的判定 ------------------------------------
//
// ⚠️ 判定必须是 exact | normalized，**不能退到 fuzzy**。locateQuote 会一路退到
// fuzzyLocate，它的阈值是词重叠 ≥80%——对短句来说 3 个词里中 3 个就算命中，
// 于是模型编的 "I very like"（原文是 "I like very much"）会被判成"已验证"，
// 正好是这个功能要抓的那种编造。下面两条断言就是防止有人日后把它改回
// `method !== "none"` 的护栏——**删掉它们之前先想清楚代价**。
const EX_ESSAY = "I like very much the sports which are played in the playground.";
check("逐字命中 → 通过", locateExampleQuote(EX_ESSAY, "which are played"));
check("仅大小写差异 → 通过", locateExampleQuote(EX_ESSAY, "Which Are Played"));
check("仅空白差异 → 通过", locateExampleQuote(EX_ESSAY, "which  are   played"));
check("原文里没有 → 不通过", !locateExampleQuote(EX_ESSAY, "completely absent phrase"));
check("空 before → 不通过", !locateExampleQuote(EX_ESSAY, ""));
check("空原文 → 不通过", !locateExampleQuote("", "which are played"));
check(
  "⚠️ 词重叠 ≥80% 但不是原文（编造的示范）→ 不通过",
  !locateExampleQuote(EX_ESSAY, "I very like"),
);
check(
  "⚠️ 只有零散词重合 → 不通过",
  !locateExampleQuote(EX_ESSAY, "playground playing plays"),
);

// ---------------------------------------------------------------------------
console.log("\n[6] 高亮切分");

const HL_ESSAY = "AAA BBB CCC";
const segs = segmentEssay(HL_ESSAY, [
  { id: "e1", dimension: "language", kind: "minor", quote: "BBB", comment: "", start: 4, end: 7, verified: true, locateMethod: "exact" },
]);
eq("切分为 3 段", segs.length, 3);
eq("高亮段类型", segs[1].kind, "minor");
eq("拼接复原原文", segs.map((s) => s.text).join(""), HL_ESSAY);

// 重叠区间应合并为一个块
const merged = segmentEssay(HL_ESSAY, [
  { id: "e1", dimension: "language", kind: "minor", quote: "AAA BB", comment: "", start: 0, end: 6, verified: true, locateMethod: "exact" },
  { id: "e2", dimension: "language", kind: "major", quote: "BBB", comment: "", start: 4, end: 7, verified: true, locateMethod: "exact" },
]);
eq("重叠区间合并为 2 段", merged.length, 2);
eq("合并后取更严重的 kind", merged[0].kind, "major");
eq("合并后带上两条 id", merged[0].ids, ["e1", "e2"]);
eq("合并后仍能复原原文", merged.map((s) => s.text).join(""), HL_ESSAY);

// 越界区间应被丢弃而不是造成错位
const oob = segmentEssay(HL_ESSAY, [
  { id: "e1", dimension: "language", kind: "minor", quote: "x", comment: "", start: 50, end: 90, verified: true, locateMethod: "exact" },
]);
eq("越界区间被丢弃", oob.length, 1);
eq("越界时不产生高亮", oob[0].kind, null);

// --- 证据卡片 ←→ 原文高亮的锚点映射 -----------------------------------------
//
// 这一组盯的是一个很安静的错误：重叠的证据会被合并进**同一个** <mark>，
// 而一个元素只能有一个 id（用合并块里的第一条证据）。第二条证据的卡片要是
// 自己拼 `anchor-${自己}`，就会指向一个不存在的元素——点下去毫无反应，也不报错。
console.log("\n[6b] 锚点映射");

const OVERLAP_ESSAY = "AAA BBB CCC DDD EEE";
const OVERLAP_EVIDENCE: Evidence[] = [
  { id: "e1", dimension: "language", kind: "minor", quote: "AAA BB", comment: "", start: 0, end: 6, verified: true, locateMethod: "exact" },
  { id: "e2", dimension: "language", kind: "major", quote: "BBB", comment: "", start: 4, end: 7, verified: true, locateMethod: "exact" },
  { id: "e3", dimension: "content", kind: "strength", quote: "DDD", comment: "", start: 12, end: 15, verified: true, locateMethod: "exact" },
  { id: "e4", dimension: "language", kind: "minor", quote: "找不到的引文", comment: "", start: null, end: null, verified: false, locateMethod: "none" },
  { id: "e5", dimension: "language", kind: "minor", quote: "越界", comment: "", start: 80, end: 99, verified: true, locateMethod: "exact" },
];
const anchors = anchorMap(OVERLAP_ESSAY, OVERLAP_EVIDENCE);

eq("块首证据指向自己", anchors.get("e1"), "anchor-e1");
// ★ 这条是整个功能的立足点：重叠的第二条必须被引到块首
eq("重叠的第二条证据被引到块首", anchors.get("e2"), "anchor-e1");
eq("不重叠的证据指向自己", anchors.get("e3"), "anchor-e3");
check("没定位到的证据不在表里", !anchors.has("e4"));
// 越界的证据不会被画出高亮（见上面那条断言），所以也不该有锚点可跳——
// 否则卡片上的链接会指向一个不存在的 id
check("越界的证据不在表里", !anchors.has("e5"));

// 映射必须和真正渲染出来的 <mark> 对得上：表里每个值都得是个真实存在的锚点。
// 这一条是防"以后有人改了一处忘了另一处"的兜底
const renderedAnchors = new Set(
  segmentEssay(OVERLAP_ESSAY, OVERLAP_EVIDENCE)
    .filter((s) => s.kind && s.ids.length > 0)
    .map((s) => `${ANCHOR_PREFIX}${s.ids[0]}`),
);
const dangling = [...anchors.values()].filter((a) => !renderedAnchors.has(a));
eq("映射里没有指向不存在元素的死链", dangling, []);
check("每条被映射的证据都真的画出了高亮", anchors.size === 3);

// 没有证据时不该凭空造出锚点
eq("无证据时映射为空", anchorMap(HL_ESSAY, []).size, 0);
// 原文为空时也不该炸
eq("空原文 + 空证据仍为空映射", anchorMap("", []).size, 0);

// ---------------------------------------------------------------------------
console.log("\n[7] HTML 转义（XSS）");

const XSS = `<script>alert('xss')</script> & "quotes"`;
check("尖括号被转义", escapeHtml(XSS).includes("&lt;script&gt;"), escapeHtml(XSS));
check("不残留未转义的 script 标签", !escapeHtml(XSS).includes("<script>"));

const evilEssay = `Hello <script>alert(1)</script> world. This is a longer essay for testing.`;
const evilHtml = renderHighlightedEssay(evilEssay, []);
check("渲染原文时不产生 script 标签", !evilHtml.includes("<script>"), evilHtml);

// 带高亮时也不应破坏转义
const evilHighlighted = renderHighlightedEssay(evilEssay, [
  {
    id: "e1", dimension: "language", kind: "major",
    quote: "<script>alert(1)</script>", comment: "",
    start: 6, end: 36, verified: true, locateMethod: "exact",
  },
]);
check("带高亮时仍不产生 script 标签", !evilHighlighted.includes("<script>"), evilHighlighted);
check("带高亮时保留 mark", evilHighlighted.includes("<mark"), evilHighlighted);

// ---------------------------------------------------------------------------
console.log("\n[8] 完整报告生成");

const mockResult: ReviewResult = {
  essay: "I am a student want to join your volunteer program. " + XSS,
  band: bandForScore(8),
  score15: 8,
  score106: toScore106(8),
  dimensionScores: [
    { dimension: "content", score: 4, comment: "基本切题" },
    { dimension: "language", score: 2, comment: "错误较多" },
    { dimension: "organization", score: 3, comment: "勉强连贯" },
  ],
  summary: "总评文本",
  strengths: ["有一点做得不错"],
  evidence: [
    {
      id: "e1", dimension: "language", kind: "major",
      quote: "a student want to join", comment: "主谓不一致",
      suggestion: "改成 who wants to join",
      start: 5, end: 26, verified: true, locateMethod: "exact",
    },
    {
      id: "e2", dimension: "language", kind: "minor",
      quote: "这段引文根本不在原文里",
      comment: "未能定位的证据",
      start: null, end: null, verified: false, locateMethod: "none",
    },
  ],
  upgradePlan: [
    {
      priority: 1, dimension: "language",
      action: "先解决主谓一致",
      rationale: "这是升到 11 分档的必要条件",
      example: { before: "a student want", after: "a student wants" },
      linkedEvidenceIds: ["e1"],
    },
    {
      priority: 2, dimension: "language",
      action: "把时态统一成一般现在时",
      rationale: "时态来回跳属于严重错误",
      exampleUnverified: true,
      example: { before: "这句原文里根本没有", after: "改后的版本" },
      linkedEvidenceIds: [],
    },
    {
      priority: 3, dimension: "organization",
      action: "把第 2 段之后另起一段",
      rationale: "全文只有一段，结构分上不去",
      exampleMissing: true,
      linkedEvidenceIds: [],
    },
  ],
  // 训练区。reason 里塞一段 <script>——`[8]` 那几条"零 JS"断言原先只被 essay
  // 覆盖，加上这一条之后，练法卡片的转义路径也被同一批断言看着了。
  trainingPlan: [
    { focus: "agreement", reason: "全文 4 处第三人称单数漏 s", linkedEvidenceIds: ["e1"] },
    { focus: "paragraphing", reason: '整篇挤成一段<script>alert("train")</script>', linkedEvidenceIds: [] },
  ],
  stats: {
    wordCount: 20, sentenceCount: 2, paragraphCount: 1,
    evidenceCount: 2, verifiedCount: 1,
  },
  warnings: ["有 1 条引用没能在原文中定位"],
  meta: {
    model: "deepseek-chat", elapsedMs: 12345,
    createdAt: new Date().toISOString(),
    topic: "题目", rubricVersion: "test",
  },
};

const html = buildReportHtml(mockResult);
check("报告是完整 HTML 文档", html.startsWith("<!DOCTYPE html>"));
check("报告不包含未转义的注入脚本", !html.includes("<script>alert"), html.slice(0, 200));
check("报告包含档次标签", html.includes("8 分档"), null);
check("报告包含折算分", html.includes(String(mockResult.score106)));
check("报告标出了未定位的证据", html.includes(METHOD_LABEL.none), METHOD_LABEL.none);
check("报告与网页用的是同一份标签文案", METHOD_LABEL.none === "未能在原文中定位");
check("报告包含改写示范", html.includes("a student wants"));
check("报告包含证据锚点", html.includes('id="card-e1"'));
check("报告样式内联、不引用外部资源", !html.includes("<link") && !html.includes("http://"));

// --- 报告必须是"零 JS"的 ----------------------------------------------------
//
// 这份 HTML 会被双击打开、发给老师、打印成 PDF，还可能落在禁用脚本的环境里
// （邮件客户端预览、某些 PDF 阅读器）。所以**双向跳转只能靠朴素锚点 + CSS :target**，
// 一旦有人为了省事加一行内联 onclick，整条交互就会在那些环境里静默失效。
// 以前这块一条测试都没有，改 U4 的时候很容易手滑。
check("报告不含 script 标签", !html.includes("<script"), html.slice(0, 200));
check("报告不含内联事件处理器", !/\son[a-z]+\s*=/i.test(html));
check("报告不引用 https 外部资源", !html.includes("https://"));
check("报告不含 iframe / object / embed", !/<(iframe|object|embed)\b/i.test(html));

// 两个方向都得有链接，而且必须指向真实存在的 id
check("高亮块指回证据卡片", html.includes('href="#card-e1"'));
check("证据卡片的坐标指回原文高亮", html.includes('href="#anchor-e1"'));
check(
  "两个方向的锚点 id 都真实存在",
  html.includes('id="anchor-e1"') && html.includes('id="card-e1"'),
);

// 未定位的证据**不能**有指回原文的链接——那是个点了没反应的死链。
// e2 的坐标是 null，所以它的卡片里只能有那个标红的"未能在原文中定位"
check(
  "未定位的证据不做成链接",
  html.includes(`id="card-e2"`) && !html.includes('href="#anchor-e2"'),
);

// --- 训练区 ----------------------------------------------------------------
check("报告里有训练区标题", html.includes("<h2>训练区</h2>"));
// 用 chip 的完整标记来断言，不用裸标签文本：证据的 comment 里也有"主谓不一致"，
// 裸文本断言会被它蒙混过关
check("训练项用的是标签表里的文案", html.includes('class="chip chip-solid">主谓一致<'));
check("第二类训练项也在（没被吞掉）", html.includes('class="chip chip-solid">分段<'));
// 通用练法与"针对本篇的诊断"必须能区分，否则学生会把通用建议当成对自己的判断
check("通用练法带上了「不是针对你这一篇」的说明", html.includes("不是针对你这一篇写的"));
check("练法列出了「写作时怎么做」", html.includes("写作时怎么做"));
check("练法列出了「平时怎么练」", html.includes("平时怎么练"));
check("每类练法都带 watchOut", html.includes("<strong>当心：</strong>"));
check("训练项链到了真实证据锚点", html.includes('id="card-e1"'));

// 两类"示范有问题"的提示必须都渲染出来——它们是这个功能的可见面，
// 只在数据里打标记而在报告上不显示，等于没做
check("标出了没能定位的示范", html.includes("模型可能自己造了句子"));
check("没给示范的那条说明了原因", html.includes("条没有改写示范"));

// 导出 PDF 时卡片被切到两页上很难看。report-html.ts **自带一份** @media print，
// 和 app/globals.css 里那份是两处，漏改一边就是这个下场。
check(
  "导出 CSS 的打印白名单里也加了 .train-card",
  /@media print[\s\S]*?train-card/.test(html),
);

// 老报告（升级前存下的）根本没有这个键。lib/store.ts 是盲 as ReviewResult，
// 这里 delete 掉模拟的正是那种数据——守卫写漏了会整页崩，不是少显示一节。
const noTraining = { ...mockResult };
delete noTraining.trainingPlan;
const htmlNoTraining = buildReportHtml(noTraining);
check("没有训练数据时不渲染训练区", !htmlNoTraining.includes("<h2>训练区</h2>"));
// 断言的是**元素标记**而不是裸类名：REPORT_CSS 里永远有 `.train-card`
// 这条规则（样式是静态的），拿裸类名做断言会恒为假
check("没有训练数据时不留空壳", !htmlNoTraining.includes('class="card train-card"'));
const htmlEmptyTraining = buildReportHtml({ ...mockResult, trainingPlan: [] });
check("训练项为空数组时同样整节消失", !htmlEmptyTraining.includes("<h2>训练区</h2>"));

// ---------------------------------------------------------------------------
console.log("\n[9] 访问口令");

{
  const originalCode = process.env.REVIEW_ACCESS_CODE;
  const setCode = (v: string | undefined) => {
    if (v === undefined) delete process.env.REVIEW_ACCESS_CODE;
    else process.env.REVIEW_ACCESS_CODE = v;
  };

  // 没配置时拒绝一切请求，这是刻意的安全默认（宁可坏得明显，也不要静默裸奔）
  setCode(undefined);
  eq("未配置口令 → MISSING_CONFIG", verifyAccessCode("whatever"), {
    ok: false,
    reason: "MISSING_CONFIG",
  });
  check("未配置口令 → hasAccessCode() 为假", !hasAccessCode());

  // 占位值必须等同于没配，否则口令形同虚设
  setCode("change-me-please");
  eq("占位口令 → MISSING_CONFIG", verifyAccessCode("change-me-please"), {
    ok: false,
    reason: "MISSING_CONFIG",
  });

  setCode("correct-horse-battery-staple");
  check("已配置口令 → hasAccessCode() 为真", hasAccessCode());
  eq("正确口令通过", verifyAccessCode("correct-horse-battery-staple"), { ok: true });
  eq("错误口令被拒", verifyAccessCode("wrong"), { ok: false, reason: "INVALID" });
  eq("空字符串被拒", verifyAccessCode(""), { ok: false, reason: "INVALID" });
  eq("大小写不同被拒", verifyAccessCode("Correct-Horse-Battery-Staple"), {
    ok: false,
    reason: "INVALID",
  });
  eq("带尾随空格被拒", verifyAccessCode("correct-horse-battery-staple "), {
    ok: false,
    reason: "INVALID",
  });

  // 非字符串入参不能被 String() 之类的隐式转换放行
  eq("undefined 被拒", verifyAccessCode(undefined), { ok: false, reason: "INVALID" });
  eq("null 被拒", verifyAccessCode(null), { ok: false, reason: "INVALID" });
  eq("数字被拒", verifyAccessCode(123), { ok: false, reason: "INVALID" });
  eq("对象被拒", verifyAccessCode({}), { ok: false, reason: "INVALID" });
  eq("数组被拒", verifyAccessCode(["correct-horse-battery-staple"]), {
    ok: false,
    reason: "INVALID",
  });

  // 配置值自身的首尾空白要裁掉：从 Vercel 界面粘贴时很容易多带一个换行，
  // 那种情况下站点会莫名其妙地拒绝所有正确口令，很难排查
  setCode("  padded-code  ");
  check("配置值的首尾空白被裁剪", getAccessCode() === "padded-code", getAccessCode());
  eq("裁剪后能匹配", verifyAccessCode("padded-code"), { ok: true });

  setCode(originalCode);
}

// ---------------------------------------------------------------------------
console.log("\n[9b] 作文草稿的收拢与判定");

{
  const EMPTY = { essay: "", topic: "", targetBandLevel: "" };

  // 入参是 JSON.parse 的结果，所以必须经得住任何东西——包括根本不是对象的
  eq("null → 空草稿", coerceDraft(null), EMPTY);
  eq("undefined → 空草稿", coerceDraft(undefined), EMPTY);
  eq("字符串 → 空草稿", coerceDraft("a whole essay"), EMPTY);
  eq("数字 → 空草稿", coerceDraft(42), EMPTY);
  eq("布尔 → 空草稿", coerceDraft(true), EMPTY);
  // 数组也是 object，但绝不能被当成草稿去取 essay 字段
  eq("数组 → 空草稿", coerceDraft([1, 2, 3]), EMPTY);

  // 缺字段要补空，而不是整体丢弃：宁可恢复出一篇缺题的作文，也不能把正文弄丢
  eq("只有 essay → 其余补空", coerceDraft({ essay: "hello" }), {
    essay: "hello",
    topic: "",
    targetBandLevel: "",
  });
  // 类型不对的字段单独降级，不连累其他字段
  eq("字段类型不对 → 该字段降级，其余保留", coerceDraft({
    essay: "hello",
    topic: 123,
    targetBandLevel: null,
  }), { essay: "hello", topic: "", targetBandLevel: "" });
  // targetBandLevel 在表单里是 select 的字符串值。旧版本若存成数字，
  // 直接塞回受控 select 会让 React 抱怨 value 不在选项里，所以这里必须归成字符串
  eq("数字形式的档位不算数", coerceDraft({ essay: "hi", targetBandLevel: 3 }), {
    essay: "hi",
    topic: "",
    targetBandLevel: "",
  });

  // 正常值要原样带过来，一个字符都不能动（作文里的换行、标点都得留着）
  const full = { essay: "line1\nline2  ", topic: "My view on...", targetBandLevel: "6" };
  eq("完整草稿原样保留", coerceDraft(full), full);

  // 空判定
  check("三个空字符串 → 空", isDraftEmpty(EMPTY));
  check("纯空白 → 空", isDraftEmpty({ essay: "  \n\t ", topic: "", targetBandLevel: " " }));
  check("只有正文 → 非空", !isDraftEmpty({ essay: "a", topic: "", targetBandLevel: "" }));
  // 只写了题目也值得留：学生往往是先想好题目再动手
  check("只有题目 → 非空", !isDraftEmpty({ essay: "", topic: "t", targetBandLevel: "" }));
  check("只有档位 → 非空", !isDraftEmpty({ essay: "", topic: "", targetBandLevel: "6" }));

  // 收拢之后判空：坏数据要一路走到「没有草稿」，而不是恢复出一个空壳
  check("坏数据收拢后为空", isDraftEmpty(coerceDraft({ nope: 1 })));

  // SSR / Node 下没有 localStorage。这几个函数必须安静地退化成空操作，
  // 因为 lib/store.ts 是被客户端组件导入的，构建时会在服务端执行到它们
  check("Node 下 loadDraft() 返回 null 而不是抛异常", loadDraft() === null);
  let threw = false;
  try {
    saveDraft({ essay: "x", topic: "", targetBandLevel: "" });
  } catch {
    threw = true;
  }
  check("Node 下 saveDraft() 静默无操作", !threw);
}

// ---------------------------------------------------------------------------
console.log("\n[9c] 报告的新鲜度");

{
  // 固定一个「现在」，避免断言依赖真实时钟
  const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  check("刚生成的算新鲜", isResultFresh(ago(0), NOW));
  check("一小时前算新鲜", isResultFresh(ago(60 * 60 * 1000), NOW));
  check(
    "差一点到 24 小时仍算新鲜",
    isResultFresh(ago(RESULT_FRESH_MS - 1000), NOW),
  );
  // 边界取"严格小于"：正好 24 小时算旧的。差一毫秒的事，方向取安全的那边
  check("正好 24 小时算旧", !isResultFresh(ago(RESULT_FRESH_MS), NOW));
  check("25 小时前算旧", !isResultFresh(ago(25 * 60 * 60 * 1000), NOW));
  check("一个月前算旧", !isResultFresh(ago(30 * 24 * 60 * 60 * 1000), NOW));

  // 解析不出来的值一律当旧的。这个方向的失败只是多显示一句生成时间，
  // 反过来会让一份放了半年的报告装成刚出炉的——所以这里必须偏保守
  check("空字符串算旧", !isResultFresh("", NOW));
  check("乱码算旧", !isResultFresh("not a date", NOW));
  check("null 字符串算旧", !isResultFresh("null", NOW));
  // 注意 Date.parse("1700000000000") 是 NaN（纯数字当不了日期），别指望它能通过
  check("裸数字字符串算旧", !isResultFresh(String(NOW), NOW));

  // 时钟偏了（客户端时间比服务端生成的时刻早）不该被误判成旧报告
  check("时间戳在未来算新鲜", isResultFresh(ago(-60 * 1000), NOW));
}

// ---------------------------------------------------------------------------
console.log("\n[9d] 客户端读超时");

{
  // 分段的依据是「收到过第一个字节没有」，不是什么别的东西
  eq("收到过字节 → streaming", readPhase(true), "streaming");
  eq("没收到 → waiting-first-frame", readPhase(false), "waiting-first-frame");

  // ⚠️ 下面两条在和**服务端**的超时赛跑，数字是硬约定：
  //    · 首帧阈值必须大于 REVIEW_TIMEOUT_MS 的默认值（100 秒）——这一段没有存活
  //      信号可用，只能等服务端自己的总预算走完，抢在它前面判死就是误杀
  //    · 停滞阈值必须大于 REVIEW_STALL_MS 的默认值（30 秒）——否则服务端那条
  //      具体的「上游停滞」报错会被我们这句笼统的「连接中断」盖掉
  // 改 lib/deepseek.ts 里那两个默认值的时候，这里会红，跟着一起改
  check(
    "首帧阈值留出了服务端总预算（100 秒）",
    deadlineFor("waiting-first-frame") > 100_000,
    deadlineFor("waiting-first-frame"),
  );
  check(
    "停滞阈值留出了服务端的停滞超时（30 秒）",
    deadlineFor("streaming") > 30_000,
    deadlineFor("streaming"),
  );
  check(
    "首帧阈值更宽松（那一段沉默是正常的）",
    FIRST_FRAME_DEADLINE_MS > STREAM_STALL_DEADLINE_MS,
  );
  check("两个阈值都是有限正数", Number.isFinite(deadlineFor("streaming")) && STREAM_STALL_DEADLINE_MS > 0);

  // 提示的"不哭狼"边界。这条最容易在改动里被手滑破坏
  check("沉默 0 秒不提示", silenceHint("streaming", 0) === null);
  check(
    `沉默 ${SILENCE_HINT_SECONDS - 1} 秒仍不提示`,
    silenceHint("streaming", SILENCE_HINT_SECONDS - 1) === null,
  );
  // 阈值一到就得说。这里用"大于等于"而不是"大于"，卡在整秒上的判断更符合直觉
  eq("沉默到阈值就提示", silenceHint("streaming", SILENCE_HINT_SECONDS), {
    phase: "streaming",
    seconds: SILENCE_HINT_SECONDS,
  });
  // 首帧之前也要提示——这正是 U2 修的硬伤：门槛挂错在 chars > 0 上，
  // 断在首帧之前时一句话都不说
  eq("首帧之前同样会提示", silenceHint("waiting-first-frame", 45), {
    phase: "waiting-first-frame",
    seconds: 45,
  });
  // 算不出来的时候宁可不说，也不能显示 "NaN 秒"
  check("NaN 秒不提示", silenceHint("streaming", Number.NaN) === null);
  check("Infinity 秒不提示", silenceHint("streaming", Number.POSITIVE_INFINITY) === null);
  check("负秒数不提示", silenceHint("streaming", -5) === null);
  eq("秒数向下取整", silenceHint("streaming", 45.87)?.seconds, 45);

  // 两段的文案必须不一样：原因不同，用户能做的事也不同
  const waitMsg = deadlineMessage("waiting-first-frame");
  const streamMsg = deadlineMessage("streaming");
  check("两段的超时文案不同", waitMsg !== streamMsg);
  check("首帧超时文案带上阈值秒数", waitMsg.includes(String(FIRST_FRAME_DEADLINE_MS / 1000)));
  check("停滞超时文案带上阈值秒数", streamMsg.includes(String(STREAM_STALL_DEADLINE_MS / 1000)));
  // 首帧那条要提到"重试"，因为上游排队重试一次通常就好
  check("首帧超时文案提示重试", waitMsg.includes("重试"));

  // 错误代号：中途断连是链路问题，不能和服务端的 TIMEOUT 混为一谈
  eq("首帧超时用 TIMEOUT（原因在服务端/上游）", deadlineCode("waiting-first-frame"), "TIMEOUT");
  eq("中途断连用 CONNECTION_LOST", deadlineCode("streaming"), "CONNECTION_LOST");
}

// ---------------------------------------------------------------------------
// [10] 和 [12]/[13] 一样是异步的，统一放到文件末尾的异步链里按顺序跑，
// 免得它们的结果插在同步分组中间（编译目标是 commonjs，不能用顶层 await）
async function runBodyLimitTests() {
  console.log("\n[10] 请求体大小上限");

  const url = "http://localhost/api/review";

  /** 造一个请求。contentLength 传 null 表示刻意不带这个头 */
  function jsonRequest(body: string, contentLength?: string | null): Request {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (contentLength !== null) {
      headers.set("Content-Length", contentLength ?? String(body.length));
    }
    return new Request(url, { method: "POST", headers, body });
  }

  const small = JSON.stringify({ essay: "hello world" });
  const parsed = await readJsonBody(jsonRequest(small));
  eq("正常体积：解析成功", parsed.ok, true);
  eq("正常体积：内容正确", parsed.ok && (parsed.value as { essay: string }).essay, "hello world");

  // 超限 + 带 Content-Length：走快路径拒绝
  const huge = "a".repeat(MAX_BODY_BYTES + 1);
  const withHeader = await readJsonBody(jsonRequest(huge));
  eq("超限（带 Content-Length）：被拒", withHeader, { ok: false, reason: "TOO_LARGE" });

  // 超限 + 不带 Content-Length：这一条才是关键。
  // 只信 Content-Length 的实现会在这里放行，然后老老实实把整个 body 读完
  const noHeader = await readJsonBody(jsonRequest(huge, null));
  eq("超限（无 Content-Length）：仍然被拒", noHeader, { ok: false, reason: "TOO_LARGE" });

  // 谎报一个小 Content-Length 也必须拦得住
  const lying = await readJsonBody(jsonRequest(huge, "10"));
  eq("谎报 Content-Length：仍然被拒", lying, { ok: false, reason: "TOO_LARGE" });

  // 恰好在边界上应当放行（上限本身是允许的，超一个字节才拒）
  const atLimit = JSON.stringify({ e: "a".repeat(MAX_BODY_BYTES - 20) });
  check(
    `恰好不超过 ${MAX_BODY_BYTES} 字节：放行`,
    (await readJsonBody(jsonRequest(atLimit))).ok,
    atLimit.length,
  );

  eq("非法 JSON：被拒", await readJsonBody(jsonRequest("not json at all")), {
    ok: false,
    reason: "INVALID_JSON",
  });
  eq("空 body：被拒", await readJsonBody(jsonRequest("")), {
    ok: false,
    reason: "INVALID_JSON",
  });

  // 流式读取要能跨分块边界正确解码多字节字符（用 byteLength 分块，
  // 把"你"劈成两半，验证没被解码成乱码）
  const bytes = new TextEncoder().encode(JSON.stringify({ essay: "你好世界".repeat(20) }));
  const half = Math.floor(bytes.length / 2);
  const split = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, half));
      c.enqueue(bytes.slice(half));
      c.close();
    },
  });
  const streamed = await readJsonBody(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: split,
      duplex: "half",
    } as RequestInit),
  );
  eq(
    "多字节字符被劈成两个分块时解码正确",
    streamed.ok && (streamed.value as { essay: string }).essay,
    "你好世界".repeat(20),
  );

  // 流式分块的超限体也要拦得住（这个连 Content-Length 都没有）
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("a".repeat(4096)));
      c.close();
    },
  });
  eq(
    "分块传输的超限体被拒",
    await readJsonBody(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chunked,
        duplex: "half",
      } as RequestInit),
    ),
    { ok: false, reason: "TOO_LARGE" },
  );
}

// ---------------------------------------------------------------------------
async function runRateLimitTests(): Promise<void> {
  console.log("\n[11] 限流与口令锁定");

  // 冻结的时间轴，避免测试受真实时钟影响
  const T0 = 1_000_000;
  const policy: RateLimitPolicy = {
    reviewLimit: 3,
    reviewWindowSecs: 60,
    failDelayMs: 0,
  };

  // ---- 常量不变式 ---------------------------------------------------------
  // 这几条是"配置之间互相矛盾"那一整类问题的守门人。规则本身写在代码里、
  // 不做成环境变量，但常量之间仍然可以互相踩：改一个数就可能破坏另一个前提。

  check(
    "档位递增：10 次的锁必须比 7 次的锁长",
    FAIL_TIER2_COUNT > FAIL_TIER1_COUNT && FAIL_TIER2_LOCK_SECS > FAIL_TIER1_LOCK_SECS,
  );
  // 衰减窗口比封顶还短的话，攻击者等够衰减时间再失败一次，就能把一把活着的锁
  // 顺手清掉（isNewStreak 里的"锁定期内不衰减"挡的是另一条路，别指望它兜住这条）
  check(
    "衰减窗口比锁的总时长封顶长（否则锁会被自己过期掉）",
    FAIL_DECAY_SECS > LOCK_STREAK_CAP_SECS,
  );
  // 清理比封顶更早动到一行的话，会把一把活着的锁连行删掉：攻击者发现自己突然
  // 又能猜了，失败计数和封顶的起算点也一起归零
  check(
    "陈旧行保留期比锁的总时长封顶长（否则清理会删掉活着的锁）",
    SWEEP_RETENTION_WINDOWS * HOUR_SECS > LOCK_STREAK_CAP_SECS,
  );
  check("封顶比最高一档的锁长（否则封顶让锁永远夹不满）", LOCK_STREAK_CAP_SECS > FAIL_TIER2_LOCK_SECS);

  // ---- 档位选择 -----------------------------------------------------------
  const tiers: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [FAIL_TIER1_COUNT - 1, 0],
    [FAIL_TIER1_COUNT, FAIL_TIER1_LOCK_SECS],
    [FAIL_TIER1_COUNT + 1, FAIL_TIER1_LOCK_SECS],
    [FAIL_TIER2_COUNT - 1, FAIL_TIER1_LOCK_SECS],
    [FAIL_TIER2_COUNT, FAIL_TIER2_LOCK_SECS],
    [FAIL_TIER2_COUNT + 1, FAIL_TIER2_LOCK_SECS],
    [500, FAIL_TIER2_LOCK_SECS],
  ];
  for (const [failCount, expected] of tiers) {
    eq(`档位：第 ${failCount} 次失败锁 ${expected} 秒`, lockSecsFor(failCount), expected);
  }

  // ---- 连续失败的时间线 ---------------------------------------------------
  // 一次都不换时间：模拟"攻击者连着打"。锁的续期和封顶都在这一段里。
  let state: FailureState = clearedFailureState();
  for (let i = 1; i < FAIL_TIER1_COUNT; i++) {
    state = nextFailureState(state, T0);
  }
  check(
    `前 ${FAIL_TIER1_COUNT - 1} 次失败都不锁`,
    state.failCount === FAIL_TIER1_COUNT - 1 && state.lockedUntil === null,
    state,
  );

  state = nextFailureState(state, T0);
  eq("第 7 次失败：计数到 7", state.failCount, FAIL_TIER1_COUNT);
  eq("第 7 次失败：锁 60 秒", state.lockedUntil, T0 + FAIL_TIER1_LOCK_SECS * 1000);
  eq("第 7 次失败：记下这把锁的起算点", state.lockStartedAt, T0);

  state = nextFailureState(state, T0);
  state = nextFailureState(state, T0);
  eq("第 9 次失败：仍在 1 分钟档", state.lockedUntil, T0 + FAIL_TIER1_LOCK_SECS * 1000);

  state = nextFailureState(state, T0);
  eq("第 10 次失败：升到 5 分钟档", state.lockedUntil, T0 + FAIL_TIER2_LOCK_SECS * 1000);

  state = nextFailureState(state, T0);
  state = nextFailureState(state, T0);
  eq("第 12 次失败：仍是 5 分钟档（不回落到 1 分钟）", state.lockedUntil, T0 + FAIL_TIER2_LOCK_SECS * 1000);
  eq("起算点始终是第一次上锁那一刻（封顶才有意义）", state.lockStartedAt, T0);

  // ---- 衰减 ---------------------------------------------------------------
  const stale: FailureState = {
    failCount: 6,
    lastFailAt: T0,
    lockStartedAt: null,
    lockedUntil: null,
  };
  // 边界必须和 SQL 里的 `last_fail_at <= now() - interval` 逐字对齐，
  // 所以是 >= 而不是 >
  check("刚好过一个衰减窗口：算新的一串", isNewStreak(stale, T0 + FAIL_DECAY_SECS * 1000));
  check("差 1 毫秒：仍算旧的一串", !isNewStreak(stale, T0 + FAIL_DECAY_SECS * 1000 - 1));
  eq("衰减之后从头数（不是接着 7 往上走）", nextFailureState(stale, T0 + FAIL_DECAY_SECS * 1000).failCount, 1);

  // 下面这条守的是 isNewStreak 里的第二个条件："还锁着就不算衰减"。
  //
  // ⚠️ 先说清它的可达性，免得读的人以为这里在测一条真实路径。
  // 因为 FAIL_DECAY_SECS > LOCK_STREAK_CAP_SECS（上面有断言钉着），而锁的起算点
  // 永远不会晚于最后一次失败（两者都是"失败那一刻"设的），所以
  // `lockedUntil <= lockStartedAt + CAP <= lastFailAt + CAP < lastFailAt + DECAY`
  // ——"还锁着"和"已过衰减窗口"在当前常量下**不可能同时成立**，这条守卫够不着。
  //
  // 留着它是因为常量不是永远不变的：一旦有人把某一档的锁调到比衰减窗口还长，
  // 攻击者等够衰减时间再失败一次就能把活锁顺手清掉，而那时不会有别的测试拦下来。
  // 所以这里用一个**现实中构造不出来**的状态（锁的起算点晚于最后一次失败）
  // 把守卫本身钉住。删掉守卫这条就会红。
  const syntheticLock: FailureState = {
    failCount: 9,
    lastFailAt: T0,
    lockStartedAt: T0 + FAIL_DECAY_SECS * 1000,
    lockedUntil: T0 + FAIL_DECAY_SECS * 1000 + 60_000,
  };
  check(
    "还锁着的时候，衰减窗口过了也不算新的一串",
    !isNewStreak(syntheticLock, T0 + FAIL_DECAY_SECS * 1000),
  );

  // ---- 总时长封顶 ---------------------------------------------------------
  const capped: FailureState = {
    failCount: 11,
    lastFailAt: T0,
    lockStartedAt: T0,
    lockedUntil: T0 + 999_999,
  };
  const afterCap = nextFailureState(capped, T0 + LOCK_STREAK_CAP_SECS * 1000);
  eq("封顶用满：自动解锁并清零，重新给满次数", afterCap.failCount, 1);
  eq("封顶用满：不再是锁定状态", afterCap.lockedUntil, null);

  // LEAST() 那一半：剩下的封顶时间比这一档的锁还短时要夹短
  const nearCap: FailureState = {
    failCount: 9,
    lastFailAt: T0,
    lockStartedAt: T0 - (LOCK_STREAK_CAP_SECS * 1000 - 20_000),
    lockedUntil: null,
  };
  eq(
    "新锁被剩下的封顶时间夹短（20 秒，而不是整档 5 分钟）",
    nextFailureState(nearCap, T0).lockedUntil,
    T0 + 20_000,
  );

  check("isLocked 的边界：到期那一刻就不算锁着了", !isLocked({ ...clearedFailureState(), lockedUntil: T0 }, T0));

  // ---- 额度判定 -----------------------------------------------------------
  check("额度 100：第 100 次仍放行", !isOverLimit(100, 100));
  check("额度 100：第 101 次被拒", isOverLimit(100, 101));
  check("额度 0 表示不限（不能拧成一律拒绝）", !isOverLimit(0, 999_999));
  check("负额度也表示不限", !isOverLimit(-5, 999_999));

  // ---- SQL 文本 -----------------------------------------------------------
  // 这些性质**只存在于文本里**：内存假实现证明不了 CASE 分支、档位顺序、
  // 两个关注点有没有越界改对方的列。真正打到数据库的验证在 scripts/db/smoke.ts。

  const FAIL_KEY = "1.2.3.4";
  const failSql = buildFailureUpsert(FAIL_KEY);
  const failText = stripSqlComments(failSql.text);

  eq("失败语句：参数顺序与取值", failSql.params, [
    FAIL_KEY,
    FAIL_DECAY_SECS,
    FAIL_TIER2_COUNT,
    FAIL_TIER2_LOCK_SECS,
    FAIL_TIER1_COUNT,
    FAIL_TIER1_LOCK_SECS,
    LOCK_STREAK_CAP_SECS,
  ]);
  check("失败语句：是一条原子 upsert，不是读-改-写", /ON CONFLICT \(client_key\) DO UPDATE/.test(failText));
  check("失败语句：RETURNING 带回新计数和剩余锁时长", /RETURNING[\s\S]*fail_count/.test(failText) && /retry_after_secs/.test(failText));
  check("失败语句：返回的是秒数，不是 timestamptz（否则路由又要拿本地时钟去减）", /EXTRACT\(EPOCH/.test(failText) && !/timestamptz/.test(failText));
  // 调换这两个分支的顺序会让 >= 10 的计数落进 1 分钟档，而且是静默的。
  // 断言只在 locked_until 那个 CASE 里找位置：$5 在别处也该出现（起算点那一支
  // 用的就是它），拿整段文本的 indexOf 比大小会被那一处干扰。
  const lockedUntilBranch = failText.slice(
    failText.indexOf("locked_until = CASE"),
    failText.indexOf("ELSE r.locked_until"),
  );
  check(
    "失败语句：locked_until 里 5 分钟档的分支排在 1 分钟档之前（顺序是不变式）",
    lockedUntilBranch.includes("$3::int") &&
      lockedUntilBranch.includes("$5::int") &&
      lockedUntilBranch.indexOf("$3::int") < lockedUntilBranch.indexOf("$5::int"),
    lockedUntilBranch,
  );
  // 封顶的起算点必须在**第一次上锁**（第 7 次）时就记下。写成只有高档才记
  // （用 $3 = 10）的话，第 7~9 次失败期间它一直是 NULL，封顶被推迟到第 10 次
  // 才开始算——攻击者白拿几分钟。这个 bug 真的出现过一次，而且
  // RETURNING 里没有这一列，所以只有读原始行（db:smoke）或这条文本断言能发现它。
  const startedBranch = failText.slice(
    failText.indexOf("lock_started_at = CASE"),
    failText.indexOf("locked_until = CASE"),
  );
  check(
    "失败语句：封顶的起算点用低档阈值（$5 = 7），不是高档（$3 = 10）",
    startedBranch.length > 0 &&
      startedBranch.includes("$5::int") &&
      !startedBranch.includes("$3::int"),
    startedBranch,
  );

  // 关注点分离靠"SET 子句里没写那些列"实现，是易碎品
  check(
    "失败语句不触碰窗口列（两个关注点共用一个行锁但各管各的）",
    !/window_(count|start)\s*=/.test(failText),
  );
  check("失败语句里没有拼进调用方数据（全走占位符）", !failText.includes(FAIL_KEY));

  const okSql = buildSuccessAndCount(FAIL_KEY, policy.reviewWindowSecs);
  const okText = stripSqlComments(okSql.text);
  eq("成功语句：参数", okSql.params, [FAIL_KEY, policy.reviewWindowSecs]);
  check(
    "成功语句：把失败记录整个清零",
    /fail_count = 0/.test(okText) &&
      /last_fail_at = NULL/.test(okText) &&
      /lock_started_at = NULL/.test(okText) &&
      /locked_until = NULL/.test(okText),
    okText.slice(0, 200),
  );
  check("成功语句：同一条语句里自增窗口", /window_count = CASE WHEN/.test(okText));
  check(
    "成功语句：RETURNING 带回窗口计数（权威判定用它，不用前置 SELECT 的旧值）",
    /RETURNING[\s\S]*window_count/.test(okText) && /reset_after_secs/.test(okText),
  );
  check("成功语句里没有拼进调用方数据", !okText.includes(FAIL_KEY));

  // 窗口翻滚的条件在两个语句里必须是**同一份文本**——各抄一份取反形式的话，
  // 两边只在边界上分得开：窗口刚翻过去的那一瞬间，peek 会拿旧窗口的计数
  // 把新窗口的第一个请求误杀，而受害者只是"上一分钟刚好用满过"的那小部分人。
  const expiryExpr = /r\.window_start <= now\(\) - make_interval\(secs => \$2::double precision\)/g;
  const expiries = (text: string) => text.match(expiryExpr) ?? [];
  eq("成功语句：窗口过期的判定用了两次（count 和 start 各一次）", expiries(okText).length, 2);

  const peekSql = buildPeek(FAIL_KEY, policy.reviewWindowSecs);
  const peekText = stripSqlComments(peekSql.text);
  const peekExpiries = expiries(peekText);
  const okExpiries = expiries(okText);

  eq("早拒语句：窗口过期的判定用了两次", peekExpiries.length, 2);
  check(
    "早拒语句和成功语句用的是逐字相同的窗口过期表达式",
    peekExpiries.length > 0 && okExpiries.length > 0 && peekText.includes(okExpiries[0]!),
    { peek: peekExpiries[0], ok: okExpiries[0] },
  );

  eq("早拒语句：参数", peekSql.params, [FAIL_KEY, policy.reviewWindowSecs]);
  check("早拒语句：只读不写", /^\s*SELECT/.test(peekText) && !/UPDATE|INSERT|DELETE/.test(peekText));
  check("早拒语句：不碰失败计数（它只是建议性的，不负责计数）", !/fail_count/.test(peekText));
  check("早拒语句里没有拼进调用方数据", !peekText.includes(FAIL_KEY));

  const sweepSql = buildSweep(policy.reviewWindowSecs * SWEEP_RETENTION_WINDOWS);
  const sweepText = stripSqlComments(sweepSql.text);
  eq("清理语句：参数是保留秒数", sweepSql.params, [policy.reviewWindowSecs * SWEEP_RETENTION_WINDOWS]);
  check("清理语句：按 updated_at 删，且是 DELETE", /DELETE FROM rate_limits/.test(sweepText) && /updated_at </.test(sweepText));

  // ---- 内存 store ---------------------------------------------------------
  // ⚠️ 显式注入内存实现，绝不从环境变量"嗅探"用不用数据库。
  // 否则任何 shell 里配了 DATABASE_URL 的人跑 npm run selftest 都会开始打真实数据库。
  let clock = T0;
  const mem = createMemoryStore(policy, () => clock);

  const first = await mem.recordSuccess("a");
  eq("内存版：第 1 次请求计到 1", first.windowCount, 1);
  await mem.recordSuccess("a");
  const third = await mem.recordSuccess("a");
  eq("内存版：第 3 次请求计到 3（额度正好用满）", third.windowCount, 3);
  check(
    "内存版：额度 3 时计数 3 还没超（必须用 > 而不是 >=）",
    !isOverLimit(policy.reviewLimit, third.windowCount),
  );

  const fourth = await mem.recordSuccess("a");
  check("内存版：第 4 次超限", isOverLimit(policy.reviewLimit, fourth.windowCount));

  const peeked = await mem.peek("a");
  eq("内存版：peek 把早拒要的两个数都带回来", [peeked.lockRetryAfterMs, peeked.windowCount], [0, 4]);
  check("内存版：peek 给出窗口剩余时间", peeked.windowResetAfterMs === policy.reviewWindowSecs * 1000, peeked);

  check("内存版：不同 key 的额度互不影响", (await mem.peek("b")).windowCount === 0);

  clock = T0 + policy.reviewWindowSecs * 1000 + 1;
  eq("内存版：窗口过后续上，不是接着 4 往上走", (await mem.recordSuccess("a")).windowCount, 1);

  // peek 必须自己按窗口翻滚修正。报了旧窗口的计数，就会把新窗口的第一个请求误杀——
  // 而且只在"上一分钟刚好用满过"的人身上出现，最难复现的那类 bug
  clock = T0;
  const memWindow = createMemoryStore(policy, () => clock);
  await memWindow.recordSuccess("w");
  await memWindow.recordSuccess("w");
  eq("内存版：窗口过期前 peek 报 2", (await memWindow.peek("w")).windowCount, 2);
  clock = T0 + policy.reviewWindowSecs * 1000 + 1;
  eq(
    "内存版：窗口过期后 peek 报 0（不能拿旧窗口的计数误杀新窗口）",
    (await memWindow.peek("w")).windowCount,
    0,
  );
  eq("内存版：过期窗口的剩余时间报 0，不能是负数", (await memWindow.peek("w")).windowResetAfterMs, 0);

  // 失败不占额度，两道限制各管各的
  clock = T0;
  const mem2 = createMemoryStore(policy, () => clock);
  await mem2.recordSuccess("c");
  await mem2.recordSuccess("c");
  await mem2.recordFailure("c");
  await mem2.recordFailure("c");
  eq("内存版：失败**不**占用批改额度", (await mem2.peek("c")).windowCount, 2);
  eq("内存版：失败照常计数", (await mem2.recordFailure("c")).failCount, 3);

  // 口令正确要把失败记录整个清掉（包括那把锁）
  clock = T0;
  const mem3 = createMemoryStore(policy, () => clock);
  for (let i = 0; i < FAIL_TIER2_COUNT + 1; i++) await mem3.recordFailure("d");
  check("内存版：连错够次数就锁上", (await mem3.peek("d")).lockRetryAfterMs > 0);
  await mem3.recordSuccess("d");
  eq("内存版：口令正确后锁和失败计数一起清零", (await mem3.peek("d")).lockRetryAfterMs, 0);
  eq("内存版：清零之后再失败一次是从 1 开始数", (await mem3.recordFailure("d")).failCount, 1);

  // 清理必须只删陈旧行：删到活着的锁就等于把攻击者放出来（保留期大于封顶，
  // 那条不变式在上面钉着）。这里是它的行为侧。
  clock = T0;
  const mem4 = createMemoryStore(policy, () => clock);
  for (let i = 0; i < FAIL_TIER2_COUNT; i++) await mem4.recordFailure("e");
  // 走到一把锁还活着、同时在保留期内的时刻（第 10 次失败起锁 5 分钟）
  clock = T0 + 100_000;
  await mem4.sweep();
  eq("清理不会动到一把还活着的锁", await mem4.peek("e"), {
    lockRetryAfterMs: FAIL_TIER2_LOCK_SECS * 1000 - 100_000,
    windowCount: 0,
    windowResetAfterMs: 0,
  });

  // ⚠️ 这里**没有**"陈旧条目被删掉了"的断言，因为删没删在这个接口上不可观测：
  // 一个过期条目和一个不存在的条目给出的答案是同一套（锁早到期、窗口早翻滚）。
  // 那正是这个接口该有的性质——清理不允许改变任何行为。所以能测的只有上面那条
  // "不许删到活的"，以及"重复跑、空表跑都不抛错"（抛了的话这一行就过不去）。

  // ---- 持久化模式的探测 ---------------------------------------------------
  // ⚠️ 这一段必须排在下面「降级」之前。persistenceMode() 除了看环境变量，还看
  // "最近有没有报过数据库故障"，而下面那段会故意制造故障、把那个时间戳写脏。
  // 顺序颠过来的话，最后那条"真的连接串 → postgres 模式"会红，而原因跟
  // 连接串一点关系都没有。
  //
  // 占位串必须被当成"没配"：它非空、长得也像连接串，会被朴素的存在性检查放过——
  // 于是站点报"持久化已启用"，实际指向一个不存在的库，然后每个请求都静默降级。
  // 这是 lib/access.ts 里 change-me-please 那个坑的同一个形状。
  const savedUrl = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    eq("没配 DATABASE_URL → 内存模式", persistenceMode(), "memory");

    process.env.DATABASE_URL = "";
    eq("空值 → 内存模式", persistenceMode(), "memory");

    process.env.DATABASE_URL = "postgresql://user:password@host/db";
    eq(".env.local.example 里的占位串 → 内存模式（不能当成配了）", persistenceMode(), "memory");

    process.env.DATABASE_URL = "postgresql://neon:secret@ep-cool-1234.us-east-2.aws.neon.tech/neondb?sslmode=require";
    eq("真的连接串 → postgres 模式", persistenceMode(), "postgres");

    process.env.DATABASE_URL = "redis://localhost:6379";
    eq("不是 postgres 协议 → 内存模式", persistenceMode(), "memory");
  } finally {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }

  // ---- 降级 ---------------------------------------------------------------
  // 数据库挂了必须**放行**（不能让站点整个不可用），但放行的方式不是"零限制"，
  // 而是退回内存实现。下面断言的是后者：降级之后 fallback 里真的有计数。
  clock = T0;
  const fallback = createMemoryStore(policy, () => clock);
  let dbCalls = 0;
  const broken = {
    policy,
    async peek() {
      dbCalls++;
      throw new Error("模拟数据库不可用");
    },
    async recordFailure() {
      dbCalls++;
      throw new Error("模拟数据库不可用");
    },
    async recordSuccess() {
      dbCalls++;
      throw new Error("模拟数据库不可用");
    },
    async sweep() {
      dbCalls++;
      throw new Error("模拟数据库不可用");
    },
  };
  const degraded = withFallback(broken, fallback);

  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  let degradedOk: unknown;
  let degradedFail: unknown;
  try {
    degradedOk = await degraded.recordSuccess("f");
    degradedFail = await degraded.recordFailure("f");
    await degraded.peek("f");
    await degraded.sweep();
  } finally {
    console.error = originalError;
  }

  eq("降级：主实现被调用过", dbCalls, 4);
  eq("降级：走的是内存实现，计数照样在涨", degradedOk, { windowCount: 1, windowResetAfterMs: policy.reviewWindowSecs * 1000 });
  eq("降级：失败也在内存里记着（计数从 1 开始）", (degradedFail as { failCount: number }).failCount, 1);
  check("降级是**响的**：打了告警日志", logged.length > 0, logged);
  check(
    "告警文案点明了降级的后果（多实例下会漏）",
    logged.some((line) => line.includes("降级") && line.includes("漏")),
    logged,
  );

  // ---- fallback 的清理不能漏 ----------------------------------------------
  // withFallback.sweep() 原来只调 primary.sweep()，fallback 的 sweep **从来没被
  // 调用过**。后果不是"稍微脏一点"：降级期间写进内存 Map 的条目永远没人清，
  // DB 挂着时来一波伪造 IP 就一个假 IP 一条，只增不减 → OOM；而 DB 恢复之后更糟，
  // 那时 primary 每次都成功、catch 分支再也进不去，长驻进程（next start 自托管，
  // 不像 serverless 会随实例回收）里这些条目要留到进程重启。
  //
  // 用替身而不是拿真的内存 store 观察：Map 是闭包私有的，从外面只能间接推断，
  // 而"fallback.sweep 到底有没有被调到"本身就是要断言的那件事。
  let fallbackSweeps = 0;
  const spyFallback = {
    policy,
    peek: () => fallback.peek("spy"),
    recordFailure: async () => ({ failCount: 0, lockRetryAfterMs: 0 }),
    recordSuccess: async () => ({ windowCount: 0, windowResetAfterMs: 0 }),
    sweep: async () => {
      fallbackSweeps += 1;
    },
  };

  await withFallback(broken, spyFallback).sweep();
  eq("降级：primary.sweep() 抛异常时仍然扫了 fallback", fallbackSweeps, 1);

  // 反向同样要成立。只在 catch 里扫是不够的：降级期的残留条目要等 DB 恢复后才清，
  // 而那时恰恰进不去 catch——"失败时才扫"实际等于"永远不扫"。
  await withFallback({ ...broken, sweep: async () => undefined }, spyFallback).sweep();
  eq("降级：primary.sweep() 成功时同样扫 fallback", fallbackSweeps, 2);

  // 同一条告警不能刷屏：60 秒内的重复故障要折叠
  const before = logged.length;
  const originalError2 = console.error;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  try {
    await degraded.peek("f");
    await degraded.peek("f");
  } finally {
    console.error = originalError2;
  }
  eq("降级：60 秒内的重复故障被折叠，不再打日志", logged.length, before);

  // 日志可以折叠，但"现在正降级着"这件事不能——页面上的黄色提示就是靠它亮起来的。
  // 只判环境变量的话，"库挂了"只存在于没人看服务端日志的地方，而限流已经在漏了
  const savedUrlForDegrade = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgresql://neon:secret@ep-cool-1234.us-east-2.aws.neon.tech/neondb?sslmode=require";
    eq(
      "刚发生过故障时，persistence 报 memory（连接串配得好好的也没用）",
      persistenceMode(),
      "memory",
    );
  } finally {
    if (savedUrlForDegrade === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrlForDegrade;
  }

  // ---- 环境变量 -----------------------------------------------------------
  // ⚠️ 存/取/恢复。少了恢复这一段，后面所有 section 都会跑在被污染的环境里
  // （REVIEW_RATE_LIMIT_PER_HOUR 被留成 "42" 之类），而且症状是别的测试失败。
  const savedLimit = process.env.REVIEW_RATE_LIMIT_PER_HOUR;
  const savedDelay = process.env.ACCESS_CODE_FAIL_DELAY_MS;
  try {
    process.env.REVIEW_RATE_LIMIT_PER_HOUR = "not-a-number";
    eq("非法环境变量回落默认值", configFromEnv().reviewLimit, 100);
    process.env.REVIEW_RATE_LIMIT_PER_HOUR = "42";
    eq("合法环境变量生效", configFromEnv().reviewLimit, 42);
    process.env.REVIEW_RATE_LIMIT_PER_HOUR = "-1";
    eq("负数环境变量回落默认值（不能把额度拧成负的）", configFromEnv().reviewLimit, 100);
    process.env.REVIEW_RATE_LIMIT_PER_HOUR = "0";
    eq("0 是合法值，表示不限", configFromEnv().reviewLimit, 0);
    process.env.ACCESS_CODE_FAIL_DELAY_MS = "-5";
    eq("负的失败延迟回落默认值", configFromEnv().failDelayMs, 400);
    eq("窗口长度是代码里定的，不受环境变量影响", configFromEnv().reviewWindowSecs, HOUR_SECS);
  } finally {
    if (savedLimit === undefined) delete process.env.REVIEW_RATE_LIMIT_PER_HOUR;
    else process.env.REVIEW_RATE_LIMIT_PER_HOUR = savedLimit;
    if (savedDelay === undefined) delete process.env.ACCESS_CODE_FAIL_DELAY_MS;
    else process.env.ACCESS_CODE_FAIL_DELAY_MS = savedDelay;
  }

  // ---- 取 IP --------------------------------------------------------------
  // 取 IP：x-forwarded-for 是逗号分隔的链，第一项才最接近客户端
  const reqWith = (h: Record<string, string>) =>
    new Request("http://localhost/api/review", { method: "POST", headers: h });
  eq(
    "x-forwarded-for 取第一项",
    clientKeyFrom(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.10.11.12" })),
    "1.2.3.4",
  );
  eq("回落到 x-real-ip", clientKeyFrom(reqWith({ "x-real-ip": "9.9.9.9" })), "9.9.9.9");
  eq("都没有时用固定 key（宁可共用配额也不放过）", clientKeyFrom(reqWith({})), "unknown");

  // ---- 口令失败的统一处置 -------------------------------------------------
  // 这一段被**两条**路由共用（批改 /api/review + 口令页 /api/access），坏了是同时
  // 坏两条，其中一条是"口令页变成无限次猜口令机"。lib/access-gate.ts 刻意不 import
  // next/server、只返回纯数据，正是为了能在这儿用一个假 gate 直接断言它。

  // humanizeWait：这个数会原样出现在给用户看的文案里（「请 X 后再试」）。
  // 一律向上取整是刻意的——少报一秒，用户就会提前重试、又撞上一次锁。
  eq("不足 1 秒也报 1 秒（不能报「请 0 秒后再试」）", humanizeWait(1), "1 秒");
  eq("1.5 秒向上取整成 2 秒（截断成 1 就少报了）", humanizeWait(1500), "2 秒");
  // 分档用的是**取整后**的秒数，所以切换点在 59.001 秒而不是 60 秒。这个偏移方向
  // 是安全的：宁可说「1 分钟」让用户多等半秒，也不能说「59 秒」让他早 1 秒回来撞锁
  eq("59 秒整还是 59 秒", humanizeWait(59_000), "59 秒");
  eq("59.001 秒已取整到 60 秒，于是报 1 分钟（多报不会害人）", humanizeWait(59_001), "1 分钟");
  eq("一分钟整起改按分钟报", humanizeWait(FAIL_TIER1_LOCK_SECS * 1000), "1 分钟");
  // 用常量而不是字面量 300000：改了档位这条会跟着走，不然就成了摆设
  eq("最高档的锁报成 5 分钟", humanizeWait(FAIL_TIER2_LOCK_SECS * 1000), "5 分钟");
  // ⚠️ 这里**不**断言 humanizeWait(0)：那个分支不可达——两条路由都在
  // lockedForMs > 0 时才拿它拼文案。真为它写一条断言，等于把「请 0 秒后再试」
  // 钉成了预期行为

  // 假 gate 只做两件事：记下 key、回一个"这一次刚好锁上"的时长。
  // 用替身而不是真的内存 store，是因为要断言的是「拖慢到底有没有发生」（时序），
  // 而挂在 store 上是观察不到的。
  const gateWith = (failDelayMs: number) => {
    const seen = { key: null as string | null, calls: 0 };
    const gate: RateLimitGate = {
      policy: { ...policy, failDelayMs },
      peek: async () => ({ lockRetryAfterMs: 0, windowCount: 0, windowResetAfterMs: 0 }),
      recordFailure: async (key: string) => {
        seen.key = key;
        seen.calls += 1;
        return { failCount: FAIL_TIER1_COUNT, lockRetryAfterMs: 61_000 };
      },
      recordSuccess: async () => ({ windowCount: 0, windowResetAfterMs: 0 }),
      sweep: async () => undefined,
    };
    return { gate, seen };
  };

  const { gate: quickGate, seen: quickSeen } = gateWith(0);
  const quickAt = Date.now();
  const penalized = await penalizeAccessFailure(quickGate, "1.2.3.4");
  eq('把「这一次刚好锁上」的时长原样交回去（丢了它，被锁的人只会看到笼统的 401）', penalized.lockedForMs, 61_000);
  eq("失败记在**这个** key 上（记错 key = 换个 IP 就绕开）", quickSeen.key, "1.2.3.4");
  // 一次失败记两笔，等于档位翻倍地涨：正常手滑两下就被锁
  eq("一次失败只记一笔", quickSeen.calls, 1);
  check("failDelayMs 为 0 时真的一下都不等", Date.now() - quickAt < 150, { 耗时: Date.now() - quickAt });

  const { gate: slowGate } = gateWith(50);
  const slowAt = Date.now();
  await penalizeAccessFailure(slowGate, "1.2.3.4");
  // 容 5ms：setTimeout 不会早于 50ms 触发，但 Date.now() 是毫秒截断的
  check("配了拖慢就真的等那一下（这是串行爆破的成本）", Date.now() - slowAt >= 45, { 耗时: Date.now() - slowAt });

  // 两条锁定文案必须是**两句不同的话**：分开写就是为了让"你刚输的那一下正好是第 7 次"
  // 能当场说出来，而不是让用户以为又打错了、再撞一次才被告知被锁（那次又是几十秒）
  check("锁定文案≠刚被锁上的文案", lockedMessage(60_000) !== lockedAfterFailureMessage(60_000));
  check(
    "刚被锁上时：既说了口令不正确，也说了已锁定",
    /不正确/.test(lockedAfterFailureMessage(60_000)) && /已锁定/.test(lockedAfterFailureMessage(60_000)),
    { lockedAfterFailureMessage: lockedAfterFailureMessage(60_000) },
  );
  // 注意这里用 /锁定/ 而不是 /已锁定/：早拒那句写的是「已**暂时**锁定」。
  // 两句话用词不同是有意的——早拒是"等一会儿就行"，刚被锁上是"你错了，而且现在要等"
  check(
    '早拒时**不提**「口令不正确」（那一下根本没验口令，说了是误导）',
    !/不正确/.test(lockedMessage(60_000)) && /锁定/.test(lockedMessage(60_000)),
    { lockedMessage: lockedMessage(60_000) },
  );
  // 文案要能直接指导站长动手，否则他只知道"功能不可用"
  check("缺配置的文案点名了要设哪个环境变量", MISSING_CONFIG_MESSAGE.includes("REVIEW_ACCESS_CODE"));
  // 没到档就说"被锁定"是另一种误导：用户会以为账号被拉黑了，去翻根本不存在的黑名单。
  // （"缺配置 vs 口令不对"那对不用比——两条是各自写死的常量，类型系统已经保证不等）
  check("只是这一下错了，不提锁定", !/锁定/.test(ACCESS_DENIED_MESSAGE), { ACCESS_DENIED_MESSAGE });
}

// ---------------------------------------------------------------------------
/**
 * 这一段验证的是整条关键路径：构建 prompt → 调模型 → 解析 → 证据定位 →
 * 查表定档 → 折算分 → 升档建议关联证据。把 fetch 换掉就能离线跑通，
 * 这样 CI 上不配 key 也能测。
 */
async function runE2E() {
  console.log("\n[12] 端到端：批改编排（mock 掉模型调用，不需要 API key）");
  // 长度必须过 100 词、段数必须 ≥2，否则会被 lib/rubric.ts 的分数上限拦下来，
  // 测不到"模型的分数原样传下去"这条链路。原先这里只有 35 词一段，
  // 加了上限规则之后 fake 的 8 分会被压成 6 分——那不是回归，是那个 fixture
  // 本来就不该是一次合法的 8 分（8 分档要求"基本切题、表达尚可"）。
  const E2E_ESSAY =
    "Dear Sir, I am a student want to join your volunteer program. " +
    "I very like help other people. Last year I also join a activity about clean the park. " +
    "I think I have many advantage.\n\n" +
    "First, I am very hardworking and I can do many thing for your program. " +
    "Second, I have much free time on the weekend, so I can arrive on time every week. " +
    "I also want to learn more about how to help other people in a right way.\n\n" +
    "In conclusion, I hope you can give me a chance to join this program. " +
    "I will try my best to do the work well and I will not let you down.";

  const fakeModelOutput = {
    score15: 8,
    summary: "总体能看懂，但基础语法问题密集。",
    strengths: ["态度积极", "点到了志愿项目"],
    dimensionScores: [
      { dimension: "content", score: 4, comment: "基本切题" },
      { dimension: "language", score: 2, comment: "严重错误密集" },
      { dimension: "organization", score: 3, comment: "勉强连贯" },
    ],
    evidence: [
      { dimension: "language", kind: "major", quote: "I am a student want to join", comment: "定语从句缺关系词", suggestion: "who wants to join" },
      { dimension: "language", kind: "major", quote: "I very like help other people.", comment: "like 后应接动名词", suggestion: "I like helping other people very much." },
      { dimension: "language", kind: "major", quote: "I also join a activity about clean the park", comment: "时态与冠词", suggestion: "I also joined an activity to clean the park." },
      { dimension: "content", kind: "strength", quote: "volunteer program", comment: "点题" },
      { dimension: "organization", kind: "minor", quote: "Last year", comment: "有时间线推进" },
      // 这条是编造的，应当被标为未定位
      { dimension: "language", kind: "major", quote: "这句话在原文里根本没有出现过", comment: "应定位失败" },
    ],
    upgradePlan: [
      { priority: 1, dimension: "language", action: "先修主谓一致与定语从句", rationale: "r", example: { before: "a student want", after: "a student who wants" } },
      { priority: 2, dimension: "language", action: "固定搭配与介词", rationale: "r" },
      { priority: 3, dimension: "content", action: "补一个具体经历", rationale: "r" },
    ],
    // 训练区走**完整管线**（assembleResult）而不是单测 parser。
    // 三条里故意混进一个自造类别和一个大小写不规范的写法：
    // 前者整条丢弃、后者归一后收下，这两个行为只有在端到端才看得出是同一件事。
    trainingPlan: [
      { focus: "agreement", reason: "全文 4 处第三人称单数漏 s" },
      { focus: "SPELLING", reason: "同一篇里拼法不统一" },
      { focus: "grammar", reason: "自造类别，应被整条丢弃" },
    ],
  };

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-not-real";

  let captured: { url: string; body: Record<string, unknown> } | null = null;

  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = init as { body: string };
    captured = { url: String(url), body: JSON.parse(i.body) };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(fakeModelOutput) } }],
        usage: { total_tokens: 123 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  /**
   * 换一份模型输出（或换一篇作文）再跑一次批改。
   *
   * 判分链路上的每个兜底都只在"模型没规矩"时才生效，而上面那份 fixture 是
   * 一切都规规矩矩的样子——拿它测不出任何兜底。所以下面几组断言各自换一份
   * 病态输出重跑一遍，跑的还是同一条 reviewEssay 全链路（不是单测某个函数），
   * 这样"校验算对了"和"警告真的发出去了"是同一件事。
   */
  const reviewWith = async (
    output: Record<string, unknown>,
    essay: string = E2E_ESSAY,
  ): Promise<ReviewResult> => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      return await reviewEssay({ essay, topic: "apply for a volunteer program" });
    } finally {
      globalThis.fetch = previous;
    }
  };

  try {
    const result = await reviewEssay({
      essay: E2E_ESSAY,
      topic: "apply for a volunteer program",
    });

    eq("分数来自模型", result.score15, 8);
    eq("档次由代码查表得出", result.band.label, "8 分档");
    eq("折算分正确", result.score106, 56.8);
    eq("原文随结果返回（供高亮用）", result.essay, E2E_ESSAY);
    eq("证据条数", result.evidence.length, 6);
    eq("已定位条数（1 条编造的应失败）", result.stats.verifiedCount, 5);

    const bogusEvidence = result.evidence.find((e) => e.quote.includes("根本没有出现"))!;
    eq("编造的引文被标为未定位", bogusEvidence.verified, false);
    eq("编造的引文没有坐标", bogusEvidence.start, null);
    check(
      "未定位会产出 warning",
      result.warnings.some((w) => w.includes("没能在原文中定位")),
      result.warnings,
    );

    const first = result.evidence[0];
    eq("证据坐标能在原文中还原", E2E_ESSAY.slice(first.start!, first.end!), first.quote);

    eq("升档建议 priority 连续", result.upgradePlan.map((p) => p.priority), [1, 2, 3]);
    const langPlan = result.upgradePlan.find((p) => p.dimension === "language")!;
    check(
      "升档建议自动关联到同维度证据",
      langPlan.linkedEvidenceIds.length > 0 &&
        langPlan.linkedEvidenceIds.every((id) => result.evidence.some((e) => e.id === id)),
      langPlan.linkedEvidenceIds,
    );
    check("升档建议的关联证据优先挂严重错误", langPlan.linkedEvidenceIds.includes("e1"), langPlan.linkedEvidenceIds);

    // --- 训练区（走的是完整管线，不是单元测 parser）------------------------
    eq("训练项条数（自造类别被整条丢弃）", result.trainingPlan?.length, 2);
    eq(
      "大小写不规范的类别被归一后收下，顺序保持",
      result.trainingPlan?.map((t) => t.focus),
      ["agreement", "spelling"],
    );
    check(
      "训练项自动关联到真实存在的同维度证据",
      result.trainingPlan!.every(
        (t) =>
          t.linkedEvidenceIds.length > 0 &&
          t.linkedEvidenceIds.every((id) => result.evidence.some((e) => e.id === id)),
      ),
      result.trainingPlan,
    );

    // --- 升档示范：给没给、是不是原文里的，报告上必须**看得出差别** --------
    const examplePlan = result.upgradePlan.filter((a) => a.example);
    eq("给了示范的建议数", examplePlan.length, 1);
    eq("没给示范的被标出来了（3 条里 2 条没给）", result.upgradePlan.filter((a) => a.exampleMissing).length, 2);
    check("逐字来自原文的示范不打未验证标记", !examplePlan[0].exampleUnverified, examplePlan[0]);
    // 没给示范是正常降级，不是故障——报 warning 会把"模型这次省略了"渲染成一次失败
    check(
      "没给示范**不**产生 warning",
      !result.warnings.some((w) => w.includes("改写示范")),
      result.warnings,
    );

    check("请求打到了正确的接口", captured!.url.endsWith("/chat/completions"), captured!.url);
    const sentMessages = (captured!.body.messages as Array<{ content: string }>) ?? [];
    check("system prompt 带上了档次表", sentMessages[0].content.includes("14 分档"));
    check("user prompt 带上了原文", sentMessages[1].content.includes("I very like help other people."));
    check("user prompt 带上了题目", sentMessages[1].content.includes("apply for a volunteer program"));
    eq("开启了 JSON 输出模式", captured!.body.response_format, { type: "json_object" });
    // 打分必须可复现：同一篇作文交两次要给同一个分数。0.2 时实测平均波动
    // 0.75 分/篇、最大 4 分。见 lib/deepseek.ts 的 DEFAULT_TEMPERATURE。
    eq("temperature 为 0（同一篇作文的分数要可复现）", captured!.body.temperature, 0);

    check("meta 记录了模型名", Boolean(result.meta.model), result.meta.model);
    check("meta 记录了耗时", typeof result.meta.elapsedMs === "number");

    // ---- 上面这份 fixture 是"一切都正常"的基线。下面几条钉住的是**不该出声**：
    // 原文里没有重复引文、kind 全合法、分数是数字，所以这四项必须安静。
    // 少了这一半，一个"永远报警"的实现也能让后面那几条变绿
    eq("基线：没有歧义条目", result.stats.ambiguousCount, 0);
    check(
      "基线：没有歧义警告",
      !result.warnings.some((w) => w.includes("不止一处")),
      result.warnings,
    );
    check(
      "基线：没有 kind 兜底的警告",
      !result.warnings.some((w) => w.includes("严重程度字段")),
      result.warnings,
    );
    check(
      "基线：没有“总分不可用”的警告",
      !result.warnings.some((w) => w.includes("可用的总分")),
      result.warnings,
    );

    // ---- G1：模型把 score15 写成字符串 ----
    // 修之前这里会得到一份**看起来完全正常、但 0 分 0 档**的报告：不报错、不告警，
    // 因为对下游来说 0 是个合法分数。这是整轮里最值钱的一条断言
    const withScoreString = await reviewWith({ ...fakeModelOutput, score15: "8" });
    eq("G1：字符串分数被收下（不是 0 分）", withScoreString.score15, 8);
    eq("G1：档次随之正确", withScoreString.band.label, "8 分档");
    check(
      "G1：字符串分数不算异常，不出警告",
      !withScoreString.warnings.some((w) => w.includes("可用的总分")),
      withScoreString.warnings,
    );

    // ---- G1：模型给了一个根本不能当分数的值 ----
    const withBadScore = await reviewWith({ ...fakeModelOutput, score15: "八分" });
    eq("G1：读不出来的分数落 0", withBadScore.score15, 0);
    check(
      "G1：读不出来的分数**必须出声**（这就是原来那条静默路径）",
      withBadScore.warnings.some((w) => w.includes("可用的总分")),
      withBadScore.warnings,
    );
    check(
      "G1：警告里带上收到的原值，便于排查",
      withBadScore.warnings.some((w) => w.includes("八分")),
      withBadScore.warnings,
    );

    // ---- G2：引文在原文里出现多次 ----
    // 造一篇"同一句话出现两次"的作文，让模型引的那句有歧义。
    // 断言的重点不是"落在哪一处"（那只能是猜），而是这件事被说了出来，
    // 且**没有**把 method 降级——两处都是逐字命中，降级就是假信息
    const dupEssay = E2E_ESSAY.replace("First, I am very hardworking", "I very like help other people.");
    const dupResult = await reviewWith({ ...fakeModelOutput, score15: 8 }, dupEssay);
    const amb = dupResult.evidence.filter((e) => e.ambiguity === "multiple");
    check("G2：重复出现的引文被标出多处匹配", amb.length > 0, dupResult.evidence.map((e) => [e.quote, e.ambiguity]));
    eq("G2：被标出的那条仍然是 exact（匹配方式没有疑问）", amb[0]?.locateMethod, "exact");
    check("G2：候选处数 ≥2", (amb[0]?.hitCount ?? 0) >= 2, amb[0]?.hitCount);
    eq("G2：歧义计入 stats 的子计数", dupResult.stats.ambiguousCount, amb.length);
    check(
      "G2：歧义条目照样算“已定位”（不打破已定位/未定位的二分）",
      amb.length > 0 && amb.every((e) => e.verified),
      amb.map((e) => [e.id, e.verified]),
    );
    check(
      "G2：出了一条歧义警告",
      dupResult.warnings.some((w) => w.includes("不止一处")),
      dupResult.warnings,
    );

    // ---- G4：模型给的严重程度不是三个合法值 ----
    const withBadKind = await reviewWith({
      ...fakeModelOutput,
      evidence: fakeModelOutput.evidence.map((e) => ({ ...e, kind: "severe" })),
    });
    eq("G4：降级的条目一条不少（不是丢弃）", withBadKind.evidence.length, 6);
    eq("G4：全部按 minor 处理", withBadKind.evidence.every((e) => e.kind === "minor"), true);
    eq("G4：每一条都带上了标记", withBadKind.evidence.every((e) => e.kindDegraded), true);
    check(
      "G4：出了一条说明“严重程度没给对”的警告",
      withBadKind.warnings.some((w) => w.includes("严重程度字段")),
      withBadKind.warnings,
    );
    // 后果本身也要钉住：没有一条 major，按 major 条数算的上限规则就无从触发。
    // 这不是要修的 bug（模型没说多重，代码没法替它猜），而是**必须被说出来**的
    // 后果——上面那条警告就是干这个的
    eq("G4：major 条数归零（上限规则因此无从触发）", withBadKind.evidence.filter((e) => e.kind === "major").length, 0);
    check(
      "G4：分数没有被上限校正（符合预期，且已经有警告说明原因）",
      !withBadKind.warnings.some((w) => w.includes("分数已由系统校正")),
      withBadKind.warnings,
    );

    // ---- 升档示范：编造的 before 必须被抓到 ----------------------------------
    //
    // "强制每条建议都给示范"这个改动有个反作用：给不出好例子时模型会**编一个**。
    // 《强制 + 核查》才成立，所以这条测的就是核查那一半。
    //
    // ⚠️ before 特意选 "I like very"：原文是 "I very like help other people"，
    // 三个词里中三个、词重叠 100%，locateQuote 会一路退到 fuzzy 并报"命中"。
    // 只有把判定收在 exact | normalized 才抓得住它。**这条断言一旦变红，
    // 先去看 locateExampleQuote 的判定条件是不是被改回了 `!== "none"`。**
    const fabricated = await reviewWith({
      ...fakeModelOutput,
      upgradePlan: [
        {
          priority: 1, dimension: "language", action: "把 X 改成 Y", rationale: "r",
          example: { before: "I like very", after: "I like ... very much" },
        },
        {
          priority: 2, dimension: "language", action: "把 A 改成 B", rationale: "r",
          example: { before: "I very like help other people.", after: "I like helping other people." },
        },
      ],
    });
    eq("编造的示范被标为未验证", fabricated.upgradePlan[0].exampleUnverified, true);
    check(
      "逐字来自原文的那条**没有**被误标（同一份输出里对照）",
      !fabricated.upgradePlan[1].exampleUnverified,
      fabricated.upgradePlan[1],
    );
    check(
      "编造的示范会产出 warning（只强制不核查比不强制更糟：等于发一份假范文）",
      fabricated.warnings.some((w) => w.includes("改写示范没能在原文中找到")),
      fabricated.warnings,
    );
    // 给了示范就不该再打 exampleMissing——两个标记同时出现会让报告前后矛盾
    check(
      "给了示范就不再打 exampleMissing",
      fabricated.upgradePlan.every((a) => !a.exampleMissing),
      fabricated.upgradePlan.map((a) => [a.exampleMissing, a.exampleUnverified]),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
}

// ---------------------------------------------------------------------------
/**
 * 客户端断开时要中止上游调用。
 *
 * 这条不测的话很容易退化成一个安静的漏钱口：用户关掉标签页，服务端仍然
 * 把整篇批改跑完、全额计费，只是响应没人收。
 *
 * 同时反向验证超时路径没被这次改动弄坏——两条路径都走 AbortError，
 * 很容易改成"全都报 CLIENT_ABORTED"。
 */
async function runAbortTest() {
  console.log("\n[13] 客户端断开时中止上游调用");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalTimeout = process.env.REVIEW_TIMEOUT_MS;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-not-real";

  // 这个 mock 永远不返回，只在收到中止信号时 reject —— 模拟一个卡住的上游
  let sawSignal: AbortSignal | undefined;
  globalThis.fetch = ((_url: unknown, init: unknown) => {
    const signal = (init as { signal?: AbortSignal }).signal;
    sawSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      const bang = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal?.aborted) return bang();
      signal?.addEventListener("abort", bang, { once: true });
    });
  }) as typeof fetch;

  /** 跑一次批改，返回错误码（成功则返回 "NO_ERROR"） */
  const codeOf = async (signal: AbortSignal | undefined, timeoutMs?: number) => {
    if (timeoutMs === undefined) delete process.env.REVIEW_TIMEOUT_MS;
    else process.env.REVIEW_TIMEOUT_MS = String(timeoutMs);
    try {
      await reviewEssay({ essay: "Dear Sir, I am a student want to join your program." }, signal);
      return "NO_ERROR";
    } catch (e) {
      return (e as { code?: string }).code ?? "NOT_AN_LLM_ERROR";
    }
  };

  try {
    // ① 调用途中断开
    const ctrl = new AbortController();
    const pending = codeOf(ctrl.signal, 30_000);
    ctrl.abort();
    eq("客户端断开 → CLIENT_ABORTED（不是 TIMEOUT）", await pending, "CLIENT_ABORTED");

    // ② 断开信号真的传到了 fetch。这才是"停止烧钱"的实际动作——
    //    只把错误码改个名字、上游照跑，等于没修
    check(
      "中止信号确实传到了上游 fetch",
      sawSignal !== undefined && sawSignal.aborted,
      sawSignal?.aborted,
    );

    // ③ 传进来时就已经断开的信号，也要立刻中止
    const pre = new AbortController();
    pre.abort();
    eq("传入时已断开的信号同样中止", await codeOf(pre.signal, 30_000), "CLIENT_ABORTED");

    // ④ 反向验证：没有外部信号时，超时仍然报 TIMEOUT
    eq("单纯超时仍然报 TIMEOUT", await codeOf(undefined, 30), "TIMEOUT");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    if (originalTimeout === undefined) delete process.env.REVIEW_TIMEOUT_MS;
    else process.env.REVIEW_TIMEOUT_MS = originalTimeout;
  }
}

// ---------------------------------------------------------------------------
// [14] 增量 JSON 扫描
//
// 扫描器只负责展示、不承担正确性（最终结果永远由 extractJson 解析累积全文，
// 见 lib/json-stream.ts 头部）。但它有一条比"展示得对不对"更重要的性质，
// 也是这一节花最多篇幅去测的：**缓冲只增不减，所以扫描结果必须单调**——
// 已产出的成员不能消失、值也不能变。一旦变了，等待界面上就会出现
// "这段文字已经显示出来了，几秒后自己改了口"。
//
// 逐前缀扫一遍是抓这类 bug 最直接的打法：任何边界错误都会在某个 n 上暴露出来，
// 而且不需要猜边界在哪。
function runJsonStreamTests(): void {
  console.log("\n[14] 增量 JSON 扫描");

  /** 喂进全部 doc.length + 1 个前缀，断言已产出的部分只增不改，返回最后一次的结果 */
  function feedAllPrefixes(label: string, doc: string): ScanResult {
    let prevMembers: ScannedMember[] = [];
    let prevEvidence: unknown[] = [];
    let broke = "";

    for (let n = 0; n <= doc.length; n += 1) {
      const scan = scanJsonPrefix(doc.slice(0, n));

      if (scan.members.length < prevMembers.length) {
        broke = `n=${n}：成员数从 ${prevMembers.length} 掉到 ${scan.members.length}`;
      }
      for (let i = 0; !broke && i < prevMembers.length; i += 1) {
        if (JSON.stringify(scan.members[i]) !== JSON.stringify(prevMembers[i])) {
          broke = `n=${n}：第 ${i} 个成员变了，${JSON.stringify(prevMembers[i])} → ${JSON.stringify(scan.members[i])}`;
        }
      }
      if (scan.evidence.length < prevEvidence.length) {
        broke = `n=${n}：证据数从 ${prevEvidence.length} 掉到 ${scan.evidence.length}`;
      }
      for (let i = 0; !broke && i < prevEvidence.length; i += 1) {
        if (JSON.stringify(scan.evidence[i]) !== JSON.stringify(prevEvidence[i])) {
          broke = `n=${n}：第 ${i} 条证据变了`;
        }
      }
      if (broke) break;

      prevMembers = scan.members;
      prevEvidence = scan.evidence;
    }

    check(`${label}：每一个前缀都单调（${doc.length + 1} 次扫描）`, broke === "", broke);
    return { members: prevMembers, evidence: prevEvidence };
  }

  // 一份把各种"会让朴素扫描器翻车"的东西都塞进去的文档：
  // 字符串里的花括号、转义引号、反斜杠、换行、emoji（代理对）、中文
  const TRICKY_VALUE = '他说："这里有 { 花括号 }、反斜杠 \\ 和 emoji 🎉"，还有换行\n第二行';
  const doc = JSON.stringify({
    score15: 8,
    summary: TRICKY_VALUE,
    strengths: ["主题明确", '含引号"的片段'],
    dimensionScores: [
      { dimension: "content", score: 3, comment: "基本切题" },
      { dimension: "language", score: 2, comment: "主谓不一致" },
      { dimension: "organization", score: 3, comment: "有基本结构" },
    ],
    evidence: [
      { dimension: "language", kind: "major", quote: "I very like help", comment: "主谓不一致" },
      {
        dimension: "content",
        kind: "strength",
        quote: "Last year I join",
        comment: "有具体经历",
        suggestion: "改成 joined",
      },
    ],
    upgradePlan: [{ priority: 1, dimension: "language", action: "先修主谓一致", rationale: "r" }],
  });

  const scanned = feedAllPrefixes("含转义/花括号/emoji 的文档", doc);
  eq(
    "顶层成员按出现顺序全部扫出",
    scanned.members.map((m) => m.key),
    ["score15", "summary", "strengths", "dimensionScores", "evidence", "upgradePlan"],
  );
  eq("含转义、换行与 emoji 的值原样还原", scanned.members[1]?.value, TRICKY_VALUE);
  eq("evidence 逐条扫出", scanned.evidence.length, 2);
  eq(
    "evidence 元素内容完整（含可选字段 suggestion）",
    (scanned.evidence[1] as { suggestion?: string })?.suggestion,
    "改成 joined",
  );

  // 20 条证据的文档也扫一遍前缀，确认规模上来之后单调性仍然成立
  const many = JSON.stringify({
    evidence: Array.from({ length: 20 }, (_, i) => ({ quote: `q${i}`, kind: "minor" })),
  });
  eq("20 条证据全部扫出", feedAllPrefixes("20 条证据", many).evidence.length, 20);

  // 分隔符规则：不遇到分隔符就不产出。这是刻意的——否则界面上会出现一个
  // 还在生长、每来一个字就重排一次的字符串
  eq("没遇到分隔符就不产出", scanJsonPrefix('{"summary": "abc"').members.length, 0);
  eq("补上逗号后恰好产出一遍", scanJsonPrefix('{"summary": "abc",').members, [
    { key: "summary", value: "abc" },
  ]);
  eq("最后一个成员靠外层 } 收尾", scanJsonPrefix('{"summary": "abc"}').members, [
    { key: "summary", value: "abc" },
  ]);

  // 逐个点名的切点（前缀扫描已经全覆盖，这几条是为了让意图留在测试里）
  eq("切在键名中间：不产出", scanJsonPrefix('{"summ').members.length, 0);
  eq("切在键与冒号之间：不产出", scanJsonPrefix('{"summary"').members.length, 0);
  eq("切在冒号与值之间：不产出", scanJsonPrefix('{"summary":').members.length, 0);
  eq("切在数字中间：不产出", scanJsonPrefix('{"a": 12').members.length, 0);
  eq("切在字符串内的转义符之后：不产出", scanJsonPrefix('{"a": "x\\').members.length, 0);
  eq("切在代理对中间：不产出（emoji 也不能把它劈坏）", scanJsonPrefix('{"a": "🎉'.slice(0, 8)).members.length, 0);
  eq("值写完后立刻产出（等到 } ）", scanJsonPrefix('{"a": 1}').members.length, 1);

  // 重复键：只认第一个 evidence 数组，否则渐进视图会推出最终 JSON.parse 会丢掉的条目
  eq(
    "重复的 evidence 键只认第一个",
    scanJsonPrefix('{"evidence":[{"q":1}],"other":[{"q":2}],"evidence":[{"q":3}]}').evidence,
    [{ q: 1 }],
  );
  // 证据项里的 example: {before, after} 是第 4 层，不能被当成又一条证据
  eq(
    "证据项里的嵌套对象不会被当成又一条证据",
    scanJsonPrefix('{"evidence":[{"quote":"q","example":{"before":"a","after":"b"}}]}').evidence.length,
    1,
  );

  // 截断：只可能少报，绝不抛
  eq("截断的 evidence 项不产出", scanJsonPrefix('{"evidence":[{"quote":"abc","comment":"还没写完').evidence, []);
  eq(
    "截断的数组不影响前面已经写完的成员",
    scanJsonPrefix('{"summary": "abc", "strengths": ["a", "b').members.length,
    1,
  );

  // 深度炸弹：正常输出只有 4-5 层，超过上限直接放弃扫描，但不能爆栈
  const bomb = '{"a":' + "[".repeat(200) + "1" + "]".repeat(200) + "}";
  eq("超深嵌套直接放弃（只可能少报）", scanJsonPrefix(bomb).members.length, 0);

  // 散文前缀：模型偶尔会在 JSON 前面写一句客套话，里面的花括号不能把人骗过去
  eq(
    "散文里的假花括号不会骗到扫描器",
    scanJsonPrefix('好的，结果如下（JSON 格式）：{不是对象}，真正的对象在下面：{"a": 1}').members,
    [{ key: "a", value: 1 }],
  );

  // "绝不抛"是调用方能 try/catch 它的前提。这里把各种半截结构都试一遍
  for (const weird of ["", "{", '"', "\\", "{\"", '{"a', '{"a"', "{]", "[}", '{"a": }', "{{{", "｛\"a\":1｝", '{"a":1}}']) {
    let threw = false;
    try {
      scanJsonPrefix(weird);
    } catch {
      threw = true;
    }
    check(`怪输入不抛异常：${JSON.stringify(weird)}`, !threw);
  }
}

// ---------------------------------------------------------------------------
// [15] SSE 分帧
function runSseTests(): void {
  console.log("\n[15] SSE 分帧");

  const encoded = encodeSseFrame("meta", { type: "meta", chars: 3 });
  eq("编码格式", encoded, 'event: meta\ndata: {"type":"meta","chars":3}\n\n');

  const parsed = createSseFrameParser().push(encoded);
  eq("一帧", parsed.length, 1);
  eq("事件名", parsed[0]?.event, "meta");
  eq("载荷", parsed[0]?.data, { type: "meta", chars: 3 });

  // 载荷里的换行会被 JSON.stringify 转义成字面的 \n，所以 data 永远只占一行——
  // 这是 encodeSseFrame 敢直接拼字符串的前提
  const multiline = encodeSseFrame("summary", { value: "第一行\n第二行" });
  eq(
    "带换行的载荷仍然只占一行 data",
    multiline.split("\n").filter((l) => l.startsWith("data:")).length,
    1,
  );
  eq(
    "换行原样还原",
    (createSseFrameParser().push(multiline)[0]?.data as { value: string }).value,
    "第一行\n第二行",
  );

  // **帧被切在两块 chunk 之间**：每一个切点都必须能拼回来。
  // 这是客户端读取器唯一真正难写对的地方，所以穷举所有切点
  const payload = { type: "evidence", value: { id: "e1", quote: '含"引号"和\n换行' } };
  const text = encodeSseFrame("evidence", payload);
  let badSplits = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const p = createSseFrameParser();
    const got = [...p.push(text.slice(0, i)), ...p.push(text.slice(i))];
    if (got.length !== 1 || JSON.stringify(got[0].data) !== JSON.stringify(payload)) badSplits += 1;
  }
  check(`任意切点都能拼回一帧（${text.length + 1} 个切点）`, badSplits === 0, `${badSplits} 个切点失败`);

  eq(
    "一块含两帧",
    createSseFrameParser().push(encodeSseFrame("a", 1) + encodeSseFrame("b", 2)).map((f) => f.event),
    ["a", "b"],
  );

  // 这一条盯的是分帧里最容易写错的地方：**不能按块归一化换行**。
  // 前一块以孤立的 \r 结尾、后一块以 \n 开头，合起来才是空行；
  // 一旦按块把 \r 规整成 \n，前一块自己就凑出了"空行"，凭空多切一帧
  const crlfTrap = createSseFrameParser();
  eq("结尾的孤立 \\r 不算空行", crlfTrap.push("event: a\r\ndata: 1\r\n\r").length, 0);
  eq("补上 \\n 才成帧（没有凭空多切）", crlfTrap.push("\n").length, 1);

  const lfTrap = createSseFrameParser();
  eq("结尾的单个 \\n 不算空行", lfTrap.push("event: a\ndata: 1\n").length, 0);
  eq("再补一个 \\n 才成帧", lfTrap.push("\n").length, 1);

  eq("\\r\\n\\r\\n 也认", createSseFrameParser().push("event: a\r\ndata: 1\r\n\r\n").length, 1);

  const withComment = createSseFrameParser().push(": 心跳注释\nevent: a\ndata: 1\n\n");
  eq("注释行被忽略", withComment.length, 1);
  eq("注释不影响事件名", withComment[0]?.event, "a");

  eq("只有注释的块不派发", createSseFrameParser().push(": 只有注释\n\n").length, 0);
  eq(
    "多行 data 用换行拼起来",
    createSseFrameParser().push("event: a\ndata: 第一行\ndata: 第二行\n\n")[0]?.raw,
    "第一行\n第二行",
  );
  // 规范规定冒号后紧跟的**一个**空格要去掉，多出来的属于数据
  eq(
    "冒号后只吃掉一个空格",
    createSseFrameParser().push("data:  1\n\n")[0]?.raw,
    " 1",
  );

  // 坏掉的载荷不能静默丢掉：上层要能区分"这一帧坏了"和"流结束了但没有结果"
  const broken = createSseFrameParser().push("event: a\ndata: {不是 JSON}\n\n");
  eq("坏载荷仍然交出这一帧", broken.length, 1);
  eq("坏载荷的 data 是 undefined", broken[0]?.data, undefined);
  eq("坏载荷保留原文供记日志", broken[0]?.raw, "{不是 JSON}");

  // 承重墙：next 15 默认装的 compression 把 text/event-stream 判成可压缩，
  // 靠 no-transform 让 shouldTransform() 直接返回 false。这条没了就可能被缓冲
  eq("Content-Type 是 SSE", SSE_RESPONSE_HEADERS["Content-Type"], "text/event-stream; charset=utf-8");
  check(
    "Cache-Control 带 no-transform",
    (SSE_RESPONSE_HEADERS["Cache-Control"] ?? "").includes("no-transform"),
    SSE_RESPONSE_HEADERS["Cache-Control"],
  );
  check("禁用中间层缓冲", SSE_RESPONSE_HEADERS["X-Accel-Buffering"] === "no");
}

// ---------------------------------------------------------------------------
// [16] 流式与非流式平价

/** 造一个 OpenAI 兼容的 SSE 响应体，把 content 切成 chunkSize 大小一片一片吐出去 */
function sseResponse(
  content: string,
  opts: { chunkSize?: number; gapMs?: number; finishReason?: string; signal?: AbortSignal } = {},
): Response {
  const size = opts.chunkSize ?? 1;
  const pieces: string[] = [];
  for (let i = 0; i < content.length; i += size) pieces.push(content.slice(i, i + size));

  const encoder = new TextEncoder();
  let stopped = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stopped = true;
        }
      };

      // 模拟真实 fetch 的行为：请求信号一断，读端立刻拿到 AbortError。
      // 自己 new 出来的 Response 不会自动接上信号，必须手动接——
      // 否则"客户端断开时中止上游"这条在测试里永远是假的绿
      opts.signal?.addEventListener("abort", () => {
        if (stopped) return;
        stopped = true;
        const err = new Error("aborted");
        err.name = "AbortError";
        try {
          controller.error(err);
        } catch {
          // 流已经关了，忽略
        }
      });

      for (let i = 0; i < pieces.length; i += 1) {
        // gapMs 用来模拟"上游卡住了"，让 2 秒一次的心跳有机会发出来
        if (opts.gapMs && i === pieces.length - 1) {
          await new Promise((r) => setTimeout(r, opts.gapMs));
        }
        if (stopped) return;
        send(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`);
      }

      send(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finishReason ?? "stop" }] })}\n\n`,
      );
      send("data: [DONE]\n\n");
      if (!stopped) {
        stopped = true;
        try {
          controller.close();
        } catch {
          // 忽略
        }
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function runStreamParityTests(): Promise<void> {
  console.log("\n[16] 流式与非流式平价");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-not-real";

  const ESSAY =
    "I am a student want to join your volunteer program. I very like help other people. " +
    "Last year I also join a activity about clean the park.";
  const TOPIC = "apply for a volunteer program";

  const modelJson = JSON.stringify({
    score15: 8,
    summary: "意思能看懂，但语言错误密集。",
    strengths: ["主题明确", "有具体经历"],
    // 刻意按 DIMENSIONS 的顺序给，这样"逐个推出去的维度分"与最终数组可以直接比
    dimensionScores: [
      { dimension: "content", score: 3, comment: "基本切题" },
      { dimension: "language", score: 2, comment: "主谓不一致较多" },
      { dimension: "organization", score: 3, comment: "有基本结构" },
    ],
    evidence: [
      {
        dimension: "language",
        kind: "major",
        quote: "I very like help other people.",
        comment: "主谓不一致",
        suggestion: "I like helping others.",
      },
      { dimension: "content", kind: "strength", quote: "Last year I also join", comment: "有具体经历" },
      { dimension: "language", kind: "major", quote: "这句原文里根本没有出现过", comment: "应定位失败" },
    ],
    upgradePlan: [
      {
        priority: 1,
        dimension: "language",
        action: "先修主谓一致",
        rationale: "r",
        example: { before: "a student want", after: "a student who wants" },
      },
    ],
    // 平价断言是 `strip(streamed)` vs `strip(plain)` 的整体比较（`strip` 里是展开），
    // 所以只要有一条路径漏了给 trainingPlan，下面那条 eq 立刻就红。
    // 这是本轮性价比最高的护栏——务必让这份 fixture **真的带着**这个字段，
    // 两边都没有的话比的是"缺席 vs 缺席"，什么也测不到。
    trainingPlan: [{ focus: "agreement", reason: "主谓不一致反复出现" }],
  });

  /** 调一次流式批改，只把错误码取出来（照抄 runAbortTest 的写法） */
  const codeOfStream = async (
    signal: AbortSignal | undefined,
    seen?: ReviewStreamEvent[],
  ): Promise<string> => {
    try {
      await reviewEssayStream({ essay: ESSAY, topic: TOPIC }, signal, (e) => seen?.push(e));
      return "NO_ERROR";
    } catch (e) {
      return (e as { code?: string }).code ?? "NOT_AN_LLM_ERROR";
    }
  };

  /** filter 的收窄版，省得后面到处写类型断言 */
  const only = <T extends ReviewStreamEvent["type"]>(list: ReviewStreamEvent[], type: T) =>
    list.filter((e): e is Extract<ReviewStreamEvent, { type: T }> => e.type === type);

  try {
    // ① 非流式：一次请求一次返回
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: modelJson } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const plain = await reviewEssay({ essay: ESSAY, topic: TOPIC });
    eq("（前提）非流式路径能跑通", typeof plain.score15, "number");

    // ② 流式：同一份 JSON，切成**一个字符一块**地喂进去。这是最恶毒的切法，
    //    每个 chunk 边界都落在半帧、半个字符串、甚至代理对中间
    globalThis.fetch = (async () => sseResponse(modelJson, { chunkSize: 1 })) as typeof fetch;
    const events: ReviewStreamEvent[] = [];
    const streamed = await reviewEssayStream({ essay: ESSAY, topic: TOPIC }, undefined, (e) =>
      events.push(e),
    );

    // 结果平价。这是唯一能证明"两条路径共用同一套后处理"的测试：
    // 同一份模型输出，一次走普通响应、一次按对抗性边界切碎，结果必须一模一样
    const strip = (r: ReviewResult): ReviewResult => ({
      ...r,
      meta: { ...r.meta, elapsedMs: 0, createdAt: "" },
    });
    eq("流式与非流式结果完全一致（除耗时/时间戳）", strip(streamed), strip(plain));

    // 事件日志必须是最终结果的一个一致投影
    eq("第一帧是 meta", events[0]?.type, "meta");
    eq("meta 只出现一次", only(events, "meta").length, 1);
    eq("最后一帧是 result", events[events.length - 1]?.type, "result");

    const last = events[events.length - 1];
    check("result 帧带的就是权威结果对象", last.type === "result" && last.result === streamed);
    eq("没有 error 帧", only(events, "error").length, 0);

    // 三条硬规矩：不发 score15、不发 warnings。分数要等上限校正算完，
    // 而 warnings 里那条"分数已由系统校正：模型给出 N 分"会把押后的原始分漏出来
    const premature = events
      .slice(0, -1)
      .filter((e) => {
        const s = JSON.stringify(e);
        return s.includes("score15") || s.includes("warnings");
      })
      .map((e) => e.type);
    eq("result 之前的帧里没有 score15 / warnings", premature, []);

    // 训练区同理，但理由不同：score15/warnings 是"还没算完"，训练区是
    // **结论**，本来就不该被逐条推——客户端也不该在等待页上给它留位置。
    check(
      "训练区确实随 result 帧到了（让上面的平价比较有东西可比）",
      (streamed.trainingPlan ?? []).length > 0,
      streamed.trainingPlan,
    );
    eq(
      "result 之前的帧里没有 trainingPlan",
      events.slice(0, -1).filter((e) => JSON.stringify(e).includes("trainingPlan")).length,
      0,
    );

    // 证据 id 是最终 id 的**前缀**——不是碰巧对上，是同一批解析结果
    const streamedIds = only(events, "evidence").map((e) => e.value.id);
    eq("证据 id 是最终 id 的前缀", streamedIds, streamed.evidence.map((e) => e.id).slice(0, streamedIds.length));
    eq("证据一条不落", streamedIds.length, streamed.evidence.length);
    check(
      "未定位的引文照样逐条推（定位是最后统一算的）",
      streamed.evidence.some((e) => !e.verified),
      streamed.evidence.map((e) => e.verified),
    );

    // 逐条推的内容必须与最终结果一致
    const summaryFrame = only(events, "summary")[0];
    check("总评帧与最终总评一致", summaryFrame?.value === streamed.summary, summaryFrame?.value);
    const strengthsFrame = only(events, "strengths")[0];
    check(
      "优点帧与最终优点一致",
      JSON.stringify(strengthsFrame?.value) === JSON.stringify(streamed.strengths),
      strengthsFrame?.value,
    );
    const dimFrames = only(events, "dimensionScores").flatMap((e) => e.value);
    eq("维度分帧拼起来就是最终那三份", dimFrames, streamed.dimensionScores);

    // pending 证据**不带**坐标字段：这样将来不可能有代码从一个还没定位的条目上
    // 读出一个"定位失败"来
    const firstEvidence = only(events, "evidence")[0]?.value;
    check(
      "证据帧是 pending 形状，不含坐标/verified/locateMethod",
      firstEvidence?.pending === true &&
        !("start" in firstEvidence) &&
        !("end" in firstEvidence) &&
        !("verified" in firstEvidence) &&
        !("locateMethod" in firstEvidence),
      firstEvidence,
    );

    // ③ 证据条数上限：模型给 18 条时，渐进视图不能先显示 18 张卡、
    //    最终报告里却只有 15 张
    const manyJson = JSON.stringify({
      summary: "s",
      evidence: Array.from({ length: 18 }, (_, i) => ({
        dimension: "language",
        kind: "minor",
        quote: `quote ${i}`,
        comment: `c${i}`,
      })),
    });
    globalThis.fetch = (async () => sseResponse(manyJson, { chunkSize: 3 })) as typeof fetch;
    const manyEvents: ReviewStreamEvent[] = [];
    const manyResult = await reviewEssayStream({ essay: ESSAY, topic: TOPIC }, undefined, (e) =>
      manyEvents.push(e),
    );
    eq("最终结果上限在 15 条", manyResult.evidence.length, MAX_EVIDENCE);
    eq(
      "推出去的证据条数与最终结果相同（不多不少）",
      only(manyEvents, "evidence").length,
      MAX_EVIDENCE,
    );

    // ④ 心跳。chars 不涨就是诚实的"上游没有新内容"，客户端靠它显示"还在动"
    globalThis.fetch = (async () => sseResponse(modelJson, { chunkSize: 64, gapMs: 2400 })) as typeof fetch;
    const hbEvents: ReviewStreamEvent[] = [];
    await codeOfStream(undefined, hbEvents);
    const beats = only(hbEvents, "progress").map((e) => e.chars);
    check(
      "上游卡住时会发心跳，且 chars 只增不减",
      beats.length > 0 &&
        beats.every((c, i) => i === 0 || c >= beats[i - 1]) &&
        beats[beats.length - 1] > 0,
      beats,
    );

    // ⑤ 上游在开流之前就失败：**一个帧都不许发**。
    //    路由层就是靠这一点决定"回 SSE 还是回一个带真实状态码的 JSON 错误"的，
    //    这条一旦破了，401/429/5xx 就全变成状态码 200 + 一帧 error
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const beforeOpen: ReviewStreamEvent[] = [];
    eq("上游 429 → UPSTREAM_ERROR", await codeOfStream(undefined, beforeOpen), "UPSTREAM_ERROR");
    eq("开流之前失败：一个帧都没发", beforeOpen.length, 0);

    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, headers: { "Content-Type": "text/plain" } })) as typeof fetch;
    const beforeOpen2: ReviewStreamEvent[] = [];
    eq("上游 500 → UPSTREAM_ERROR", await codeOfStream(undefined, beforeOpen2), "UPSTREAM_ERROR");
    eq("上游 500 时同样一个帧都没发", beforeOpen2.length, 0);

    // 缺 key 也发生在开流之前
    delete process.env.DEEPSEEK_API_KEY;
    const noKey: ReviewStreamEvent[] = [];
    eq("缺 API key → MISSING_API_KEY", await codeOfStream(undefined, noKey), "MISSING_API_KEY");
    eq("缺 key 时一个帧都没发", noKey.length, 0);
    process.env.DEEPSEEK_API_KEY = "sk-test-key-not-real";

    // ⑥ 开流**之后**才失败：帧已经发出去了，只能走带内 error。
    //    截断的 JSON 是这类失败里最典型的一种
    globalThis.fetch = (async () => sseResponse(modelJson.slice(0, 150), { chunkSize: 7 })) as typeof fetch;
    const afterOpen: ReviewStreamEvent[] = [];
    eq("截断的模型输出 → BAD_MODEL_OUTPUT", await codeOfStream(undefined, afterOpen), "BAD_MODEL_OUTPUT");
    check("这时已经有帧发出去了（所以只能带内报错）", afterOpen.length > 0, afterOpen.length);

    // 被 max_tokens 截断要给一条能指导行动的话，而不是笼统的"不是合法 JSON"
    globalThis.fetch = (async () =>
      sseResponse('{"summary": "还没写完', { chunkSize: 5, finishReason: "length" })) as typeof fetch;
    const truncatedMessage = await reviewEssayStream({ essay: ESSAY, topic: TOPIC }, undefined, () => undefined)
      .then(() => "NO_ERROR")
      .catch((e: { message?: string }) => e.message ?? "");
    check("截断给出的文案提到 max_tokens 截断", truncatedMessage.includes("截断"), truncatedMessage);

    // 上游一个字符都没吐（只有 [DONE]）：这就是"干净 EOF"在库层的对应物
    globalThis.fetch = (async () => sseResponse("", {})) as typeof fetch;
    const emptyMessage = await reviewEssayStream({ essay: ESSAY, topic: TOPIC }, undefined, () => undefined)
      .then(() => "NO_ERROR")
      .catch((e: { code?: string; message?: string }) => `${e.code}:${e.message ?? ""}`);
    check("上游空内容 → BAD_MODEL_OUTPUT（不是静默成功）", emptyMessage.startsWith("BAD_MODEL_OUTPUT"), emptyMessage);

    // ⑦ 中途取消。让上游卡在最后一片上，再从中断信号断开
    globalThis.fetch = (async (_url: unknown, init: unknown) =>
      sseResponse(modelJson, {
        chunkSize: 16,
        gapMs: 3000,
        signal: (init as { signal?: AbortSignal }).signal,
      })) as typeof fetch;
    const ctrl = new AbortController();
    const cancelling = codeOfStream(ctrl.signal);
    setTimeout(() => ctrl.abort(), 60);
    eq("批改途中断开 → CLIENT_ABORTED（不是 TIMEOUT）", await cancelling, "CLIENT_ABORTED");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
}

// ---------------------------------------------------------------------------
// [13b] 上游错误与"读 body"的超时
//
// 这一节盯的是 chatJSON 的 `!res.ok` 分支和它周围的计时器，两者原来都是零覆盖：
//
//   · `!res.ok` 的响应体要读、状态码要留住。重新包装错误最容易把 status 弄丢，
//     而丢了 status 就分不出"key 过期（401）"和"上游抖动（5xx）"——前者用户改不了
//     但要有人去改配置，后者用户重试一次就好，两条提示必须是不一样的。
//   · 读 body 的定时器原来挂在 fetch 的 finally 上：fetch 一 resolve（响应头到了）
//     就 clearTimeout，而真正会挂住的是后面的 res.text()/res.json()。上游发完响应头
//     再不吐 body 的话，REVIEW_TIMEOUT_MS 形同虚设，请求一路挂到平台 maxDuration
//     被掐断——用户看到一条平台级报错，而额度已经烧了。
//
// 和 [13] 分开写是因为这里的失败模式不一样：[13] 测"谁掐的"，这里测"掐得到不到"。
// ---------------------------------------------------------------------------
async function runUpstreamErrorTests() {
  console.log("\n[13b] 上游错误与读 body 超时");

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalTimeout = process.env.REVIEW_TIMEOUT_MS;
  const originalStall = process.env.REVIEW_STALL_MS;
  process.env.DEEPSEEK_API_KEY = "sk-test-key-not-real";

  /**
   * 安全闸。这几条测的正是"会不会永远不返回"，直接 await 一旦回归就把整个自测
   * 挂死在那儿——连是哪一条坏的都看不出来（后面的 section 一条都不会跑）。
   * 超时就返回一个哨兵值，让断言变红、流程继续。
   */
  const withDeadline = <T>(p: Promise<T>, ms: number, sentinel: T): Promise<T> =>
    Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(sentinel), ms))]);

  /** body 永远不来的响应：响应头立刻到，字节一个也没有 */
  const stalledBodyResponse = (contentType: string): Response => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        // 只在被掐断时才终结这个流——这正是真实上游停住时的样子：
        // 没有数据、没有结束帧，等到我们 abort 才动
        fetchSignals[fetchSignals.length - 1]?.addEventListener(
          "abort",
          () => c.error(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
  };

  /** 每次 fetch 收到的 signal，供上面那个流去接中止 */
  const fetchSignals: AbortSignal[] = [];

  try {
    // ① 401：状态码要留住，文案要走"鉴权失败"那条——那条提示才指得动用户/运维
    //    去查 DEEPSEEK_API_KEY
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"invalid api key"}}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const unauth = await withDeadline(
      chatJSON<Record<string, unknown>>({ system: "s", user: "u" }).then(
        () => null,
        (e: unknown) => e as LLMError,
      ),
      2000,
      null,
    );
    eq("上游 401 → UPSTREAM_ERROR", unauth?.code, "UPSTREAM_ERROR");
    eq("上游 401 → 状态码没有被重新包装时丢掉", unauth?.status, 401);
    check(
      "上游 401 → 文案指向鉴权（而不是笼统的“稍后重试”）",
      (unauth?.message ?? "").includes("鉴权失败"),
      unauth?.message,
    );

    // ② 500：同样留住状态码，但**不能**复用 401 那句——500 不是 key 的问题，
    //    让用户去翻自己的配置是白费功夫
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const boom = await withDeadline(
      chatJSON<Record<string, unknown>>({ system: "s", user: "u" }).then(
        () => null,
        (e: unknown) => e as LLMError,
      ),
      2000,
      null,
    );
    eq("上游 500 → UPSTREAM_ERROR", boom?.code, "UPSTREAM_ERROR");
    eq("上游 500 → 状态码同样留住", boom?.status, 500);
    check("上游 500 不复用 401 的鉴权文案", !(boom?.message ?? "").includes("鉴权失败"), boom?.message);

    // ③ 2xx 但响应体永远不来（T1 的原场景）。断言的关键不是错误码好看，
    //    而是**它在 REVIEW_TIMEOUT_MS 就结束了**——回归时这里会走到安全闸，
    //    也就是"挂到平台的 120 秒上限"，那正是要修掉的行为
    process.env.REVIEW_TIMEOUT_MS = "120";
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      fetchSignals.push((init as { signal: AbortSignal }).signal);
      return stalledBodyResponse("application/json");
    }) as typeof fetch;

    const stalled = await withDeadline(
      chatJSON<Record<string, unknown>>({ system: "s", user: "u" }).then(
        () => null,
        (e: unknown) => e as LLMError,
      ),
      3000,
      null,
    );
    eq("响应头到了但 body 卡住 → 在读 body 期间超时（不是挂到平台上限）", stalled?.code, "TIMEOUT");
    check(
      "→ 报的是总预算那条话术，而不是被吞成“模型返回了空内容”",
      (stalled?.message ?? "").includes("批改超时"),
      stalled?.message,
    );

    // ④ 连接期卡住（T6 的原场景）：上游连响应头都没回。这里**不能**报
    //    "没有返回新内容"——那是生成期的话术，此时一个字都还没轮到你读。
    //    stall 阈值故意设得远小于预算：回归时（stall 在 fetch 之前就启动）
    //    40ms 的 stall 会抢先掐掉，断言立刻变红
    process.env.REVIEW_STALL_MS = "40";
    process.env.REVIEW_TIMEOUT_MS = "120";
    globalThis.fetch = ((_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return new Promise<Response>((_resolve, reject) => {
        const bang = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) return bang();
        signal?.addEventListener("abort", bang, { once: true });
      });
    }) as typeof fetch;

    const ttfb = await withDeadline(
      openChatStream({ system: "s", user: "u" }).then(
        () => null,
        (e: unknown) => e as LLMError,
      ),
      3000,
      null,
    );
    eq("等响应头时卡住 → TIMEOUT", ttfb?.code, "TIMEOUT");
    check(
      "→ 报的是总预算那条，不是“没有返回新内容”（连接期不算停滞）",
      (ttfb?.message ?? "").includes("批改超时"),
      ttfb?.message,
    );

    // ⑤ 反向：**生成期**卡住必须仍然被 stall 掐掉，而且报的是停滞那条话术。
    //    少了这条，把 ④ 做成"干脆不启动 stall 计时器"也能让 ④ 变绿——
    //    那样改的话，上游开始吐字之后卡住就没人管了，一路烧到总预算
    process.env.REVIEW_STALL_MS = "40";
    process.env.REVIEW_TIMEOUT_MS = "5000";
    globalThis.fetch = (async (_url: unknown, init: unknown) => {
      fetchSignals.push((init as { signal: AbortSignal }).signal);
      return stalledBodyResponse("text/event-stream");
    }) as typeof fetch;

    const handle = await withDeadline(
      openChatStream({ system: "s", user: "u" }).then(
        (h) => h,
        () => null,
      ),
      3000,
      null,
    );
    const stallErr = await withDeadline(
      handle === null
        ? Promise.resolve(null)
        : handle.read().then(
            () => null,
            (e: unknown) => e as LLMError,
          ),
      3000,
      null,
    );
    eq("响应头到了、生成期卡住 → TIMEOUT", stallErr?.code, "TIMEOUT");
    check(
      "→ 报的是停滞那条话术（“没有返回新内容”）",
      (stallErr?.message ?? "").includes("没有返回新内容"),
      stallErr?.message,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
    if (originalTimeout === undefined) delete process.env.REVIEW_TIMEOUT_MS;
    else process.env.REVIEW_TIMEOUT_MS = originalTimeout;
    if (originalStall === undefined) delete process.env.REVIEW_STALL_MS;
    else process.env.REVIEW_STALL_MS = originalStall;
  }
}

function finish() {
  console.log(`\n${"=".repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log("=".repeat(46));
  if (failed > 0) process.exit(1);
}

runBodyLimitTests()
  .then(runRateLimitTests)
  .then(runE2E)
  .then(runAbortTest)
  .then(runUpstreamErrorTests)
  .then(runJsonStreamTests)
  .then(runSseTests)
  .then(runStreamParityTests)
  .catch((err) => {
    failed++;
    console.error("\n异步测试抛出异常：", err);
  })
  .then(finish);
