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

import { chatJSON, getModel, LLMError } from "./deepseek";
import { attachLocations } from "./evidence";
import { buildReviewPrompt, MAX_EVIDENCE, minEvidenceFor } from "./prompt";
import { computeStats } from "./text-stats";
import {
  applyCeiling,
  bandForScore,
  clampScore15,
  DIMENSION_MAX,
  enforcedCeilings,
  ESSAY_MAX_SCORE_106,
  isValidBandLevel,
  RUBRIC_VERSION,
  strictestCeiling,
  toScore106,
} from "./rubric";
import {
  DIMENSION_LABEL,
  DIMENSIONS,
  MAX_ESSAY_CHARS,
  MAX_QUOTE_CHARS,
  MAX_TOPIC_CHARS,
  MIN_ESSAY_CHARS,
  type Dimension,
  type DimensionScore,
  type Evidence,
  type EvidenceKind,
  type ReviewRequest,
  type ReviewResult,
  type UpgradeAction,
} from "./types";

// 上限的定义搬到了 lib/types.ts（输入页也要用同一组数字，而那里是客户端
// 可以安全导入的）。这里转出去，保持既有的 import 路径不变。
export { MAX_ESSAY_CHARS, MAX_QUOTE_CHARS, MAX_TOPIC_CHARS, MIN_ESSAY_CHARS };

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
  if (essay.length > MAX_ESSAY_CHARS) {
    throw new LLMError(
      "INVALID_INPUT",
      `作文太长了（${essay.length} 字符），上限 ${MAX_ESSAY_CHARS} 字符。`,
    );
  }

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

function asKind(v: unknown): EvidenceKind {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "strength" || s === "major" || s === "minor") return s;
  return "minor";
}

function asInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

interface RawEvidenceItem {
  id: string;
  dimension: Dimension;
  kind: EvidenceKind;
  quote: string;
  comment: string;
  suggestion?: string;
}

function parseEvidence(v: unknown): RawEvidenceItem[] {
  if (!Array.isArray(v)) return [];

  const out: RawEvidenceItem[] = [];
  let seq = 0;

  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const quote = asString(o.quote);
    // 没有 quote 的证据直接丢弃——证据溯源里没有原文就不成立
    if (quote.length < 2) continue;
    // 超长引文也丢弃。见 MAX_QUOTE_CHARS 的注释：这是性能护栏，
    // 而且定位一个几百字符的"片段"本来也定位不出什么有意义的东西
    if (quote.length > MAX_QUOTE_CHARS) continue;

    const dimension = asDimension(o.dimension);
    if (!dimension) continue;

    const comment = asString(o.comment, "（模型未给出说明）");
    const suggestion = asString(o.suggestion);

    seq += 1;
    out.push({
      id: `e${seq}`,
      dimension,
      kind: asKind(o.kind),
      quote,
      comment,
      suggestion: suggestion || undefined,
    });

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

function parseUpgradePlan(
  v: unknown,
  evidence: Evidence[],
  bandLevel: number,
  targetLevel: number | undefined,
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

    // example 要么 before/after 都有，要么整个丢掉
    let example: UpgradeAction["example"];
    const ex = o.example;
    if (ex && typeof ex === "object") {
      const eo = ex as Record<string, unknown>;
      const before = asString(eo.before);
      const after = asString(eo.after);
      if (before && after) example = { before, after };
    }

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

function kindWeight(kind: EvidenceKind): number {
  if (kind === "major") return 3;
  if (kind === "minor") return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

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
  const warnings: string[] = [];
  const stats = computeStats(input.essay);

  const { system, user } = buildReviewPrompt({
    essay: input.essay,
    topic: input.topic || undefined,
    stats,
    targetBandLevel: input.targetBandLevel,
  });

  const call = await chatJSON<Record<string, unknown>>({ system, user, signal });
  const raw = call.data;

  // 1) 证据：解析 → 定位。先做这步，因为下面的分数校正要看模型标了几条 major
  const parsedEvidence = parseEvidence(raw.evidence);
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
  const rawScore = clampScore15(raw.score15);
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

  // 4) 升档建议
  const upgradePlan = parseUpgradePlan(
    raw.upgradePlan,
    evidence,
    band.level,
    input.targetBandLevel,
  );
  if (upgradePlan.length === 0) {
    warnings.push("模型没有返回升档建议，报告中的建议部分为空。");
  }

  // 5) 总评与优点
  const summary = asString(
    raw.summary,
    `本文评为${band.label}（${band.range[0]}-${band.range[1]} 分区间），折算 ${score106} 分（满分 ${ESSAY_MAX_SCORE_106}）。`,
  );
  const strengths = asStringArray(raw.strengths, 5);

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
    stats: {
      ...stats,
      evidenceCount: evidence.length,
      verifiedCount: evidence.length - unverified.length,
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

/** 只在测试/脚本里用，便于不联网跑通数据流 */
export const __internals = {
  parseEvidence,
  parseDimensionScores,
  parseUpgradePlan,
  computeStats,
  asInt,
};
