/**
 * 离线自测。不联网、不需要 API key，只验证"能被代码确定"的那部分逻辑：
 * 证据定位、档次查表、分数折算、高亮切分、HTML 转义、模型输出的防御性解析。
 *
 * 跑法： npm run selftest
 */

import { locateQuote, attachLocations } from "../lib/evidence";
import { segmentEssay } from "../lib/highlight";
import { METHOD_LABEL } from "../lib/labels";
import { buildReportHtml, escapeHtml, renderHighlightedEssay } from "../lib/report-html";
import { bandForScore, clampScore15, toScore106, tierGapFor } from "../lib/rubric";
import { __internals, normalizeInput, reviewEssay } from "../lib/review";
import { computeStats } from "../lib/text-stats";
import type { ReviewResult } from "../lib/types";

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

// 省略号分段
const frag = locateQuote(ESSAY, "I am a student want to join ... I am very exciting.");
eq("省略号分段：method", frag.method, "fragmented");
check("省略号分段：跨越正确区间", frag.start === 0 && frag.end! > 100, frag);

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
check("超长作文被拒", bad("a".repeat(9000)) !== null);
check("正常作文通过", bad("This is a long enough essay to be graded properly.") === null);

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
console.log("\n[9] 端到端：批改编排（mock 掉模型调用，不需要 API key）");

/**
 * 这一段验证的是整条关键路径：构建 prompt → 调模型 → 解析 → 证据定位 →
 * 查表定档 → 折算分 → 升档建议关联证据。把 fetch 换掉就能离线跑通，
 * 这样 CI 上不配 key 也能测。
 */
async function runE2E() {
  const E2E_ESSAY =
    "Dear Sir, I am a student want to join your volunteer program. " +
    "I very like help other people. Last year I also join a activity about clean the park. " +
    "I think I have many advantage.";

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

    check("meta 记录了模型名", Boolean(result.meta.model), result.meta.model);
    check("meta 记录了耗时", typeof result.meta.elapsedMs === "number");
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

runE2E()
  .catch((err) => {
    failed++;
    console.error("\n端到端测试抛出异常：", err);
  })
  .then(finish);
