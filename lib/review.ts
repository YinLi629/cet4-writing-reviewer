/**
 * 批改编排层。
 *
 * 职责边界很清楚：模型只负责"读懂作文并给出判断"，所有**能被代码确定的事**
 * 都由这里来做，不交给模型：
 *
 *   - 分数 → 档次        查表，不让模型自己报档次名
 *   - 15 分制 → 106.5    算术
 *   - 字数/句数/段数      正则统计
 *   - 证据坐标            在原文中定位（lib/evidence.ts）
 *   - 升档建议排序        按 priority
 *
 * 模型输出一律视为不可信输入，逐字段校验、裁剪、兜底。
 */

import {
  chatJSON,
  getModel,
  LLMError,
  openChatStream,
  parseStreamedJSON,
  type ChatStreamRead,
} from "./deepseek";
import { attachLocations, locateQuote } from "./evidence";
import { scanJsonPrefix, type ScanResult } from "./json-stream";
import { buildReviewPrompt, MAX_EVIDENCE, minEvidenceFor } from "./prompt";
import { computeStats, type TextStats } from "./text-stats";
import { coerceTrainingFocus, TRAINING_FOCUS_DIMENSION } from "./training";
import {
  applyCeiling,
  bandForScore,
  DIMENSION_MAX,
  enforcedCeilings,
  ESSAY_MAX_SCORE_106,
  isValidBandLevel,
  readScore15,
  RUBRIC_VERSION,
  score15Field,
  strictestCeiling,
  toScore106,
} from "./rubric";
import {
  DIMENSION_LABEL,
  DIMENSIONS,
  MAX_QUOTE_CHARS,
  MAX_TOPIC_CHARS,
  MIN_ESSAY_CHARS,
  type Dimension,
  type DimensionScore,
  type Evidence,
  type EvidenceKind,
  type PendingEvidence,
  type ReviewRequest,
  type ReviewResult,
  type ReviewStreamEvent,
  type TrainingFocus,
  type TrainingItem,
  type UpgradeAction,
} from "./types";

// 上限的定义搬到了 lib/types.ts（输入页也要用同一组数字，而那里是客户端
// 可以安全导入的）。这里转出去，保持既有的 import 路径不变。
// 作文没有字数上限，见 lib/types.ts 的说明。
export { MAX_QUOTE_CHARS, MAX_TOPIC_CHARS, MIN_ESSAY_CHARS };

export interface NormalizedInput {
  essay: string;
  topic: string;
  targetBandLevel?: number;
}

export function normalizeInput(body: ReviewRequest): NormalizedInput {
  const essay = typeof body?.essay === "string" ? body.essay.trim() : "";

  if (!essay) {
    throw new LLMError("INVALID_INPUT", "作文内容不能为空。");
  }
  if (essay.length < MIN_ESSAY_CHARS) {
    throw new LLMError(
      "INVALID_INPUT",
      `作文太短了（${essay.length} 字符）。至少要 ${MIN_ESSAY_CHARS} 个字符才能批改。`,
    );
  }
  // 没有上限检查：作文不限字数。拦在这里的只可能是 request-body.ts 的
  // 128 KB 请求体上限，那一步在 JSON.parse 之前就返回 413 了，走不到这儿。

  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (topic.length > MAX_TOPIC_CHARS) {
    throw new LLMError(
      "INVALID_INPUT",
      `题目太长了（${topic.length} 字符），上限 ${MAX_TOPIC_CHARS} 字符。题目只写题干即可，全文请放进作文正文。`,
    );
  }

  return {
    essay,
    topic,
    targetBandLevel: isValidBandLevel(body?.targetBandLevel)
      ? body.targetBandLevel
      : undefined,
  };
}

// 字数/句数/段数的实现放在 lib/text-stats.ts，客户端实时计数器用的是同一份，
// 从这里转出去是为了不破坏已有的 import 路径。
export { computeStats } from "./text-stats";

// ---------------------------------------------------------------------------
// 模型输出的防御性解析
// ---------------------------------------------------------------------------

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function asStringArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .slice(0, max);
}

function asDimension(v: unknown): Dimension | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (DIMENSIONS as string[]).includes(s) ? (s as Dimension) : null;
}

/**
 * 收拢模型给的 `kind`。
 *
 * 非法值（含缺失、大小写混乱之外的各种意外）一律按 `minor` 兜底，**但会带上
 * degraded 标记**。原来也是兜底成 minor，问题不在兜底值，在于兜底是**无声的**：
 * `minor` 同时喂给展示（颜色）和判分——lib/review.ts 的分数上限规则按 major 条数
 * 算——于是一次字段异常会悄悄把"3 条以上严重错误 → 上限 9 分""5 条以上 → 上限 6 分"
 * 整条掐掉，模型的 11 分照旧发出去，报告上看不出任何异常。
 *
 * 为什么兜底成 minor 而不是丢弃：丢弃会让证据条数缩水，进而触发
 * `BAD_MODEL_OUTPUT`（一条证据都没有时）或少一条证据的警告——把一个字段写错
 * 升级成"这次批改失败"，代价不成比例。保留条目 + 降级 + 把这件事说出来，
 * 才是这一处该有的取舍。
 *
 * 归一化逻辑（trim + toLowerCase）保持原样，这是它的超集：`"MAJOR"`、`" major "`
 * 仍然正常识别为 major，不算降级。
 */
export function coerceKind(v: unknown): { kind: EvidenceKind; degraded: boolean } {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "strength" || s === "major" || s === "minor") return { kind: s, degraded: false };
  return { kind: "minor", degraded: true };
}

function asInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export interface RawEvidenceItem {
  id: string;
  dimension: Dimension;
  kind: EvidenceKind;
  /** kind 是兜底来的（模型给的既不是 strength 也不是 major/minor）。见 coerceKind */
  kindDegraded?: boolean;
  quote: string;
  comment: string;
  suggestion?: string;
}

/**
 * 解析单条证据。**流式路径也用这个函数**——两边必须走完全相同的校验和编号，
 * 否则渐进视图里显示的 e1..e9 和最终报告里的 e1..e9 会对不上，
 * 而这种错位在"模型恰好返回正常数量条目"时是看不出来的。
 *
 * @param seq 这是第几条**留下来的**证据，用来生成 id。丢弃的不占号。
 * @returns null 表示这条不合格，应当丢弃。
 */
export function parseEvidenceItem(
  item: unknown,
  seq: number,
): RawEvidenceItem | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;

  const quote = asString(o.quote);
  // 没有 quote 的证据直接丢弃——证据溯源里没有原文就不成立
  if (quote.length < 2) return null;
  // 超长引文也丢弃。见 MAX_QUOTE_CHARS 的注释：这是性能护栏，
  // 而且定位一个几百字符的"片段"本来也定位不出什么有意义的东西
  if (quote.length > MAX_QUOTE_CHARS) return null;

  const dimension = asDimension(o.dimension);
  if (!dimension) return null;

  const comment = asString(o.comment, "（模型未给出说明）");
  const suggestion = asString(o.suggestion);
  const { kind, degraded } = coerceKind(o.kind);

  return {
    id: `e${seq}`,
    dimension,
    kind,
    // 只降级时才写上这个字段，保留路径上不多一个 undefined 键
    ...(degraded ? { kindDegraded: true } : {}),
    quote,
    comment,
    suggestion: suggestion || undefined,
  };
}

function parseEvidence(v: unknown): RawEvidenceItem[] {
  if (!Array.isArray(v)) return [];

  const out: RawEvidenceItem[] = [];

  for (const item of v) {
    const parsed = parseEvidenceItem(item, out.length + 1);
    if (!parsed) continue;
    out.push(parsed);
    if (out.length >= MAX_EVIDENCE) break;
  }

  return out;
}

function parseDimensionScores(
  v: unknown,
  bandLevel: number,
  warnings: string[],
): DimensionScore[] {
  const raw = Array.isArray(v) ? v : [];
  const byDim = new Map<Dimension, DimensionScore>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const dimension = asDimension(o.dimension);
    if (!dimension || byDim.has(dimension)) continue;

    byDim.set(dimension, {
      dimension,
      score: asInt(o.score, 0, DIMENSION_MAX, bandLevel),
      comment: asString(o.comment, "（模型未给出该维度说明）"),
    });
  }

  const missing = DIMENSIONS.filter((d) => !byDim.has(d));
  if (missing.length > 0) {
    warnings.push(
      `模型没有返回 ${missing.map((d) => DIMENSION_LABEL[d]).join("、")} 维度的诊断，报告中这几项为缺省值。`,
    );
    for (const d of missing) {
      byDim.set(d, {
        dimension: d,
        score: Math.min(DIMENSION_MAX, Math.max(0, bandLevel)),
        comment: "模型未返回该维度的诊断。",
      });
    }
  }

  // 固定按 content / language / organization 输出，报告排版才稳定
  return DIMENSIONS.map((d) => byDim.get(d)!);
}

/** 训练项条数上限。报告结尾塞 8 条等于没有重点。 */
const MAX_TRAINING_ITEMS = 3;

/**
 * 规格化模型给的改写示范。
 *
 * 判为无效的四种情况，每种都对应一种模型敷衍的具体方式：
 * - 没给 / 缺字段 / 非字符串 → 干脆没写；
 * - 两端去空白后为空        → 写了个空壳；
 * - **before 与 after 相同** → 写了等于没写。这条最容易漏：字段都在、格式也合法，
 *   报告上看起来是一条正常的示范，但"改写"前后一模一样，学生照着看学不到任何东西；
 * - before 超过 MAX_QUOTE_CHARS(500) → 模型把整段贴了进来。这同时是**性能护栏**，
 *   下面 locateExampleQuote 的模糊匹配是平方量级的。护栏放在这里而不是那边，
 *   是因为这里是纯函数、能被 selftest 直接断言。
 *
 * 返回 undefined 与"没有 example 字段"是**同一件事**——调用方不必区分，
 * 渲染侧统一显示"本条没有改写示范"。
 */
export function coerceExample(
  raw: unknown,
): { before: string; after: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;

  const before = asString(o.before);
  const after = asString(o.after);
  if (!before || !after) return undefined;

  // 改写示范前后一样 = 模型没真的改，等于没写
  if (before === after) return undefined;

  if (before.length > MAX_QUOTE_CHARS) return undefined;

  return { before, after };
}

/**
 * 核查 example.before 是不是真的在原文里——把 example 从"模型说啥是啥"
 * 变成**可证伪**。和证据坐标同一个哲学：坐标不由模型给，由服务端拿引文回原文里
 * 重新找，找不到就如实标出来。
 *
 * ⚠️ **只认 exact / normalized，不能退到 fuzzy。**
 * locateQuote 在找不到逐字命中时会一路退到 fuzzyLocate，那里的阈值是
 * **词重叠 ≥80%**（lib/evidence.ts 的 FUZZY_THRESHOLD）。证据引文通常是一整个
 * 从句，80% 重叠仍有判别力；但升档示范是**短句**，3 个词里中 3 个就算命中——
 * 模型编一句 "I very like"、原文是 "I like very much"，fuzzy 会判成命中，
 * 于是**编造的示范被标成"已验证"**，正好是本功能要抓的那种失效。
 * 所以这里的口径必须比证据那条严。改这一行之前先想清楚代价。
 *
 * 不传 claimed：这里只做"这句话在不在原文里"的事实核查，**不参与高亮区间的分配**，
 * 和证据定位互不影响。同一句在原文里出现多次仍算"在"，所以 ambiguity / hitCount
 * 一律不看。
 */
export function locateExampleQuote(essay: string, before: string): boolean {
  if (!essay || !before) return false;
  const hit = locateQuote(essay, before);
  return hit.method === "exact" || hit.method === "normalized";
}

function parseUpgradePlan(
  v: unknown,
  evidence: Evidence[],
  bandLevel: number,
  targetLevel: number | undefined,
  essay: string,
): UpgradeAction[] {
  const raw = Array.isArray(v) ? v : [];
  const validIds = new Set(evidence.map((e) => e.id));
  const out: UpgradeAction[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const action = asString(o.action);
    if (!action) continue;

    const dimension = asDimension(o.dimension) ?? "language";

    // 规格化和核查是两件事，分开做：**没给**和**编了**是两种不同的失效，
    // 报告上要能分别显示（见 lib/types.ts 上的 exampleMissing / exampleUnverified）
    const example = coerceExample(o.example);
    const exampleUnverified = example ? !locateExampleQuote(essay, example.before) : false;

    // 模型自己给的关联证据：只保留真实存在的 id
    const provided = Array.isArray(o.linkedEvidenceIds)
      ? (o.linkedEvidenceIds.filter(
          (x) => typeof x === "string" && validIds.has(x),
        ) as string[])
      : [];

    const goal =
      targetLevel !== undefined && targetLevel > bandLevel
        ? `升到 ${targetLevel} 档`
        : "往上一档";
    out.push({
      priority: asInt(o.priority, 1, 99, out.length + 1),
      dimension,
      action,
      rationale: asString(o.rationale, `这一项是从 ${bandLevel} 档${goal}的必要条件。`),
      example,
      // 两个标记都必须**可选**：scripts/selftest.ts 里有内联的 UpgradeAction 字面量，
      // 加必填字段会让那份文件整体编不过（不是几条断言变红，是全部失效）
      ...(example ? {} : { exampleMissing: true }),
      ...(exampleUnverified ? { exampleUnverified: true } : {}),
      linkedEvidenceIds: provided,
    });

    if (out.length >= 8) break;
  }

  // 模型没给关联证据的，按维度自动挂上同维度的证据，报告里才能互相跳转
  for (const act of out) {
    if (act.linkedEvidenceIds.length > 0) continue;
    act.linkedEvidenceIds = evidence
      .filter((e) => e.dimension === act.dimension)
      .sort((a, b) => kindWeight(b.kind) - kindWeight(a.kind))
      .slice(0, 3)
      .map((e) => e.id);
  }

  // 去重后按 priority 升序，priority 相同则保持模型给的顺序
  const seen = new Set<string>();
  const deduped = out.filter((a) => {
    const key = `${a.dimension}::${a.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.priority - b.priority);
  // 重排之后把 priority 规整成连续的 1..n，避免出现 1,1,4,7 这种断档
  deduped.forEach((a, i) => {
    a.priority = i + 1;
  });

  return deduped;
}

/**
 * 训练项解析。
 *
 * 模型只给「练什么（focus）+ 为什么（reason）」，练法文案由服务端查表
 * （lib/training.ts 的 TRAINING_PLAYBOOK）。这么切是因为练法要可写断言、措辞统一、
 * 零幻觉，交给模型生成三样都没有；而"这篇最该练什么"非读过这篇作文不能知。
 *
 * 和 parseUpgradePlan 最大的区别：这里**非法即丢**，不学 coerceKind 那样降级兜底。
 * kind 有"最轻的一档"可以兜，兜错只是颜色和严重度偏轻；focus 兜到任何一类都是
 * 给出一整套**错误的练法**，比少一条糟得多。所以认不出来就整条丢。
 * 但纯粹的"写法"差异（大小写、两端空白）会先归一化，不算非法
 * ——见 lib/training.ts 的 coerceTrainingFocus。
 */
function parseTrainingPlan(v: unknown, evidence: Evidence[]): TrainingItem[] {
  const raw = Array.isArray(v) ? v : [];
  const validIds = new Set(evidence.map((e) => e.id));
  const out: TrainingItem[] = [];
  const seen = new Set<TrainingFocus>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const focus = coerceTrainingFocus(o.focus);
    if (!focus) continue;

    // 同一个类别练一次就够，重复说明模型在凑数
    if (seen.has(focus)) continue;
    seen.add(focus);

    // 没有理由的训练项说服不了学生去练，在报告上也只是个孤零零的标签
    const reason = asString(o.reason);
    if (!reason) continue;

    const provided = Array.isArray(o.linkedEvidenceIds)
      ? (o.linkedEvidenceIds.filter(
          (x) => typeof x === "string" && validIds.has(x),
        ) as string[])
      : [];

    out.push({ focus, reason, linkedEvidenceIds: provided });

    // 上限 3：报告结尾塞 8 条等于没有重点，1-3 条才叫"最该练的"
    if (out.length >= MAX_TRAINING_ITEMS) break;
  }

  // 模型没给关联证据的，按 focus 对应的维度自动挂上同维度证据——照抄
  // parseUpgradePlan 的同一套做法，报告里才能从训练项跳回证据卡。
  // filter 会新建数组，所以下面的 sort 原地排序不会动到 evidence 本身
  for (const item of out) {
    if (item.linkedEvidenceIds.length > 0) continue;
    const dim = TRAINING_FOCUS_DIMENSION[item.focus];
    item.linkedEvidenceIds = evidence
      .filter((e) => e.dimension === dim)
      .sort((a, b) => kindWeight(b.kind) - kindWeight(a.kind))
      .slice(0, 3)
      .map((e) => e.id);
  }

  return out;
}

function kindWeight(kind: EvidenceKind): number {
  if (kind === "major") return 3;
  if (kind === "minor") return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 组装最终结果所需的模型调用信息。 */
export interface ModelCallInfo {
  model: string;
  elapsedMs: number;
}

/**
 * 从模型输出组装出最终结果。
 *
 * 为什么要把这一段单独抽出来：流式路径必须复用**完全相同**的后处理。这条链上
 * 任何一处走岔——上限校正的阈值、警告的文案、证据的编号——都会让"流式和非流式
 * 给出同一个结果"这个前提失效。而这恰恰是最难发现的一类偏差：scripts/eval/ 跑的
 * 是下面 reviewEssay 那条非流式的路，它测不到流式这一侧的偏移。
 *
 * @param preParsedEvidence 流式路径已经逐条解析、并已经推送给客户端的证据。
 *   传进来是为了让编号**由构造保证**一致：如果让它在这里重新解析 raw.evidence，
 *   两边的 id 只是碰巧对上，模型多返回一条、或某条引文超长被丢弃，就会错位，
 *   而错位的表现是"渐进视图里的 e5 和最终报告里的 e5 不是同一条"——
 *   从界面上几乎看不出来。非流式路径不传这个参数，行为与从前完全一致。
 */
export function assembleResult(
  input: NormalizedInput,
  stats: TextStats,
  raw: Record<string, unknown>,
  call: ModelCallInfo,
  preParsedEvidence?: RawEvidenceItem[],
): ReviewResult {
  const warnings: string[] = [];

  // 1) 证据：解析 → 定位。先做这步，因为下面的分数校正要看模型标了几条 major
  const parsedEvidence = preParsedEvidence ?? parseEvidence(raw.evidence);
  if (parsedEvidence.length === 0) {
    throw new LLMError(
      "BAD_MODEL_OUTPUT",
      "模型没有返回任何可用的原文证据，无法生成批改报告。请重试一次。",
    );
  }
  const evidence = attachLocations(input.essay, parsedEvidence);

  const unverified = evidence.filter((e) => !e.verified);
  if (unverified.length > 0) {
    warnings.push(
      `有 ${unverified.length} 条引用没能在原文中定位（模型可能改写了原文），这些条目在报告里已标出，请以原文为准。`,
    );
  }

  // 定位成功、但有歧义的条目：**这是最需要主动说出来的一类**。
  // 未定位是响亮失败（报告里有红字），而"定位了但可能不是那一处"没有任何线索
  // ——徽章上照样写着"逐字命中原文"。不主动说，用户就完全看不出来。
  const ambiguous = evidence.filter((e) => e.ambiguity);
  if (ambiguous.length > 0) {
    const multiple = ambiguous.filter((e) => e.ambiguity === "multiple").length;
    warnings.push(
      `有 ${ambiguous.length} 条引用在原文里能找到不止一处相近的匹配（其中 ${multiple} 条是同一段文字出现多次），` +
        `高亮落在哪一处是按上下文推断的。引用太短或太常见时会出现这种情况，请对照原文确认。`,
    );
  }

  // kind 兜底：模型给的严重程度不是三个合法值之一，按最轻的 minor 处理了。
  // 必须说出来，因为分数上限规则按 major 条数算——静默降级会连带把上限规则
  // 一起废掉，报告看起来完全正常，实际分数没有经过校正。
  const degradedKinds = evidence.filter((e) => e.kindDegraded).length;
  if (degradedKinds > 0) {
    warnings.push(
      `有 ${degradedKinds} 条证据的严重程度字段模型没有给对（既不是亮点也不是小错/严重错误），已按“小错”处理。` +
        `这会让“严重错误条数”偏少，本报告的分数上限校正可能没有完全生效。`,
    );
  }
  const evidenceMin = minEvidenceFor(stats);
  if (evidence.length < evidenceMin) {
    warnings.push(
      `本次只取到 ${evidence.length} 条证据（这篇作文建议至少 ${evidenceMin} 条），覆盖可能不够全面。`,
    );
  }

  // 重复引文：**同一维度内**同一条引文被用在多条证据里，等于用一句话充了两条。
  // 只按维度内查重，不跨维度——一句话同时是"内容上点题"和"结构上没分段"的
  // 证据是合理的（c3/c9 就是这样），跨维度复用在评测里 3 次全部是这种正常情况，
  // 警告只会在假阳性上响，反而会让用户学会忽略警告。
  const quoteSeen = new Set<string>();
  let duplicated = 0;
  for (const e of evidence) {
    const key = `${e.dimension}::${e.quote.trim()}`;
    if (quoteSeen.has(key)) duplicated += 1;
    else quoteSeen.add(key);
  }
  if (duplicated > 0) {
    warnings.push(
      `有 ${duplicated} 条证据在同一维度里重复引用了同一段原文，等同于用一句话充了两条。`,
    );
  }

  // 2) 维度诊断（不参与总分）。先按模型给的原分算出临时档次，只用于给缺失的
  //    维度补一个兜底分值，避免"档次依赖维度分、维度分又依赖档次"的循环。
  const rawScore = readScore15(raw.score15);
  // score15 是**全文唯一的计分来源**，而 readScore15 会把读不出来的值收成 0 分。
  // 0 分是个合法分数，下游看不出区别，所以这里必须自己把异常说出来：
  // 否则模型把分数写成写不动的值时，用户拿到的是一份"看起来完全正常、但 0 分 0 档"
  // 的报告——这正是这一轮要修的那个静默出错。
  if (score15Field(raw.score15) === "unusable") {
    // 把收到的值截断后附上：不带的话，服务端日志里只剩一句"字段不可用"，
    // 排不出是模型漏了字段还是给了个字符串。截断是为了防一个超长字符串
    // 把这条警告撑成一整屏
    const shown =
      typeof raw.score15 === "string" ? raw.score15.slice(0, 40) : String(raw.score15);
    warnings.push(
      `模型没有给出可用的总分（score15 字段缺失或不是数字，收到的是「${shown}」）。` +
        `本报告的分数按 0 分处理，仅供参考，建议重试一次以获取有效分数。`,
    );
  }
  const dimensionScores = parseDimensionScores(
    raw.dimensionScores,
    bandForScore(rawScore).level,
    warnings,
  );
  const dimScore = (d: Dimension) =>
    dimensionScores.find((x) => x.dimension === d)?.score ?? null;

  // 3) 分数校正：模型给的分不能突破它自己的诊断所允许的上限。
  //    规则见 lib/rubric.ts 的 CEILING_RULES——每条都能从官方档次描述推出来。
  const ceiling = strictestCeiling(
    enforcedCeilings({
      majorCount: evidence.filter((e) => e.kind === "major").length,
      organizationScore: dimScore("organization"),
      contentScore: dimScore("content"),
      wordCount: stats.wordCount,
      paragraphCount: stats.paragraphCount,
    }),
  );
  const score15 = applyCeiling(rawScore, ceiling);
  if (ceiling && rawScore > ceiling.maxScore) {
    warnings.push(
      `分数已由系统校正：模型给出 ${rawScore} 分，但它自己的诊断不支撑这个分数——${ceiling.reason}` +
        `分数已降为 ${score15} 分。`,
    );
  }

  const band = bandForScore(score15);
  const score106 = toScore106(score15);

  // 4) 升档建议。essay 要传进去，否则没法核查 example.before 在不在原文里
  const upgradePlan = parseUpgradePlan(
    raw.upgradePlan,
    evidence,
    band.level,
    input.targetBandLevel,
    input.essay,
  );
  if (upgradePlan.length === 0) {
    warnings.push("模型没有返回升档建议，报告中的建议部分为空。");
  }

  // 模型给的 before 在原文里找不到，说明它自己造了句子。和证据坐标同一套哲学：
  // 抄错要能被抓到，而不是画一个看起来精确、实际对不上原文的示范。
  //
  // ⚠️ 这条 warning **必须在这里拼**，不能在 parseUpgradePlan 里：那个函数收不到
  // warnings，而且它是本函数的 warnings 已经构建完之后才被调用的。
  // 另外 exampleMissing **不产生** warning——没给示范是正常降级（纯 organization
  // 的建议本就落不到单句上），不是故障。见 lib/types.ts。
  const fabricated = upgradePlan.filter((a) => a.exampleUnverified).length;
  if (fabricated > 0) {
    warnings.push(
      `有 ${fabricated} 条升档建议的改写示范没能在原文中找到（模型可能自己造了句子），这些示范仅供参考，请以原文为准。`,
    );
  }

  // 5) 总评与优点
  const summary = asString(
    raw.summary,
    `本文评为${band.label}（${band.range[0]}-${band.range[1]} 分区间），折算 ${score106} 分（满分 ${ESSAY_MAX_SCORE_106}）。`,
  );
  const strengths = asStringArray(raw.strengths, 5);

  // 6) 训练区。模型只给「练什么 + 为什么」，练法由服务端查表（lib/training.ts）。
  //    整节为空是**正常**的——说明这篇没有明显反复出现的毛病，不是故障，
  //    所以既不报 warning，报告里也不显示一个空壳。
  const trainingPlan = parseTrainingPlan(raw.trainingPlan, evidence);

  return {
    essay: input.essay,
    band,
    score15,
    score106,
    dimensionScores,
    summary,
    strengths,
    evidence,
    upgradePlan,
    // 只在非空时挂上去：空数组和 undefined 对渲染侧是同一件事（都整节不显示），
    // 但省掉一个字段能让新旧报告的形状一致
    ...(trainingPlan.length > 0 ? { trainingPlan } : {}),
    stats: {
      ...stats,
      evidenceCount: evidence.length,
      verifiedCount: evidence.length - unverified.length,
      // 子计数，不参与"已定位/未定位"的二分：verifiedCount 的算法一个字没动
      ambiguousCount: ambiguous.length,
    },
    warnings,
    meta: {
      model: call.model || getModel(),
      elapsedMs: call.elapsedMs,
      createdAt: new Date().toISOString(),
      topic: input.topic,
      rubricVersion: RUBRIC_VERSION,
    },
  };
}

/**
 * @param signal 调用方的中止信号（路由传的是 request.signal）。用户关掉标签页
 *   或刷新时，模型调用会被一起中止，不再为一个没人在等的响应继续计费。
 *   自测直接调用时可以不传。
 */
export async function reviewEssay(
  body: ReviewRequest,
  signal?: AbortSignal,
): Promise<ReviewResult> {
  const input = normalizeInput(body);
  const stats = computeStats(input.essay);
  const { system, user } = buildReviewPrompt({
    essay: input.essay,
    topic: input.topic || undefined,
    stats,
    targetBandLevel: input.targetBandLevel,
  });

  const call = await chatJSON<Record<string, unknown>>({ system, user, signal });
  return assembleResult(input, stats, call.data, {
    model: call.model,
    elapsedMs: call.elapsedMs,
  });
}

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

/**
 * 心跳间隔。
 *
 * 2 秒：足够让中间的代理不把连接判成空闲（nginx 默认 60 秒、多数 CDN 更短），
 * 又不至于把帧刷得太碎。这个帧和进度显示是同一件事——见下面的 emit。
 */
const PROGRESS_INTERVAL_MS = 2000;

/** 一条已定稿、但坐标还没算出来的证据 → 可以立刻展示的形态。 */
function toPendingEvidence(e: RawEvidenceItem): PendingEvidence {
  return {
    pending: true,
    id: e.id,
    dimension: e.dimension,
    kind: e.kind,
    // kind 是否兜底来的，在解析时就已经定了、也不依赖整批引文，所以这里照传。
    // 漏传的话，渐进视图里那个"严重程度未标注"的虚线提示会等到最终结果才出现，
    // 而流式视图正是用户盯得最久的那一屏
    ...(e.kindDegraded ? { kindDegraded: true } : {}),
    quote: e.quote,
    comment: e.comment,
    suggestion: e.suggestion,
  };
}

/**
 * 流式批改：一边从模型读，一边把已经能展示的部分推出去，最后返回权威结果。
 *
 * 和 reviewEssay 的关系：校验、统计、提示词、后处理全都共用同一份代码，
 * 唯一的区别是"取模型输出"那一段换成了流式读取。所以同样输入下两个函数的返回值
 * 必须一模一样——自测里有一条专门盯这个（canned 输出喂两遍，deepEqual）。
 *
 * 发帧的三条硬规矩（类型定义在 lib/types.ts 的 ReviewStreamEvent 上）：
 * 不发 score15、不发 warnings、不发 essay。前两条是重复的：warnings 里有一条
 * "分数已由系统校正：模型给出 N 分"，会把刻意押后的原始分泄露出去。
 *
 * 时序上的约定：**上游打开之前不发任何事件**（成功时第一条一定是 meta），
 * 失败时则一个事件都不发、直接抛 LLMError。调用方（app/api/review/route.ts）
 * 靠这条约定决定回 SSE 还是回一个带真实状态码的 JSON 错误。
 *
 * @param onEvent 每产生一个事件就调一次。它的异常会被吞掉——推给客户端失败
 *   （比如对方已经断开）不该让服务端自己崩掉。
 */
export async function reviewEssayStream(
  body: ReviewRequest,
  signal: AbortSignal | undefined,
  onEvent: (event: ReviewStreamEvent) => void,
): Promise<ReviewResult> {
  const input = normalizeInput(body);
  const stats = computeStats(input.essay);
  const { system, user } = buildReviewPrompt({
    essay: input.essay,
    topic: input.topic || undefined,
    stats,
    targetBandLevel: input.targetBandLevel,
  });

  const emit = (event: ReviewStreamEvent): void => {
    try {
      onEvent(event);
    } catch (err) {
      console.error("[review] 推送流式事件失败（客户端可能已断开）：", err);
    }
  };

  /** 模型输出的累积文本。既用来抽增量，也是最终解析的输入。 */
  let buffer = "";
  /**
   * 已经处理过的顶层成员数、证据条数。
   * 扫描结果的长度单调不减（见 lib/json-stream.ts），所以记住"处理到哪了"
   * 就能取出增量，不需要扫描器自己维护状态。
   */
  let scannedMembers = 0;
  let scannedEvidence = 0;
  const keptEvidence: RawEvidenceItem[] = [];
  const seenDimensions = new Set<Dimension>();

  const drainDimensions = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const dimension = asDimension(o.dimension);
      if (!dimension || seenDimensions.has(dimension)) continue;

      // 刻意不用 parseDimensionScores：那个函数会按 DIMENSIONS 顺序重排，
      // 还会给缺的维度补一个按档次猜出来的分值。流式期间补分等于编数字，
      // 所以只推模型真给了分的维度，剩下的由界面显示"生成中"。
      const raw = typeof o.score === "number" ? o.score : Number(o.score);
      if (!Number.isFinite(raw)) continue;
      seenDimensions.add(dimension);

      emit({
        type: "dimensionScores",
        value: [
          {
            dimension,
            score: asInt(raw, 0, DIMENSION_MAX, 0),
            comment: asString(o.comment, "（模型未给出该维度说明）"),
          },
        ],
      });
    }
  };

  const drainMembers = (scan: ScanResult): void => {
    while (scannedMembers < scan.members.length) {
      const member = scan.members[scannedMembers];
      scannedMembers += 1;

      // 白名单。score15 和 upgradePlan 有意不在其中：前者要等上限校正，
      // 后者依赖校正之后的档次。
      if (member.key === "summary") {
        const value = asString(member.value);
        if (value) emit({ type: "summary", value });
      } else if (member.key === "strengths") {
        const value = asStringArray(member.value, 5);
        if (value.length > 0) emit({ type: "strengths", value });
      } else if (member.key === "dimensionScores") {
        drainDimensions(member.value);
      }
    }
  };

  const drainEvidence = (scan: ScanResult): void => {
    while (scannedEvidence < scan.evidence.length) {
      const item = scan.evidence[scannedEvidence];
      scannedEvidence += 1;

      // 到了上限就不再新增，但**仍然继续消耗**——否则后面的条目会被反复重试。
      // 这一步是必须的：模型给出 18 条时，渐进视图不能先显示 18 张卡、
      // 最后报告里只有 15 张。
      if (keptEvidence.length >= MAX_EVIDENCE) continue;

      // 和 parseEvidence 用同一个解析器、同一套编号规则。
      // keptEvidence 最后会原样交给 assembleResult，所以渐进视图里的 id
      // 与最终报告里的 id 是同一批，不是"碰巧对上"。
      const parsed = parseEvidenceItem(item, keptEvidence.length + 1);
      if (!parsed) continue;
      keptEvidence.push(parsed);
      emit({ type: "evidence", value: toPendingEvidence(parsed) });
    }
  };

  const onDelta = (text: string): void => {
    buffer += text;
    try {
      const scan = scanJsonPrefix(buffer);
      drainMembers(scan);
      drainEvidence(scan);
    } catch (err) {
      // 扫描器只负责展示，它的异常绝不能升级成错误响应：
      // 最终结果走的是 parseStreamedJSON 那条路，不经过这里。
      console.error("[review] 增量扫描失败，本次跳过（不影响最终结果）：", err);
    }
  };

  let read!: ChatStreamRead;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  try {
    // 上游没打开之前**一个事件都不能发**。路由层拿"有没有收到第一个事件"
    // 来决定这次请求该回 SSE 还是该回一个带真实状态码的 JSON 错误
    // （上游 401/403/5xx、缺 key 都发生在这一步之前），所以顺序是有约束的：
    // openChatStream 先 resolve，然后才轮到 meta。
    //
    // 顺带一提，这里也保证了 meta 只会出现一次、且永远排在第一个——
    // 增量回调只从 handle.read() 里发出来，而 read() 在 meta 之后才调用。
    const handle = await openChatStream({ system, user, signal, onDelta });

    emit({
      type: "meta",
      stats: {
        wordCount: stats.wordCount,
        sentenceCount: stats.sentenceCount,
        paragraphCount: stats.paragraphCount,
      },
      model: getModel(),
      topic: input.topic,
      startedAt: new Date().toISOString(),
    });

    // 心跳同时就是进度显示。chars 不涨就是诚实的"上游没有新内容"，
    // 所以这里没有、也不该有百分比——总量未知。
    progressTimer = setInterval(() => {
      emit({ type: "progress", chars: buffer.length });
    }, PROGRESS_INTERVAL_MS);

    read = await handle.read();
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  const raw = parseStreamedJSON<Record<string, unknown>>(read);

  // 收尾再扫一遍。最后一个顶层成员要等外层 } 才定稿，而那个 } 就在最后一批
  // 增量里，所以通常上一步已经推完了；但扫描器抛过异常或推送失败时这里能补上。
  // 计数器让它是幂等的。
  try {
    const scan = scanJsonPrefix(buffer);
    drainMembers(scan);
    drainEvidence(scan);
  } catch (err) {
    console.error("[review] 收尾扫描失败（不影响最终结果）：", err);
  }

  const result = assembleResult(
    input,
    stats,
    raw,
    { model: read.model, elapsedMs: read.elapsedMs },
    keptEvidence,
  );

  emit({ type: "result", result });
  return result;
}

/** 只在测试/脚本里用，便于不联网跑通数据流 */
export const __internals = {
  parseEvidence,
  parseEvidenceItem,
  parseDimensionScores,
  parseUpgradePlan,
  parseTrainingPlan,
  assembleResult,
  computeStats,
  asInt,
  coerceKind,
  coerceExample,
  locateExampleQuote,
};
