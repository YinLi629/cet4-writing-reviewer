/**
 * 离线自测。不联网、不需要 API key，只验证"能被代码确定"的那部分逻辑：
 * 证据定位、档次查表、分数折算、高亮切分、HTML 转义、模型输出的防御性解析。
 *
 * 跑法： npm run selftest
 */

import { getAccessCode, hasAccessCode, verifyAccessCode } from "../lib/access";
import { locateQuote, attachLocations } from "../lib/evidence";
import { segmentEssay } from "../lib/highlight";
import { METHOD_LABEL } from "../lib/labels";
import { clientKeyFrom, configFromEnv, createRateLimiter } from "../lib/rate-limit";
import { buildReportHtml, escapeHtml, renderHighlightedEssay } from "../lib/report-html";
import { MAX_BODY_BYTES, readJsonBody } from "../lib/request-body";
import { bandForScore, clampScore15, toScore106, tierGapFor } from "../lib/rubric";
import { __internals, normalizeInput, reviewEssay } from "../lib/review";
import { computeStats } from "../lib/text-stats";
import { MAX_ESSAY_CHARS, MAX_QUOTE_CHARS, MAX_TOPIC_CHARS, type ReviewResult } from "../lib/types";

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
  .catch((err) => {
    failed++;
    console.error("\n异步测试抛出异常：", err);
  })
  .then(finish);
