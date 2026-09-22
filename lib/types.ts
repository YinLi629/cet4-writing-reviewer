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
 * 定位的**歧义**：匹配上了，但不确定是不是模型想指的那一处。
 *
 * 和 LocateMethod 是两个正交的维度，不能互相顶替：
 * locateMethod 回答"**怎么**匹配上的"（逐字/归一化/模糊），
 * 这一位回答"命中的**是不是那一处**"。
 *
 * 为什么必须单开一位：一条短引文（"he"、"I like sports"）在原文里出现两次时，
 * 定位代码取走第一处、返回 method: "exact"，报告上带着"逐字命中原文"的徽章
 * 高亮到**另一句**上——"抄错了"是会响亮失败的（verified: false），
 * 这种是**装作成功**，用户没有任何线索。所以设计目标是让不确定变得可见，
 * 而不是一律判失败。
 *
 * `multiple`：原文里有多处同样匹配，`hitCount` 是候选处数。
 * `approximate`：模糊匹配（词重叠 ≥80%）命中的，落点本身只是近似。
 */
export type AmbiguityReason = "multiple" | "approximate";

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
  /**
   * 定位带有不确定性时的原因；确定无疑时为 undefined。
   * 渲染侧统一写成 `e.ambiguity ?? "none"`，别去判 undefined。
   */
  ambiguity?: AmbiguityReason;
  /** 匹配上的候选处数（含被选中的那处）。只在 ambiguity 为 multiple 时有值 */
  hitCount?: number;
  /**
   * `kind` 不是 strength/major/minor 三者之一，已按 minor 兜底。
   *
   * 为什么要留这个标记：`kind` 同时喂给展示（颜色）和判分（按 major 条数算的
   * 分数上限），静默降级会让一次字段异常同时污染两边——本该压到 6 分的报告
   * 照旧发出 11 分，而报告上看不出任何异常。见 lib/review.ts 的 coerceKind。
   */
  kindDegraded?: boolean;
  /** 这条证据说明了什么 */
  comment: string;
  /** 针对性的修改建议；strength 类通常为空 */
  suggestion?: string;
}

/**
 * 还没定位的候选证据：流式批改时引文一写完就能给用户看，但坐标算不出来。
 *
 * 为什么算不出来：lib/evidence.ts 的 locateAllEvidence 会把引文按长度从长到短
 * 排序，并维护一组 claimed 区间来避免高亮互相重叠。也就是说**某一条引文的最终
 * 坐标取决于整批引文**，在证据没到齐之前它不是一个"未知的值"，而是"还没有定义"。
 *
 * 刻意做成独立的类型、而不是给 Evidence 加一个 pending 标志位：加标志位的话
 * `verified: false` 会被读成"这条没能定位"，而事实只是"还没开始定位"。
 * 这里干脆不带 start/end/verified/locateMethod 这四个字段，
 * 于是将来任何代码都不可能从一个还在定位的条目上误读出一个"失败"来。
 */
export interface PendingEvidence {
  pending: true;
  id: string;
  dimension: Dimension;
  kind: EvidenceKind;
  /**
   * `kind` 是兜底来的。见 Evidence 上的同名字段。
   *
   * 和 start/verified 那几个不一样：它**不依赖整批引文**，解析这一条的时候就定了，
   * 所以流式期间就该显示出来，不必等到最后。
   */
  kindDegraded?: boolean;
  quote: string;
  comment: string;
  suggestion?: string;
}

/** EvidenceList 能渲染的两种条目：已定位的、还在定位的。 */
export type EvidenceListItem = Evidence | PendingEvidence;

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
  /**
   * 模型没给出**可用**的 example（压根没给，或给了但被 coerceExample 判为无效）。
   *
   * 为什么要标出来而不是静默留白：报告上"这里空着"和"模型没给"长得一模一样，
   * 用户分不清是模型偷懒还是渲染坏了。标出来，提示词的失效才看得见。
   * 注意它**不产生 warning**——没给示范是正常降级（纯 organization 的建议本就
   * 落不到单句上），不是故障。见 lib/review.ts 的 assembleResult。
   */
  exampleMissing?: boolean;
  /**
   * example.before 没能在原文里定位到——模型很可能自己造了一句原文里没有的话。
   *
   * 这是把 example 从"模型说啥是啥"变成**可证伪**的关键：和证据坐标同一个哲学，
   * 坐标不由模型给，由服务端拿 before 回原文里重新找，找不到就如实标出。
   *
   * 判定见 lib/review.ts 的 locateExampleQuote。**只认 exact / normalized，不认
   * fuzzy**——理由写在那边的注释里，改判定之前务必读一下。
   */
  exampleUnverified?: boolean;
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

/**
 * 训练项的类别——**可训练的具体毛病**，不是评分维度。
 *
 * 为什么不复用 Dimension（content/language/organization）：那三个太粗。"语言"底下
 * 混着拼写、时态、搭配、句式……它们的练法毫无共同之处，按维度给建议只能给出
 * "多练语言"这种废话。按错误类型分，才能给出"拿不准的词换掉，别赌"这种能执行的动作。
 *
 * 出处的准确说法是**「锚定 + 扩展」**，别当成"从 rubric 倒推出来的"：
 * - 直接对应 rubric 里 major 说法的 5 个：tense / agreement / sentence-structure /
 *   noun-article / chinglish（措辞见 lib/prompt.ts 的 KIND_RULES）；
 * - 对应 minor 说法的 3 个：spelling ≈ 个别笔误、capitalization ≈ 大小写疏漏、
 *   collocation ≈ 单处搭配不当；
 * - **rubric 里没有对应说法的 5 个**：word-choice / sentence-variety / cohesion /
 *   paragraphing / task-response，是本轮新造的词。
 *
 * 保留后 5 个是因为"句式单一""没分段"高频且可训练，rubric 现有的 8 类覆盖不到。
 * 代价是**改 rubric 措辞不会自动同步到这里**，两边术语会慢慢漂，改的时候回来对一眼。
 *
 * ⚠️ 增删取值要同步三处：本类型、lib/training.ts 的 TRAINING_PLAYBOOK、
 * lib/labels.ts 的 TRAINING_FOCUS_LABEL。漏了查表会被 TypeScript 挡下
 * （`Record<TrainingFocus, …>` 要求键齐全），漏了标签不会——那个有专门的断言兜。
 */
export type TrainingFocus =
  | "spelling" | "capitalization"
  | "tense" | "agreement" | "noun-article" | "sentence-structure"
  | "chinglish" | "collocation" | "word-choice"
  | "sentence-variety" | "cohesion" | "paragraphing" | "task-response";

/**
 * 一条训练项：**诊断由模型给，练法由服务端查表**（lib/training.ts 的 TRAINING_PLAYBOOK）。
 *
 * 为什么这么切：练法文案要可写断言、措辞统一、零幻觉，交给模型生成就三样都没有；
 * 而"这篇最该练什么"非读过这篇作文不能知，只能由模型判断。各取所长。
 */
export interface TrainingItem {
  focus: TrainingFocus;
  /**
   * 模型给的：为什么**这篇**要练它。必须引用本篇的具体现象
   * （"全文 6 处第三人称单数漏 s"），不许写"中国学生普遍……"这类套话。
   */
  reason: string;
  /**
   * 关联的证据条目，用于在报告里跳回证据卡。
   * 和 UpgradeAction.linkedEvidenceIds 一样是**服务端补的**，不要求模型给
   * ——见 lib/review.ts 的 parseTrainingPlan。
   */
  linkedEvidenceIds: string[];
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
  /**
   * 训练区：按错误类型归类的「写作时怎么做 + 平时怎么练」，显示在报告结尾。
   *
   * **可选**，两个原因，都不是可选的：
   * 1. 模型没给、或给的都被解析规则丢了时，这一节**整节不显示**——报告里留个空壳
   *    比没有更糟。见 lib/review.ts 的 parseTrainingPlan。
   * 2. 存储里的旧报告没有这个键（lib/store.ts 是盲 `as ReviewResult`），
   *    渲染侧必须写 `?.`。
   *
   * ⚠️ 给 ReviewResult 加字段**一律要可选**：scripts/selftest.ts 里有内联的
   * ReviewResult 字面量，加必填字段会让 typecheck 和 selftest 一起编不过。
   */
  trainingPlan?: TrainingItem[];
  stats: {
    wordCount: number;
    sentenceCount: number;
    paragraphCount: number;
    /** 由 code 统计、不依赖模型的硬数据 */
    evidenceCount: number;
    /** 定位成功的证据条数 */
    verifiedCount: number;
    /**
     * 定位成功、但**带有歧义**的条数（ambiguity 非空）。
     *
     * 是 verifiedCount 的**子计数**，不是另一条分支——"已定位/未定位"的二分
     * 不被打破，报告里那句"5/6 条已定位"照旧成立。单开一个数是因为这两件事
     * 的严重程度完全不同："没定位到"是响亮失败，"定位了但可能不是那一处"
     * 是安静的错误，后者才是用户完全看不出来的那种。
     */
    ambiguousCount?: number;
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

/**
 * 输入长度限制。
 *
 * 放在这个文件而不是 lib/review.ts，是因为输入页（客户端组件）也要用同一组
 * 数字来限制输入。从 review.ts 导入的话，客户端组件为了一个整数会把整个编排层
 * ——包括模型客户端和整份提示词——拉进浏览器包里。
 *
 * **作文没有字数上限。** 这里原本有一个 MAX_ESSAY_CHARS = 8000，2026-09 按用户
 * 要求取消了。原来的理由是"四级作文就 120–180 词"，但那句话描述的是评分标准的
 * 适用范围，不是接口该管的事——它拦掉的是"贴了一篇长文想看看批改"这种正当用法，
 * 换来的只是一个拒绝。**下限保留**：太短的东西根本没法评。
 *
 * 现在真正的天花板是 lib/request-body.ts 的 MAX_BODY_BYTES（128 KB 请求体），
 * 折算下来约 12 万字符英文 / 约 4 万汉字 / 约 1 万个 emoji。对任何作文都够用，
 * 而且这个数不是随手拍的——它保证整个 prompt 装得进模型的上下文窗口。
 * 见那边的注释。
 */
export const MIN_ESSAY_CHARS = 20;
/**
 * 题目上限。题目会原样进 prompt，不限的话 token 成本成倍放大；
 * 而且题目比作文正文更适合藏提示注入（学生没理由往题目里写几千字）。
 */
export const MAX_TOPIC_CHARS = 1000;
/**
 * 单条证据引文的长度上限，只给服务端用。
 *
 * 这是**性能护栏**，不是为了好看：证据定位的模糊匹配是平方量级的，
 * 超长引文能让它从毫秒涨到秒。而 500 字符以上的"证据片段"本来也失去了
 * 引用价值——那不是"一处原文"，那是一整段。
 */
export const MAX_QUOTE_CHARS = 500;

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
    | "PAYLOAD_TOO_LARGE"
    | "RATE_LIMITED"
    | "UPSTREAM_ERROR"
    | "BAD_MODEL_OUTPUT"
    | "TIMEOUT"
    /** 客户端在批改完成前自己断开了，响应没人收 */
    | "CLIENT_ABORTED"
    | "UNKNOWN";
}

// ---------------------------------------------------------------------------
// 流式批改（SSE）
// ---------------------------------------------------------------------------

/**
 * 批改开始前就能确定、由代码算出来的统计。
 *
 * 刻意没有 evidenceCount/verifiedCount：那两个要等证据定位完才知道，
 * 属于最终结果，不属于进度。
 */
export interface ReviewProgressStats {
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
}

/**
 * SSE 事件。服务端按这个白名单构造帧，客户端按 type 归约。
 *
 * **任何一帧都不含 score15。** 分数要等上限校正（依据模型自己标的 major 条数和
 * 维度分）算完才公布，提前露出模型的原始分会让它几秒后当场跳一次（13 → 12）。
 * 过滤在服务端做，不靠客户端自觉——见 lib/review.ts 的 reviewEssayStream。
 *
 * 同理不含 warnings：lib/review.ts 里那条"分数已由系统校正：模型给出 N 分"
 * 的文案会把被押后的原始分泄露出来。
 */
export type ReviewStreamEvent =
  /** 立刻发出：作文的硬统计由代码算，不用等模型 */
  | {
      type: "meta";
      stats: ReviewProgressStats;
      model: string;
      topic: string;
      startedAt: string;
    }
  | { type: "summary"; value: string }
  | { type: "strengths"; value: string[] }
  | { type: "dimensionScores"; value: DimensionScore[] }
  /** 一条一帧，逐条出现 */
  | { type: "evidence"; value: PendingEvidence }
  /**
   * 定时心跳，无论上游有没有新内容都发。
   * chars 不涨就是诚实的"上游没有新内容"——所以这里**没有百分比**，
   * 总量是未知的，画一个按时间爬的进度条是骗人。
   */
  | { type: "progress"; chars: number }
  /** 权威结果。到这一帧为止的渐进内容全部作废，用它覆盖。 */
  | { type: "result"; result: ReviewResult }
  | { type: "error"; error: string; code: ReviewErrorResponse["code"] };

/**
 * 客户端在等待期间积累的部分结果。
 *
 * 它**用完就丢**：批改完成后照旧写 localStorage 再跳 /result，权威报告在那边。
 * 因此它不需要和 ReviewResult 对账，也就没有"部分结果与最终结果不一致"这类问题。
 * 绝不能落盘，也绝不能传给 ResultActions / buildReportHtml。
 */
export interface ReviewProgress {
  stats: ReviewProgressStats;
  model: string;
  topic: string;
  /** 模型已输出的字符数。用来展示真实进度，不是百分比。 */
  chars: number;
  summary?: string;
  strengths: string[];
  dimensionScores: DimensionScore[];
  evidence: PendingEvidence[];
}
