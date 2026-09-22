/**
 * 证据溯源。
 *
 * 设计要点：**坐标不由模型提供**。模型只被要求"从原文逐字抄一段"，我们拿到
 * 这段文字后在原文里自己找位置。这么做有三个好处：
 *
 *  1. 坐标永远不会飘。模型数不清第几个字符，但它抄得对原文。
 *  2. 抄错了能被抓到。找不到就是 verified=false，报告里会如实标出来，
 *     而不是画一个看起来精确、实际错位的下划线。
 *  3. 定位方法（exact / normalized / fragmented / fuzzy）会一并返回，
 *     用户能知道这条引用有多可信。
 *
 * 第 2 条说的是"找不到就是失败"，但还有一种更隐蔽的情况：**找到了，却可能找错了**
 * ——短引文在原文里出现两次时，逐字命中是毫无疑问的，命中的是不是模型想指的那一处
 * 却不是。这种"装作成功"没有任何线索，所以额外给出 ambiguity（见 LocateResult）。
 * 两种情况的处理方向一致：如实说出来，而不是替用户猜。
 */

import type { AmbiguityReason, Evidence, LocateMethod } from "./types";

export interface LocateResult {
  start: number | null;
  end: number | null;
  method: LocateMethod;
  /** 实际命中的原文片段，便于对照模型抄得准不准 */
  matched: string | null;
  /** 匹配上的候选处数（含被选中的这处）。只在 ambiguity 为 multiple 时有值 */
  hitCount?: number;
  /** 定位的歧义程度。见 lib/types.ts 的 AmbiguityReason */
  ambiguity?: AmbiguityReason;
}

const NOT_FOUND: LocateResult = {
  start: null,
  end: null,
  method: "none",
  matched: null,
};

/**
 * 命中多处时的歧义标记，命中唯一时返回空对象（拼进结果里什么也不加）。
 *
 * 刻意**不降级 method**：method 说的是"怎么匹配上的"，而那几处出现的确都是
 * 逐字命中，这一点没有疑问。把其中一条改标成 normalized/fuzzy 是假信息——
 * 它明明是逐字的。歧义单开一个字段：让不确定可见，而不是把两条都判成失败，
 * 也不是假装没这回事。
 */
function ambiguityOf(hitCount: number): Pick<LocateResult, "hitCount" | "ambiguity"> {
  return hitCount > 1 ? { hitCount, ambiguity: "multiple" } : {};
}

/**
 * 把若干区间按重叠合并，返回互不重叠的区间的个数。
 *
 * 只用来数"有几处"，所以不需要保留边界，返回个数就够了。
 * 为什么要合并：模糊匹配会用 n-1/n/n+1 三种窗口长度各扫一遍，
 * 同一处命中会产生两三个相互重叠的窗口，直接数窗口会把一次命中数成三四次。
 */
function countRegions(spans: Array<[number, number]>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let regions = 1;
  let reach = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    // 相接（start === reach）也算同一处：那是同一个窗口被长度 ±1 切出来的
    if (sorted[i][0] > reach) regions += 1;
    reach = Math.max(reach, sorted[i][1]);
  }
  return regions;
}

/** 排版变体归一：弯引号、破折号、不间断空格等 */
const SMART_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  " ": " ",
  "　": " ",
  "﻿": "",
};

/** 省略号的各种写法，用于把引文拆成多段 */
const ELLIPSIS_RE = /\.\s*\.\s*\.|…|…|\[\.\.\.\]|\(\.\.\.\)/;

/** 模糊匹配的接受阈值：引文词有 80% 能在原文窗口里找到就算命中 */
const FUZZY_THRESHOLD = 0.8;

/**
 * 省略号分段的最多段数。
 *
 * 每段都要单独定位一次（逐字找不到时还要重建一遍归一化映射），
 * 不加限制的话，一条塞满省略号的超长引文能把这里放大成平方级的开销。
 * 20 段已经远超正常引用会有的断点数量，超过就说明这条引文本身没意义了。
 */
const MAX_FRAGMENTS = 20;

/**
 * 把一段文本归一化，并保留"归一化后的第 i 个字符 → 原文下标"的映射。
 * 映射是能反查回原文坐标的关键。
 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let prevWasSpace = false;

  for (let i = 0; i < s.length; i++) {
    const mapped = SMART_MAP[s[i]] ?? s[i];

    if (/\s/.test(mapped)) {
      // 连续空白压成一个空格
      if (!prevWasSpace && chars.length > 0) {
        chars.push(" ");
        map.push(i);
        prevWasSpace = true;
      }
      continue;
    }

    // 小写化未必是 1:1 的：İ(U+0130) 的 toLowerCase() 是 "i̇"（i + 组合点，
    // 2 个 code unit）。所以不能只 push 一次——否则 chars 比 map 长，
    // 两数组错位，后面用 map[h + len - 1] 反查坐标时会整体漂移
    // （画出来的高亮会错位，而且不报错）。
    const lower = mapped.toLowerCase();
    for (let k = 0; k < lower.length; k++) {
      chars.push(lower[k]);
      map.push(i);
    }
    prevWasSpace = false;
  }

  while (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }

  return { norm: chars.join(""), map };
}

/**
 * 成对包裹引号：两端各一个引号字符，中间是内容。
 *
 * 刻意写成"两端各一个单字符类，中间贪婪"：原来的写法中间用懒惰的 `[\s\S]*?`、
 * 两侧再各夹一个贪婪的 `\s*`，那是典型的二次回溯形状（全文唯一一处）。
 * 现在空白交给 trim()，正则本身没有歧义，是线性的。
 */
const WRAPPED_QUOTE_RE = /^["'“”‘’]([\s\S]*)["'“”‘’]$/;

/** 清洗模型给的引文：去掉它自作主张包上的引号和两端省略号 */
function cleanQuote(raw: string): string {
  let q = raw.trim();
  // 去掉成对的包裹引号，最多剥两层
  for (let i = 0; i < 2; i++) {
    const inner = q.match(WRAPPED_QUOTE_RE)?.[1]?.trim();
    if (inner) q = inner;
    else break;
  }
  // 去掉两端的省略号
  q = q.replace(/^(\.\s*\.\s*\.|…)\s*/, "").replace(/\s*(\.\s*\.\s*\.|…)$/, "");
  return q.trim();
}

interface Token {
  token: string;
  start: number;
  end: number;
}

/** 分词并记录每个词在原文中的位置，模糊匹配要用 */
function tokenizeWithPos(s: string): Token[] {
  const out: Token[] = [];
  const re = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({
      token: m[0].toLowerCase().replace("’", "'"),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** 找出 needle 在 haystack 中的所有出现位置 */
function allOccurrences(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    hits.push(at);
    from = at + 1; // +1 而不是 +len，允许重叠出现
    if (hits.length > 500) break; // 防御：别在极端输入上卡住
  }
  return hits;
}

/** 判断某个区间是否与已占用的区间重叠 */
function overlaps(start: number, end: number, claimed: Array<[number, number]>): boolean {
  return claimed.some(([cs, ce]) => start < ce && end > cs);
}

/**
 * 在一篇作文里定位一条引文。
 *
 * @param claimed 已被其它证据占用的区间。同一句话被两条证据引用时，
 *                后一条会自动找下一处出现位置，避免两处高亮叠在同一段上。
 */
export function locateQuote(
  essay: string,
  rawQuote: string,
  claimed: Array<[number, number]> = [],
): LocateResult {
  if (!essay || !rawQuote) return NOT_FOUND;

  const quote = cleanQuote(rawQuote);
  if (quote.length < 2) return NOT_FOUND;

  // 含省略号的引文按段拆开定位，取首段起点到尾段终点
  const fragments = quote
    .split(ELLIPSIS_RE)
    .map((f) => cleanQuote(f))
    .filter((f) => f.length >= 2);

  if (fragments.length > 1) {
    // 段落太多直接放弃定位，见 MAX_FRAGMENTS 的注释。
    // 返回"未能定位"而不是硬算：报告里会如实标出来，好过卡上几秒
    if (fragments.length > MAX_FRAGMENTS) return NOT_FOUND;

    const spans: Array<[number, number]> = [];
    for (const frag of fragments) {
      const hit = locateSingle(essay, frag, spans);
      if (hit.start === null || hit.end === null) return NOT_FOUND;
      spans.push([hit.start, hit.end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    const start = spans[0][0];
    const end = spans[spans.length - 1][1];
    return { start, end, method: "fragmented", matched: essay.slice(start, end) };
  }

  return locateSingle(essay, quote, claimed);
}

function locateSingle(
  essay: string,
  quote: string,
  claimed: Array<[number, number]>,
): LocateResult {
  // 1. 逐字命中：优先取尚未被占用的那一处
  const exactHits = allOccurrences(essay, quote);
  if (exactHits.length > 0) {
    const free = exactHits.find((at) => !overlaps(at, at + quote.length, claimed));
    const at = free ?? exactHits[0];
    return {
      start: at,
      end: at + quote.length,
      method: "exact",
      matched: essay.slice(at, at + quote.length),
      // 原文里逐字出现两次以上时，"模型指的是哪一处"是引文本身回答不了的。
      // 取第一处未占用的那个只是当下最合理的猜测，报告里必须说清这是猜测
      ...ambiguityOf(exactHits.length),
    };
  }

  // 2. 归一化后命中：忽略大小写、空白差异、弯引号
  const { norm: normEssay, map } = normalizeWithMap(essay);
  const { norm: normQuote } = normalizeWithMap(quote);

  if (normQuote.length >= 2) {
    const hits = allOccurrences(normEssay, normQuote);
    const mapped = hits
      .map((h) => {
        const s = map[h];
        const e = map[h + normQuote.length - 1];
        return [s, e + 1] as [number, number];
      })
      .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);

    if (mapped.length > 0) {
      const [start, end] = mapped.find(([s, e]) => !overlaps(s, e, claimed)) ?? mapped[0];
      return {
        start,
        end,
        method: "normalized",
        matched: essay.slice(start, end),
        ...ambiguityOf(mapped.length),
      };
    }
  }

  // 3. 模糊命中：按词做滑动窗口，容忍词序与拼写的小出入
  const fuzzy = fuzzyLocate(essay, quote, claimed);
  if (fuzzy) return fuzzy;

  return NOT_FOUND;
}

function fuzzyLocate(
  essay: string,
  quote: string,
  claimed: Array<[number, number]>,
): LocateResult | null {
  const qTokens = tokenizeWithPos(quote).map((t) => t.token);
  if (qTokens.length < 3) return null; // 词太少，模糊匹配没有意义

  const eTokens = tokenizeWithPos(essay);
  if (eTokens.length < qTokens.length) return null;

  // 引文的词频表
  const want = new Map<string, number>();
  for (const t of qTokens) want.set(t, (want.get(t) ?? 0) + 1);

  const n = qTokens.length;
  let best: { score: number; start: number; end: number } | null = null;
  /**
   * 所有达到阈值的窗口，**不剔除与已占用区间重叠的**。
   * 数"有几处差不多匹配"不能取决于别的证据先占了哪里，否则同一批引文的
   * 数量统计会随排序漂移。
   */
  const passing: Array<[number, number]> = [];

  // 窗口长度允许上下浮动 1 个词
  for (const w of [n - 1, n, n + 1]) {
    if (w < 1 || w > eTokens.length) continue;

    for (let i = 0; i + w <= eTokens.length; i++) {
      const have = new Map<string, number>();
      for (let k = i; k < i + w; k++) {
        const t = eTokens[k].token;
        have.set(t, (have.get(t) ?? 0) + 1);
      }

      // 多重集交集大小
      let common = 0;
      for (const [t, c] of want) {
        common += Math.min(c, have.get(t) ?? 0);
      }

      const score = common / n;
      if (score < FUZZY_THRESHOLD) continue;

      const start = eTokens[i].start;
      const end = eTokens[i + w - 1].end;
      passing.push([start, end]);
      if (overlaps(start, end, claimed)) continue;

      if (!best || score > best.score) best = { score, start, end };
    }
  }

  if (!best) return null;

  // 模糊匹配的落点本身就只是近似，但"近似"和"有多处差不多近似"是两件事：
  // 前者已经由 method: "fuzzy" 说清楚了（徽章上写着"模糊命中"），
  // 再挂一句"不确定"是重复的噪音。真正新增的信息是**它本来可以落在别处**——
  // 一条 5 词引文只要 4 词相同就算命中，原文里另一句凑巧也满足时，
  // 模型指的是哪一句代码无从判断。所以这里也只在多于一处时才标记。
  const regions = countRegions(passing);
  return {
    start: best.start,
    end: best.end,
    method: "fuzzy",
    matched: essay.slice(best.start, best.end),
    ...ambiguityOf(regions),
  };
}

/**
 * 给一批证据统一算坐标。
 *
 * 顺序无关：每条引文各自找"第一处尚未被占用"的出现位置，
 * 所以模型把证据顺序打乱也不会导致高亮错位。
 */
export function locateAllEvidence(
  essay: string,
  items: Array<{ id: string; quote: string }>,
): Map<string, LocateResult> {
  const claimed: Array<[number, number]> = [];
  const out = new Map<string, LocateResult>();

  // 先长后短：长引文先占位，短引文再去找别的落点，
  // 否则一句短话可能把长句的位置抢走。
  const ordered = [...items].sort((a, b) => b.quote.length - a.quote.length);

  for (const item of ordered) {
    const hit = locateQuote(essay, item.quote, claimed);
    if (hit.start !== null && hit.end !== null) {
      claimed.push([hit.start, hit.end]);
    }
    out.set(item.id, hit);
  }

  return out;
}

/** 把定位结果贴回证据对象 */
export function attachLocations(
  essay: string,
  raw: Array<Omit<Evidence, "start" | "end" | "verified" | "locateMethod">>,
): Evidence[] {
  const located = locateAllEvidence(
    essay,
    raw.map((r) => ({ id: r.id, quote: r.quote })),
  );

  return raw.map((r) => {
    const hit = located.get(r.id) ?? NOT_FOUND;
    return {
      ...r,
      start: hit.start,
      end: hit.end,
      verified: hit.method !== "none",
      locateMethod: hit.method,
      // 歧义只在"定位成功"时才带出来。没定位上的条目已经有 verified: false
      // 这条更响亮的信息了，再挂一句"有多处候选"反而自相矛盾
      ...(hit.ambiguity ? { ambiguity: hit.ambiguity, hitCount: hit.hitCount } : {}),
    };
  });
}
