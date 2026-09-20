/**
 * 批改质量评测：拿一批作文跑真实批改，把完整结果存下来。
 *
 * 为什么要单独跑而不是走 HTTP 路由：这里评的是**批改质量**，不是接口行为。
 * 绕过路由能少一层干扰，也能并发跑。
 *
 * ⚠️ 这个脚本会**真实调用 DeepSeek 并计费**。跑之前先看清楚 CORPUS 有多少条。
 *
 * 跑法：
 *   npm run eval          # 跑全量
 *   npm run eval -- --only=a1,a2      # 只跑指定 id
 *   npm run eval -- --concurrency=4   # 调并发（默认 3）
 *   npm run eval -- --stream          # 走流式路径（走的是 /api/review 用的那条）
 *
 * --stream 不是"另测一套逻辑"：lib/review.ts 的两条路共用同一份校验、提示词和后处理，
 * 自测里有一条断言它们对同一份模型输出给出完全相同的结果。这里用它来量真东西：
 * **首帧延迟**（用户在等待界面上看到第一个字的时刻）和事件流水是否自洽。
 *
 * 输出落在 .eval-out/raw-<时间戳>.json，用 analyze.ts 分析。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reviewEssay, reviewEssayStream } from "../../lib/review";
import { computeStats, countEnglishWords } from "../../lib/text-stats";
import type { ReviewResult, ReviewStreamEvent } from "../../lib/types";
import { CORPUS, type EvalCase } from "./corpus";
import { ENV_FILE, EVAL_OUT_DIR } from "./paths";

// ---------------------------------------------------------------------------
// .env.local 是给 Next 用的，普通 node 脚本得自己加载
function loadEnvLocal(): void {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, "utf8");
  } catch {
    console.error("读不到 .env.local，请先按 README 配好。");
    process.exit(1);
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    // 已经存在的环境变量优先，方便临时覆盖
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit?.slice(prefix.length);
}

export interface RunRecord {
  id: string;
  expected: [number, number];
  note: string;
  topic?: string;
  objective: { chars: number; words: number; paragraphs: number };
  elapsedMs: number;
  ok: boolean;
  error?: { code?: string; message: string };
  result?: ReviewResult;
  /** 走流式路径（--stream）时才有：用来量等待体验到底改善了多少 */
  stream?: StreamStats;
}

export interface StreamStats {
  /** 第一个事件（meta）到达的时刻，毫秒、相对本次请求开始。约等于上游的首字节延迟 */
  firstFrameMs: number;
  /** 全部帧数 */
  frames: number;
  progressFrames: number;
  evidenceFrames: number;
  /**
   * 观测到模型确实在吐字的时刻。注意粒度是心跳周期（2 秒），所以它是个**上界**，
   * 不是"第一个字符到达"的精确时间——想要精确值得让服务端每来一个 delta 就发一帧，
   * 那个代价不值得
   */
  firstCharMs: number;
  /** result 帧带的对象与函数返回值是不是同一个（不是同一个就说明投影错了） */
  resultFrameMatches: boolean;
  /** 结果出现前的最后一帧是第几帧——在它之前都是渐进内容 */
  lastProgressiveFrame: number;
}

/** 限定并发的任务池。并发太高容易被上游限流，也会让单次耗时失真。 */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 用 lib/text-stats 的口径，和批改时喂给模型的数字保持一致。
 *
 * 早先这里自己写了一套正则（段落按空行拆），结果 a5 明明有五段却被报成 1 段，
 * 于是我在分析时拿它去质疑模型的"段落划分合理"。统计口径必须只有一个来源。
 */
function objectiveStats(essay: string) {
  return {
    chars: essay.length,
    words: countEnglishWords(essay),
    paragraphs: computeStats(essay).paragraphCount,
  };
}

async function main(): Promise<void> {
  loadEnvLocal();

  const only = argValue("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const concurrency = Number(argValue("concurrency") ?? 3) || 3;
  // 注意这里是**裸开关**（--stream），不是 --stream=1。
  // argValue 找的是 `--name=`，用它判断会把裸开关判成"没给"
  const useStream = process.argv.includes("--stream");

  const cases: EvalCase[] = only
    ? CORPUS.filter((c) => only.includes(c.id))
    : CORPUS;
  if (cases.length === 0) {
    console.error("没有选中任何用例。");
    process.exit(1);
  }

  const runs = cases.flatMap((c) =>
    Array.from({ length: c.repeat ?? 1 }, (_, i) => ({ c, run: i + 1 })),
  );

  console.log(
    `共 ${cases.length} 篇作文、${runs.length} 次调用（并发 ${concurrency}，` +
      `${useStream ? "流式" : "普通"}）。` +
      `这会真实计费。\n模型：${process.env.DEEPSEEK_MODEL || "deepseek-chat"}\n`,
  );

  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const records = await pool(runs, concurrency, async ({ c, run }): Promise<RunRecord> => {
    const id = run > 1 ? `${c.id}#${run}` : c.id;
    const rt0 = Date.now();
    const base = {
      id,
      expected: c.expected,
      note: c.note,
      topic: c.topic,
      objective: objectiveStats(c.essay),
    };
    try {
      let stream: StreamStats | undefined;
      let result: ReviewResult;

      if (useStream) {
        const events: ReviewStreamEvent[] = [];
        let firstFrameMs = -1;
        let firstCharMs = -1;
        let chars = 0;
        let resultFrameMatches = false;

        result = await reviewEssayStream({ essay: c.essay, topic: c.topic }, undefined, (e) => {
          if (firstFrameMs < 0) firstFrameMs = Date.now() - rt0;
          if (e.type === "progress" && e.chars > chars) {
            if (firstCharMs < 0) firstCharMs = Date.now() - rt0;
            chars = e.chars;
          }
          events.push(e);
        });

        // 在回调里比不了：result 帧是在 reviewEssayStream 返回之前发出的，
        // 那一刻外层变量还没赋值。所以等拿到返回值之后再认一次身份
        const resultFrame = events[events.length - 1];
        resultFrameMatches = resultFrame.type === "result" && resultFrame.result === result;

        stream = {
          firstFrameMs,
          firstCharMs,
          frames: events.length,
          progressFrames: events.filter((e) => e.type === "progress").length,
          evidenceFrames: events.filter((e) => e.type === "evidence").length,
          resultFrameMatches,
          lastProgressiveFrame: events.findIndex((e) => e.type === "result"),
        };
      } else {
        result = await reviewEssay({ essay: c.essay, topic: c.topic });
      }

      const ms = Date.now() - rt0;
      console.log(
        `  ✓ ${id.padEnd(6)} ${String(result.score15).padStart(2)} 分  ` +
          `${result.band.label}  ${String(ms).padStart(6)}ms  ` +
          `证据 ${result.stats.verifiedCount}/${result.stats.evidenceCount}  ` +
          `警告 ${result.warnings.length}` +
          (stream ? `  首帧 ${stream.firstFrameMs}ms / 首字 ${stream.firstCharMs}ms` : ""),
      );
      return { ...base, elapsedMs: ms, ok: true, result, stream };
    } catch (e) {
      const ms = Date.now() - rt0;
      const err = e as { code?: string; message?: string };
      console.log(`  ✗ ${id.padEnd(6)} 失败：${err.code ?? "?"} ${err.message ?? e}`);
      return {
        ...base,
        elapsedMs: ms,
        ok: false,
        error: { code: err.code, message: String(err.message ?? e) },
      };
    }
  });

  const outDir = EVAL_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const file = join(outDir, `raw-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify({ startedAt, model: process.env.DEEPSEEK_MODEL || "deepseek-chat", records }, null, 2),
    "utf8",
  );

  const okCount = records.filter((r) => r.ok).length;
  const failed = records.length - okCount;
  console.log(
    `\n完成：${okCount} 成功${failed ? `，${failed} 失败` : ""}，` +
      `总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`结果已写入 ${file}`);
  console.log(`分析：npm run eval:analyze -- --file=${file}`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("评测脚本异常：", e);
  process.exit(1);
});
