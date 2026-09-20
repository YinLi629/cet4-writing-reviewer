/**
 * 四级作文批改的数据契约。
 *
 * 这里定义的类型是三个页面（输入页 / API 路由 / 结果页）之间唯一的约定，
 * 改动前先确认三边都跟得上。
 */

/** 诊断维度。注意：四级作文采用整体评分，维度分只作诊断，不参与总分计算。 */
export type Dimension = "content" | "language" | "organization";

export const DIMENSIONS: Dimension[] = ["content", "language", "organization"];

export const DIMENSION_LABEL: Record<Dimension, string> = {
  content: "内容",
  language: "语言",
  organization: "结构",
};

/** 每条证据的定性：是亮点还是扣分项，扣分项又分轻重。 */
export type EvidenceKind = "strength" | "minor" | "major";

/** 证据定位方式，用来告诉用户这条引用有多可信。 */
export type LocateMethod =
  | "exact" // 原文逐字命中
  | "normalized" // 忽略大小写与空白后命中
  | "fragmented" // 引文含省略号，分段命中
  | "fuzzy" // 模糊匹配，词序/拼写有出入
  | "none"; // 没能在原文中定位

/**
 * 一条证据 = 一处原文 + 一句判断。
 *
 * start/end 不是模型给的，是服务端拿到 quote 后在原文里定位算出来的。
 * 模型只要负责「逐字抄一段原文」，坐标由我们算——这样坐标不会飘，
 * 而且 quote 抄错了能被 verified 字段抓到。
 */
export interface Evidence {
  id: string;
  dimension: Dimension;
  kind: EvidenceKind;
  /** 从学生作文里逐字摘出的片段 */
  quote: string;
  /** 在原文中的字符区间；定位失败时为 null */
  start: number | null;
  end: number | null;
  /** 该引用是否真的在原文中找到了 */
  verified: boolean;
  locateMethod: LocateMethod;
  /** 这条证据说明了什么 */
  comment: string;
  /** 针对性的修改建议；strength 类通常为空 */
  suggestion?: string;
}

/** 升档建议：从当前档到目标档，具体要做什么。 */
export interface UpgradeAction {
  /** 1 优先级最高 */
  priority: number;
  dimension: Dimension;
  /** 一句话说清要做什么 */
  action: string;
  /** 为什么这么做能升档——对应到档次描述的具体差距 */
  rationale: string;
  /** 改写示范 */
  example?: { before: string; after: string };
  /** 关联的证据条目，用于在报告里互相跳转 */
  linkedEvidenceIds: string[];
}

/** 档次。level 越大档次越高。 */
export interface Band {
  level: number;
  label: string;
  /** 15 分制下该档的区间，闭区间 */
  range: [number, number];
  descriptor: string;
}

/** 诊断用的维度分。不计入总分。 */
export interface DimensionScore {
  dimension: Dimension;
  /** 0-5，仅用于给用户看强弱分布 */
  score: number;
  comment: string;
}

export interface ReviewResult {
  /**
   * 学生作文原文。随结果一起返回，这样结果页和 HTML 报告
   * 都能直接用证据的 start/end 在原文上画高亮，不必再传一份。
   */
  essay: string;
  /** 档次判定 */
  band: Band;
  /** 15 分制原始分 */
  score15: number;
  /** 折算到 106.5 分制（作文在 710 分制中的分值） */
  score106: number;
  /** 诊断维度分，不参与总分 */
  dimensionScores: DimensionScore[];
  /** 总评 */
  summary: string;
  /** 做对了什么 */
  strengths: string[];
  /** 证据溯源 */
  evidence: Evidence[];
  /** 升档建议，已按 priority 升序 */
  upgradePlan: UpgradeAction[];
  stats: {
    wordCount: number;
    sentenceCount: number;
    paragraphCount: number;
    /** 由 code 统计、不依赖模型的硬数据 */
    evidenceCount: number;
    /** 定位成功的证据条数 */
    verifiedCount: number;
  };
  /**
   * 报告可信度的提示。例如引用没能定位、证据条数偏少、模型漏返字段。
   * 有内容时结果页会显眼地展示出来——不藏问题。
   */
  warnings: string[];
  meta: {
    model: string;
    elapsedMs: number;
    createdAt: string;
    topic: string;
    /** 批改标准版本，方便日后对比 */
    rubricVersion: string;
  };
}

/** POST /api/review 的请求体 */
export interface ReviewRequest {
  essay: string;
  /** 题目/要求，选填。有的话能判断是否切题 */
  topic?: string;
  /** 目标档次，选填。用于生成"从当前档到目标档"的升档路径 */
  targetBandLevel?: number;
  /** 访问口令。服务端用 REVIEW_ACCESS_CODE 校验，没配就拒绝一切请求。 */
  accessCode?: string;
}

/** POST /api/review 的错误响应 */
export interface ReviewErrorResponse {
  error: string;
  /** 便于前端区分处理 */
  code:
    | "MISSING_API_KEY"
    | "MISSING_ACCESS_CODE"
    | "INVALID_ACCESS_CODE"
    | "INVALID_INPUT"
    | "UPSTREAM_ERROR"
    | "BAD_MODEL_OUTPUT"
    | "TIMEOUT"
    | "UNKNOWN";
}
