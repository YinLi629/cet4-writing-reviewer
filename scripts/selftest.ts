/**
 * 离线自测。不联网、不需要 API key，只验证"能被代码确定"的那部分逻辑：
 * 证据定位、档次查表、分数折算、高亮切分、HTML 转义、模型输出的防御性解析。
 *
 * 跑法： npm run selftest
 */

import { getAccessCode, hasAccessCode, verifyAccessCode } from "../lib/access";
import { locateQuote, attachLocations } from "../lib/evidence";
import { segmentEssay } from "../lib/highlight";
import { scanJsonPrefix, type ScanResult, type ScannedMember } from "../lib/json-stream";
import { METHOD_LABEL } from "../lib/labels";
import { MAX_EVIDENCE } from "../lib/prompt";
import { clientKeyFrom, configFromEnv, createRateLimiter } from "../lib/rate-limit";
import { buildReportHtml, escapeHtml, renderHighlightedEssay } from "../lib/report-html";
import { MAX_BODY_BYTES, readJsonBody } from "../lib/request-body";
import {
  applicableCeilings,
  applyCeiling,
  bandForScore,
  CEILING_RULE_TABLE,
  clampScore15,
  enforcedCeilings,
  strictestCeiling,
  toScore106,
  tierGapFor,
  type CeilingContext,
} from "../lib/rubric";
import { __internals, normalizeInput, reviewEssay, reviewEssayStream } from "../lib/review";
import { createSseFrameParser, encodeSseFrame, SSE_RESPONSE_HEADERS } from "../lib/sse";
import { computeStats } from "../lib/text-stats";
import {
  MAX_ESSAY_CHARS,
  MAX_QUOTE_CHARS,
  MAX_TOPIC_CHARS,
  type ReviewResult,
  type ReviewStreamEvent,
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
check("超长作文被拒", bad("a".repeat(MAX_ESSAY_CHARS + 1)) !== null);
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
    { dimension: "organization", action: "加衔接词", rationale: "r", example: { before: "a", after: "b" } },
    { priority: 1, dimension: "language", action: "", rationale: "空 action 应被丢弃" },
  ],
  [
    { id: "e1", dimension: "language", kind: "major", quote: "q", comment: "c", start: 0, end: 1, verified: true, locateMethod: "exact" },
  ],
  3,
  undefined,
);
eq("空 action 被丢弃、重复被去重", plan.length, 3);
eq("priority 被规整为连续的 1..n", plan.map((p) => p.priority), [1, 2, 3]);
check(
  "未指定关联证据的会自动挂同维度证据",
  plan.find((p) => p.dimension === "language")!.linkedEvidenceIds.includes("e1"),
  plan,
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
function runRateLimitTests() {
  console.log("\n[11] 限流与口令锁定");

  // 冻结的时间轴，避免测试受真实时钟影响
  const T0 = 1_000_000;
  const cfg = {
    reviewLimit: 3,
    reviewWindowMs: 1000,
    maxFailures: 3,
    lockoutMs: 5000,
    failDelayMs: 0,
  };

  const rl = createRateLimiter(cfg);
  check("未超限：第 1 次放行", rl.checkReview("a", T0).allowed);
  check("未超限：第 2 次放行", rl.checkReview("a", T0 + 1).allowed);
  check("未超限：第 3 次放行", rl.checkReview("a", T0 + 2).allowed);

  const denied = rl.checkReview("a", T0 + 3);
  check("超出上限：第 4 次被拒", !denied.allowed);
  check(
    "被拒时给出剩余等待时长",
    denied.retryAfterMs > 0 && denied.retryAfterMs <= cfg.reviewWindowMs,
    denied,
  );

  check("不同 IP 互不影响", rl.checkReview("b", T0 + 3).allowed);
  // 最老的那次（T0）滑出窗口后，腾出一个名额
  check("窗口滑过后恢复放行", rl.checkReview("a", T0 + 1001).allowed);

  // 不限制时永远放行
  const unlimited = createRateLimiter({ ...cfg, reviewLimit: 0 });
  for (let i = 0; i < 100; i++) unlimited.checkReview("a", T0 + i);
  check("reviewLimit = 0 表示不限", unlimited.checkReview("a", T0 + 100).allowed);

  // 口令失败锁定
  const lock = createRateLimiter(cfg);
  check("初始未锁定", lock.lockState("k", T0).allowed);
  lock.recordFailure("k", T0);
  lock.recordFailure("k", T0 + 1);
  check("未达上限仍可尝试", lock.lockState("k", T0 + 2).allowed);

  lock.recordFailure("k", T0 + 2);
  // 锁定从"第 maxFailures 次失败那一刻"起算，也就是 T0+2
  const lockUntil = T0 + 2 + cfg.lockoutMs;
  const locked = lock.lockState("k", T0 + 3);
  check("达到失败上限：锁定", !locked.allowed);
  eq("锁定时长正确", locked.retryAfterMs, lockUntil - (T0 + 3));

  // 锁定期间继续猜不会把锁续期（否则伪造 IP 的人可以把某个 IP 永久锁死）
  lock.recordFailure("k", T0 + 100);
  eq(
    "锁定期间继续失败不会延长锁定",
    lock.lockState("k", T0 + 101).retryAfterMs,
    lockUntil - (T0 + 101),
  );
  check("锁定到期后恢复", lock.lockState("k", T0 + 5003).allowed);

  // 成功一次就清空失败计数
  lock.recordFailure("k", T0 + 6000);
  lock.recordFailure("k", T0 + 6001);
  lock.recordSuccess("k");
  lock.recordFailure("k", T0 + 6002);
  lock.recordFailure("k", T0 + 6003);
  check("成功后失败计数清零（重新数满才锁）", lock.lockState("k", T0 + 6004).allowed);

  // 不同 key 的锁定互不影响
  check("锁定是按 key 隔离的", lock.lockState("other", T0 + 6004).allowed);

  // Map 必须有机会性清理，否则换 IP 灌请求会把内存撑爆——
  // 那就成了"限流器自己变成漏洞"
  const sweeper = createRateLimiter({ ...cfg, reviewLimit: 5, reviewWindowMs: 1000 });
  for (let i = 0; i < 500; i++) sweeper.checkReview(`ip-${i}`, T0);
  for (let i = 0; i < 300; i++) sweeper.checkReview(`later-${i}`, T0 + 10_000);
  check(
    "过期记录被清理（不会无限增长，一共进过 800 个 key）",
    sweeper.size() < 400,
    sweeper.size(),
  );

  // 环境变量：非法值回落到默认值，否则一个手滑的配置就能让站点拒绝所有请求
  const savedLimit = process.env.REVIEW_RATE_LIMIT_PER_HOUR;
  const savedAttempts = process.env.ACCESS_CODE_MAX_ATTEMPTS;
  process.env.REVIEW_RATE_LIMIT_PER_HOUR = "not-a-number";
  eq("非法环境变量回落默认值", configFromEnv().reviewLimit, 15);
  process.env.REVIEW_RATE_LIMIT_PER_HOUR = "42";
  eq("合法环境变量生效", configFromEnv().reviewLimit, 42);
  process.env.ACCESS_CODE_MAX_ATTEMPTS = "-1";
  eq("负数环境变量回落默认值", configFromEnv().maxFailures, 5);
  if (savedLimit === undefined) delete process.env.REVIEW_RATE_LIMIT_PER_HOUR;
  else process.env.REVIEW_RATE_LIMIT_PER_HOUR = savedLimit;
  if (savedAttempts === undefined) delete process.env.ACCESS_CODE_MAX_ATTEMPTS;
  else process.env.ACCESS_CODE_MAX_ATTEMPTS = savedAttempts;

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
  .then(runJsonStreamTests)
  .then(runSseTests)
  .then(runStreamParityTests)
  .catch((err) => {
    failed++;
    console.error("\n异步测试抛出异常：", err);
  })
  .then(finish);
