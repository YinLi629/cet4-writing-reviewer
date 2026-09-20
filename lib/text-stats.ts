/**
 * 文本硬统计。纯函数，不依赖任何服务端能力，
 * 所以客户端（实时字数）和服务端（报告统计）可以共用同一份实现，
 * 不会出现"输入页显示 138 词、报告里写 137 词"这种对不上的情况。
 */

/** 英文词：字母数字串，允许中间有连字符或撇号（don't, well-known） */
const WORD_RE = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

export function countEnglishWords(text: string): number {
  const m = text.match(WORD_RE);
  return m ? m.length : 0;
}

export interface TextStats {
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
}

export function computeStats(text: string): TextStats {
  const wordCount = countEnglishWords(text);

  const sentenceCount = text
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;

  const paragraphCount = text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length;

  return {
    wordCount,
    sentenceCount,
    paragraphCount: paragraphCount || (text.trim() ? 1 : 0),
  };
}
