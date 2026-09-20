/**
 * 增量 JSON 扫描：从一段**还在增长**的文本里，把已经写完的部分抠出来。
 *
 * 用途只有一个——流式批改时让等待界面能显示真进度。它**不承担正确性**：
 * 最终结果永远由 lib/deepseek.ts 的 extractJson 对累积全文解析一次得出。
 *
 * 这个分工是有意的，也是这个模块最重要的性质：
 *
 *   扫描器只可能**少报**，不可能报错内容。它漏掉一个成员，最坏结果是等待界面
 *   少显示一块；它写错了，也污染不了报告，因为报告不走它。所以调用方要
 *   try/catch 包住它、把异常当成"这次没有新内容"，绝不能让它变成一个错误响应。
 *
 * 实现上刻意选了"每次收到新分片就从头重扫整个缓冲"，而不是维护跨分片的扫描状态。
 * 理由：缓冲只增不减，重扫天然幂等，而增量状态机最经典的失效模式恰恰发生在这里——
 * 一个分片边界正好切在 \" 中间、切在 A 中间、或者切在代理对中间，状态就错位了，
 * 而且错位之后不会自愈。重扫的成本是 deltas × bufferLen：实测一次批改输出 2-4 KB、
 * 约几百个分片，也就是几 MB 的扫描量，完全可以忽略。
 *
 * 与 extractJson 的一处刻意差异：这里找外层 { 时要求"后面第一个非空白字符是 \""，
 * 而 extractJson 用的是"第一个 {"。这个额外条件白捡地挡掉了
 * `结果如下（JSON 格式）：{...}` 这种散文里成对的假花括号。差异是良性的——
 * 就算这里没认出外层对象，也只是少显示几块，最终解析仍由 extractJson 完成。
 */

/** 外层对象里一个已经写完的顶层成员。 */
export interface ScannedMember {
  key: string;
  value: unknown;
}

export interface ScanResult {
  /**
   * 已写完的顶层成员，按出现顺序。**长度单调不减**：同一份缓冲重扫，
   * 已产出的成员不会消失、值也不会变（见文件头部的说明）。
   */
  members: ScannedMember[];
  /**
   * 第一个 "evidence" 数组里已写完的元素，按出现顺序，同样单调不减。
   *
   * 为什么要单列出来：evidence 是一个数组，它的元素逐个写完，而顶层成员粒度是
   * "整个数组写完"。想逐条显示证据就必须下沉一层。
   */
  evidence: unknown[];
}

/** 容器嵌套的安全上限。正常批改输出只有 4-5 层，超过就是模型跑飞了。 */
const MAX_DEPTH = 32;

const EMPTY: ScanResult = { members: [], evidence: [] };

interface Frame {
  kind: "obj" | "arr";
  /** 容器自身的起始下标（'{' 或 '['），用于整块切片 */
  start: number;
  /** 当前正在解析的值在本容器内的起始下标 */
  valueStart: number;
  /** obj 专用：当前值的键 */
  key: string | null;
}

/**
 * 扫描一段（可能不完整的）JSON 文本前缀。
 *
 * 只会产出**已经遇到分隔符（`,` 或闭合括号）的**值。所以 `"summary": "abc"`
 * 停在缓冲末尾时什么都不会产出——这是刻意的：否则界面上会出现一个还在生长、
 * 每来一个字就重排一次的字符串，比不显示更难看。
 */
export function scanJsonPrefix(buffer: string): ScanResult {
  const outerStart = findOuterObject(buffer);
  if (outerStart === -1) return EMPTY;

  const members: ScannedMember[] = [];
  const evidence: unknown[] = [];

  const stack: Frame[] = [];
  let inString = false;
  let escaped = false;
  /** 最近一个读完的字符串（含引号）的区间，用来在遇到 ':' 时当键解析 */
  let lastStringStart = -1;
  let lastStringEnd = -1;
  /** 第一个 evidence 数组的 start；只认第一个，避免重复键让渐进视图多报 */
  let evidenceFrameStart = -1;

  for (let i = outerStart; i < buffer.length; i += 1) {
    const ch = buffer[i];

    if (inString) {
      // 转义只认前一个字符是 \ 的情况。\uXXXX 不需要特判——那六个字符里
      // 既没有引号也没有花括号，不会干扰状态。
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        lastStringEnd = i + 1;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      lastStringStart = i;
      lastStringEnd = -1;
      continue;
    }

    if (ch === "{") {
      if (stack.length >= MAX_DEPTH) return { members, evidence };
      const parent = stack[stack.length - 1];
      stack.push({
        kind: "obj",
        start: i,
        valueStart: i + 1,
        // 继承父容器当前的键：外层成员的值如果是对象/数组，它要知道自己挂在哪个键上
        key: parent ? parent.key : null,
      });
      continue;
    }

    if (ch === "[") {
      if (stack.length >= MAX_DEPTH) return { members, evidence };
      const parent = stack[stack.length - 1];
      if (
        evidenceFrameStart === -1 &&
        stack.length === 1 &&
        parent?.kind === "obj" &&
        parent.key === "evidence"
      ) {
        evidenceFrameStart = i;
      }
      stack.push({
        kind: "arr",
        start: i,
        valueStart: i + 1,
        key: parent ? parent.key : null,
      });
      continue;
    }

    if (ch === ":") {
      // 冒号前的那个字符串就是键。不是合法键（比如是数字）就置空，
      // 让这个成员以 key: null 落地——调用方会忽略它。
      const key = parseKey(buffer, lastStringStart, lastStringEnd);
      const top = stack[stack.length - 1];
      if (top) {
        top.key = key;
        top.valueStart = i + 1;
      }
      continue;
    }

    if (ch === "}" || ch === "]") {
      // 先判断，后出栈：这两个判断看的都是"闭合前"的栈深。
      if (
        ch === "}" &&
        stack.length === 3 &&
        stack[2].kind === "obj" &&
        stack[1].kind === "arr" &&
        stack[1].start === evidenceFrameStart
      ) {
        // evidence 数组里一个元素的 } —— 逐条产出的就是这里
        pushParsed(evidence, buffer.slice(stack[2].start, i + 1));
      } else if (ch === "}" && stack.length === 1 && stack[0].kind === "obj") {
        // 外层对象收尾：最后一个成员在这里产出（它后面没有逗号了）
        emitMember(members, buffer, stack[0], i);
      }

      const frame = stack.pop();
      if (!frame) continue;
      // 外层对象已闭合，后面都是尾随内容
      if (stack.length === 0) break;
      // 注意这里**不能**动父容器的 valueStart/key：父容器那个成员的值就是刚闭合的
      // 这个容器，它的区间从父容器遇到 ':' 时就定下了，要到父容器自己的 ',' 或
      // 闭合括号才算结束。在这里重置会把 `"evidence": [...]` 这种"值是容器"的成员
      // 整个弄丢——它后面没有逗号，唯一的产出机会就是父容器闭合的那一刻。
      continue;
    }

    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (!top) continue;
      if (stack.length === 1 && top.kind === "obj") {
        emitMember(members, buffer, top, i);
      }
      top.valueStart = i + 1;
      top.key = null;
      continue;
    }
    // 其余字符（数字、字面量、空白）不改变结构，跳过
  }

  return { members, evidence };
}

/** 把 frame 当前那个成员（区间 [frame.valueStart, end)）解析出来。解析失败就丢弃。 */
function emitMember(
  out: ScannedMember[],
  buffer: string,
  frame: Frame,
  end: number,
): void {
  const key = frame.key;
  if (key === null) return; // 没认出键，宁可少报
  const slice = buffer.slice(frame.valueStart, end);
  if (!slice.trim()) return;
  try {
    out.push({ key, value: JSON.parse(slice) });
  } catch {
    // 切到的还是半截内容（或本来就不是合法 JSON）——丢弃。
    // 绝不抛：扫描器的问题不能升级成错误响应。
  }
}

function pushParsed(out: unknown[], slice: string): void {
  try {
    out.push(JSON.parse(slice));
  } catch {
    // 同上
  }
}

/** 把上次读完的字符串当作键解析。不是合法的 JSON 字符串就返回 null。 */
function parseKey(buffer: string, start: number, end: number): string | null {
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(buffer.slice(start, end));
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 找出外层对象的 '{'。
 *
 * 条件是"后面第一个非空白字符是 \""，而不是单纯"第一个 {"：
 * 模型偶尔会在 JSON 前面写一句 `结果如下（JSON 格式）：` 之类的话，
 * 里面的花括号会把人骗过去。
 */
function findOuterObject(buffer: string): number {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== "{") continue;
    for (let j = i + 1; j < buffer.length; j += 1) {
      const c = buffer[j];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") continue;
      if (c === '"') return i;
      break;
    }
  }
  return -1;
}
