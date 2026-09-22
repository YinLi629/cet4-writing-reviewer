/**
 * 批改结果在浏览器端的暂存。
 *
 * **不落服务端**是这里的核心决定，也是隐私承诺的全部内容：这是个单机练习工具，
 * 不引入数据库就不用处理用户身份、过期清理、隐私留存这些问题。作文永远只在这台
 * 设备的这个浏览器里，服务端只在批改的那几十秒里见过它。
 *
 * 存哪个 storage 是另一回事，别把两件事混起来（以前这里就混了）：
 *   · sessionStorage 的生命周期是「这个标签页」，于是**误关标签页 = 白花一次批改**。
 *     而批改要等几十秒，这个过程里手滑按到 Cmd/Ctrl+W、手机上切出去被系统回收，
 *     都不是小概率事件。
 *   · localStorage 活得比标签页久，代价是它也会留在共用电脑上，被下一个人看到。
 *
 * 权衡的结论是 localStorage + 把「这是什么时候的报告」明确说出来：丢报告是纯粹的
 * 损失，而看到一份旧的只要标了时间就不算误导。所以 `app/result/page.tsx` 会对过期
 * 的报告加一句提示（判定见下面的 `isResultFresh`），`/review` 上那个「上次的报告还在」
 * 的入口也带着时间。
 *
 * 仍然不做的：跨设备、跨浏览器。真要做分享，应该改成服务端存储 + 短 id。
 */

import type { ReviewResult } from "./types";

const KEY = "cet4-review:last";
const HISTORY_KEY = "cet4-review:history";
const HISTORY_LIMIT = 10;

/**
 * 一份报告还算不算「刚做完的那一份」。
 *
 * 24 小时：隔了一天再看，「上次」指的就未必是它了，这时候把生成时间摆到台面上
 * 比装作刚出炉的更诚实。注意旧报告**照常显示**，这个判定只决定要不要多一句说明——
 * 报告本身仍然有价值，没有理由因为旧就藏起来。
 */
export const RESULT_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * 判断报告够不够新。
 *
 * 入参是 localStorage 里读出来的字符串，可能是旧版本写的、也可能被手改过，
 * 所以解析不了时**返回 false**（当作旧的）。这个方向的失败是安全的：顶多多显示
 * 一句生成时间；反过来则会让一份放了半年的报告装成刚出炉的。
 */
export function isResultFresh(createdAt: string, now: number): boolean {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return now - t < RESULT_FRESH_MS;
}

/**
 * 所有浏览器端存储的唯一入口。
 *
 * 以前这里是两个函数（结果走 sessionStorage、口令走 localStorage），因为两者当时
 * 的生命周期确实不同。现在结果也搬到了 localStorage，两套变成一模一样，就合并成
 * 一个——留着两份只是重复，还会让人以为它们之间有什么讲究。
 *
 * 两道防护缺一不可：
 *   · SSR 阶段没有 window，构建时就会执行到这里
 *   · 隐私模式 / 禁用站点数据时，访问 localStorage 本身就会抛异常，
 *     所以必须先探一下，不能等 setItem 报错才知道
 */
function localStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const s = window.localStorage;
    const probe = "__probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * 访问口令存在 localStorage 里。
 *
 * 它不是敏感到那个地步的东西：挡的是「随手扫到站点的人」，不是拿到过这台电脑的人。
 * 所以“记住它、省掉每次重输”是划算的。
 */
const ACCESS_CODE_KEY = "cet4-review:access-code";

export function saveAccessCode(code: string): void {
  const s = localStore();
  if (!s) return;
  try {
    s.setItem(ACCESS_CODE_KEY, code);
  } catch {
    // 存不下就算了，下次重输一遍而已，不阻断主流程
  }
}

export function loadAccessCode(): string | null {
  return localStore()?.getItem(ACCESS_CODE_KEY) ?? null;
}

export function clearAccessCode(): void {
  localStore()?.removeItem(ACCESS_CODE_KEY);
}

/**
 * 作文草稿：**还没提交的输入**。
 *
 * 和「结果」是两回事：结果有服务端的一份（批改完的那一刻），草稿只存在于这个
 * 浏览器里，丢了就真没了。而它丢的时机特别难受——学生写完点批改，盯着屏幕等
 * 几十秒，这期间手滑按了 F5、或者手机浏览器在后台把标签页回收了（移动端极常见），
 * 作文原文、批改、一次额度一起没了。额度是花掉的，作文是写出来的，两样都补不回来。
 *
 * 所以草稿也用 localStorage：sessionStorage 的生命周期就是「这个标签页」，
 * 正好是最容易意外结束的那个。
 */
export interface EssayDraft {
  essay: string;
  topic: string;
  targetBandLevel: string;
}

const DRAFT_KEY = "cet4-review:draft";

/**
 * 草稿的字符上限。
 *
 * 为什么要设：localStorage 是**同一个域共享配额**的，而访问口令也存在这里
 * （`ACCESS_CODE_KEY`）。一篇被误粘进来的巨型文本能把配额吃满，之后 `saveAccessCode`
 * 静默失败——代价是用户每次访问都要重输口令，而这个故障看起来跟草稿毫无关系，
 * 极难排查。服务端的请求体上限是 128 KB，这里留出余量卡在同一个量级。
 */
const DRAFT_MAX_CHARS = 160_000;

/**
 * 把 localStorage 里读出来的任意值收拢成一个结构完整的草稿。
 *
 * ⚠️ 入参是 `unknown`，因为它是 `JSON.parse` 的结果——可能来自旧版本、可能被手改过、
 * 也可能只是坏数据。**永远返回一个三个字段都存在的对象**，调用方不需要再判空。
 * 类型不对的字段一律当空字符串，而不是丢弃整个草稿：丢掉一篇能救回来的作文，
 * 比容忍一个字段是空的严重得多。
 */
export function coerceDraft(raw: unknown): EssayDraft {
  const o: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    essay: str(o.essay),
    topic: str(o.topic),
    targetBandLevel: str(o.targetBandLevel),
  };
}

/** 三个字段都是空白就等于没有草稿。用 trim：全是空格/换行的草稿没有恢复的价值 */
export function isDraftEmpty(draft: EssayDraft): boolean {
  return (
    draft.essay.trim() === "" &&
    draft.topic.trim() === "" &&
    draft.targetBandLevel.trim() === ""
  );
}

/**
 * 写草稿。**任何失败都静默吞掉**：草稿是「锦上添花的保险」，不是主流程的一部分，
 * 为了它中断批改是本末倒置。存不下（配额满、隐私模式）就当作没有这个功能。
 */
export function saveDraft(draft: EssayDraft): void {
  if (isDraftEmpty(draft)) {
    clearDraft();
    return;
  }
  if (draft.essay.length > DRAFT_MAX_CHARS) return;
  const s = localStore();
  if (!s) return;
  try {
    s.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // 存不下就算了，见上面 DRAFT_MAX_CHARS 的说明
  }
}

/** 读草稿。解析失败或内容为空都当作「没有草稿」，返回 null */
export function loadDraft(): EssayDraft | null {
  const s = localStore();
  if (!s) return null;
  const raw = s.getItem(DRAFT_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const draft = coerceDraft(parsed);
  return isDraftEmpty(draft) ? null : draft;
}

export function clearDraft(): void {
  localStore()?.removeItem(DRAFT_KEY);
}

export function saveResult(result: ReviewResult): void {
  const s = localStore();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(result));
  } catch {
    // 配额满了：把历史清掉再试一次。
    // 只动历史不动草稿——草稿是用户还没提交的原文，比一份旧摘要金贵得多，
    // 而历史目前压根没有任何界面在读（见 README 的已知限制）
    try {
      s.removeItem(HISTORY_KEY);
      s.setItem(KEY, JSON.stringify(result));
    } catch {
      // 还是不行就算了，不阻断主流程
    }
  }
}

export function loadResult(): ReviewResult | null {
  const s = localStore();
  if (!s) return null;
  const raw = s.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReviewResult;
  } catch {
    return null;
  }
}

export function clearResult(): void {
  localStore()?.removeItem(KEY);
}

/** 轻量历史，只存够渲染摘要的字段，避免把存储配额撑爆 */
export interface HistoryEntry {
  id: string;
  createdAt: string;
  score15: number;
  score106: number;
  bandLabel: string;
  wordCount: number;
  excerpt: string;
}

export function pushHistory(result: ReviewResult): void {
  const s = localStore();
  if (!s) return;

  const entry: HistoryEntry = {
    id: `${Date.now()}`,
    createdAt: result.meta.createdAt,
    score15: result.score15,
    score106: result.score106,
    bandLabel: result.band.label,
    wordCount: result.stats.wordCount,
    excerpt: result.essay.slice(0, 60).replace(/\s+/g, " "),
  };

  try {
    const list = loadHistory();
    list.unshift(entry);
    s.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    // 存不下就放弃，历史只是锦上添花
  }
}

export function loadHistory(): HistoryEntry[] {
  const s = localStore();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearHistory(): void {
  localStore()?.removeItem(HISTORY_KEY);
}

/** 下载 HTML 报告。浏览器端才有 document。 */
export function downloadReport(html: string, filename: string): void {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立刻 revoke 会让部分浏览器来不及下载，挪到下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 生成报告文件名，带上日期和分数便于归档 */
export function reportFilename(result: ReviewResult): string {
  const d = new Date(result.meta.createdAt);
  const stamp = Number.isNaN(d.getTime())
    ? "report"
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `四级作文批改报告-${stamp}-${result.score15}分.html`;
}
