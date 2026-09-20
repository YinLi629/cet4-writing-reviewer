/**
 * 批改结果在浏览器端的暂存。
 *
 * 这里刻意用 sessionStorage 而不是服务端存储：这是个单机练习工具，
 * 不引入数据库就不用处理用户身份、过期清理、隐私留存这些问题——
 * 关掉标签页，作文就没了，对用户反而是好事。
 *
 * 代价是结果不能跨标签页分享。真要做分享功能，应该改成服务端存储 + 短 id。
 *
 * 唯一的例外是访问口令：它用 localStorage，因为口令是用户自己持有的凭据、
 * 不是批改产物，「关掉标签页就没了」在这里反而是折磨。
 */

import type { ReviewResult } from "./types";

const KEY = "cet4-review:last";
const HISTORY_KEY = "cet4-review:history";
const HISTORY_LIMIT = 10;

/** sessionStorage 在 SSR 阶段不存在，所有读写都要先过这一关 */
function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    // 隐私模式下 sessionStorage 可能直接抛异常
    const s = window.sessionStorage;
    const probe = "__probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * 访问口令是唯一用 localStorage 的东西——见文件头部的说明。
 *
 * 口令不是敏感到这个地步的东西：它挡的是"随手扫到站点的人"，不是拿到过
 * 这台电脑的人。所以存 localStorage 换取免重输是划算的。
 */
const ACCESS_CODE_KEY = "cet4-review:access-code";

/** 和 storage() 同样的防护：SSR 下不存在，隐私模式下可能抛异常 */
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

export function saveResult(result: ReviewResult): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(result));
  } catch {
    // 额度满了：把历史清掉再试一次
    try {
      s.removeItem(HISTORY_KEY);
      s.setItem(KEY, JSON.stringify(result));
    } catch {
      // 还是不行就算了，不阻断主流程
    }
  }
}

export function loadResult(): ReviewResult | null {
  const s = storage();
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
  storage()?.removeItem(KEY);
}

/** 轻量历史，只存够渲染摘要的字段，避免把 sessionStorage 撑爆 */
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
  const s = storage();
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
  const s = storage();
  if (!s) return [];
  try {
    const parsed = JSON.parse(s.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearHistory(): void {
  storage()?.removeItem(HISTORY_KEY);
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
