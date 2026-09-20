/**
 * 对比两次评测运行，量「同一篇作文的分数稳不稳」。
 *
 * 存在的理由：批改结果必须可复现——同一篇作文交两次拿到的分数不该差一档。
 * temperature 归零之前，同一份代码连跑两遍有 13/28 篇分数变化、平均波动
 * 0.75 分/篇（见 lib/deepseek.ts 的 DEFAULT_TEMPERATURE）。光看单次运行的
 * 分档命中率是发现不了这个问题的，必须有这个两两对比的工具。
 *
 * 用法（先连跑两遍 eval，再对比）：
 *   npm run eval
 *   npm run eval
 *   npm run eval:compare              # 自动取最近两份 raw-*.json
 *   npm run eval:compare -- --a=<文件> --b=<文件>
 *
 * 输出里「平均绝对波动」是核心指标：它是每篇 |Δscore| 的平均值。
 *
 * ⚠️ 读结果时注意：**维度分的抖动比总分更值得看**。如果某一篇的总分没变，
 * 但 content 从 4 变成 3，那它只是这次恰好没跨过分档线——底下的诊断并不稳定。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord } from "./run";
import { EVAL_OUT_DIR } from "./paths";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function recent(n: number): string[] {
  return readdirSync(EVAL_OUT_DIR)
    .filter((f) => f.startsWith("raw-") && f.endsWith(".json"))
    .sort()
    .slice(-n)
    .map((f) => join(EVAL_OUT_DIR, f));
}

function load(file: string): Map<string, RunRecord> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { records: RunRecord[] };
  const byId = new Map<string, RunRecord>();
  for (const r of raw.records) {
    // 同一 id 跑多次（repeat）时只取第一条，对比的是"同一条在两轮之间的漂移"
    if (!r.error && !byId.has(r.id)) byId.set(r.id, r);
  }
  return byId;
}

const explicitA = argValue("a");
const explicitB = argValue("b");
let fileA: string;
let fileB: string;

if (explicitA && explicitB) {
  fileA = explicitA;
  fileB = explicitB;
} else {
  const lastTwo = recent(2);
  if (lastTwo.length < 2) {
    console.error(
      `需要两份 raw-*.json 才能对比，${EVAL_OUT_DIR} 里只找到 ${lastTwo.length} 份。先跑两次 npm run eval。`,
    );
    process.exit(1);
  }
  [fileA, fileB] = lastTwo;
}

const A = load(fileA);
const B = load(fileB);

console.log(`A：${fileA}`);
console.log(`B：${fileB}`);
console.log(`A 有 ${A.size} 条，B 有 ${B.size} 条\n`);

const dim = (r: RunRecord, d: string) =>
  r.result?.dimensionScores?.find((x) => x.dimension === d)?.score;
const majors = (r: RunRecord) => r.result?.evidence.filter((e) => e.kind === "major").length;

const header = [
  "id".padEnd(7),
  "总分 A→B".padEnd(11),
  "content".padEnd(9),
  "language".padEnd(10),
  "org".padEnd(8),
  "major".padEnd(8),
  "Δ".padEnd(4),
  "维度分有没有翻",
].join("");
console.log(header);
console.log("-".repeat(header.length + 4));

const drift: Array<{ id: string; d: number }> = [];
let dimFlips = 0;

for (const id of A.keys()) {
  const a = A.get(id);
  const b = B.get(id);
  if (!a || !b) continue;

  const sa = a.result?.score15;
  const sb = b.result?.score15;
  if (sa === undefined || sb === undefined) continue;

  const d = sb - sa;
  if (d !== 0) drift.push({ id, d });

  const cell = (f: (r: RunRecord) => number | undefined) => `${f(a) ?? "-"}→${f(b) ?? "-"}`;
  // 维度分翻了但总分没翻，说明只是这次没跨过分档线——比总分变化更早暴露不稳定
  const flipped = (["content", "language", "organization"] as const).filter(
    (k) => dim(a, k) !== dim(b, k),
  );
  if (flipped.length > 0) dimFlips += 1;

  console.log(
    [
      id.padEnd(7),
      cell((r) => r.result?.score15).padEnd(11),
      cell((r) => dim(r, "content")).padEnd(9),
      cell((r) => dim(r, "language")).padEnd(10),
      cell((r) => dim(r, "organization")).padEnd(8),
      cell(majors).padEnd(8),
      (d === 0 ? "" : d > 0 ? `+${d}` : `${d}`).padEnd(4),
      flipped.join(" "),
    ].join(""),
  );
}

const n = A.size;
const absSum = drift.reduce((s, x) => s + Math.abs(x.d), 0);
console.log(
  `\n总分有变化的：${drift.length}/${n} 篇` +
    (drift.length ? `　${drift.map((x) => `${x.id}(${x.d > 0 ? "+" : ""}${x.d})`).join(" ")}` : ""),
);
console.log(`维度分有翻转的：${dimFlips}/${n} 篇`);
console.log(`平均绝对波动：${(absSum / n).toFixed(2)} 分/篇`);
console.log(
  absSum / n <= 0.25
    ? "→ 稳定。"
    : "→ 偏大，看看是哪些篇目在翻，以及它们的维度分是不是也在翻。",
);
