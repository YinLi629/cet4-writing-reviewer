/**
 * 打印某一条（或全部）批改结果，供人逐条读。
 *
 * 分析脚本只能挑出"可疑"的，判断"这个分数给得对不对、这句诊断说得准不准"
 * 必须人读。这个脚本就是把原始输出摊开，不做任何加工。
 *
 * 跑法：
 *   npm run eval:show -- --id=a1
 *   npm run eval:show -- --all
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord } from "./run";
import { EVAL_OUT_DIR } from "./paths";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const file =
  argValue("file") ??
  (() => {
    const files = readdirSync(EVAL_OUT_DIR).filter((f) => f.startsWith("raw-")).sort();
    return join(EVAL_OUT_DIR, files[files.length - 1]);
  })();

const raw = JSON.parse(readFileSync(file, "utf8")) as { records: RunRecord[] };
const wantAll = process.argv.includes("--all");
const id = argValue("id");

const picked = wantAll ? raw.records : raw.records.filter((r) => r.id === id);
if (picked.length === 0) {
  console.error(`没找到 ${id ?? "(未指定 --id)"}。可用的：${raw.records.map((r) => r.id).join(" ")}`);
  process.exit(1);
}

const rule = (c = "=") => console.log(c.repeat(74));

for (const r of picked) {
  console.log();
  rule();
  console.log(`${r.id}　${r.note}　预期 ${r.expected[0]}-${r.expected[1]} 分`);
  console.log(
    `原文 ${r.objective.chars} 字符 / ${r.objective.words} 词 / ${r.objective.paragraphs} 段` +
      `　耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`,
  );
  rule();

  if (!r.ok || !r.result) {
    console.log(`失败：${r.error?.code} ${r.error?.message}`);
    continue;
  }
  const res = r.result;

  console.log(`\n【分数】${res.score15} 分　${res.band.label}（${res.band.range.join("-")}）` +
    `　折算 ${res.score106}`);
  console.log(`\n【总评】${res.summary}`);
  if (res.strengths.length) console.log(`\n【做对的地方】\n  - ${res.strengths.join("\n  - ")}`);

  console.log(`\n【维度诊断】`);
  for (const d of res.dimensionScores) {
    console.log(`  ${d.dimension.padEnd(13)} ${d.score}/5  ${d.comment}`);
  }

  console.log(`\n【证据 ${res.stats.verifiedCount}/${res.stats.evidenceCount} 定位成功】`);
  for (const e of res.evidence) {
    const loc =
      e.verified && e.start !== null
        ? `${e.locateMethod} @${e.start}-${e.end}`
        : `未定位(${e.locateMethod})`;
    console.log(`  ${e.id} [${e.dimension}/${e.kind}] ${loc}`);
    console.log(`     quote: 「${e.quote}」`);
    console.log(`     comment: ${e.comment}`);
    if (e.suggestion) console.log(`     suggest: ${e.suggestion}`);
    // 定位成功的，把原文切出来对照，这是验"模型有没有真抄对"最快的方式
    if (e.verified && e.start !== null && e.end !== null) {
      const slice = res.essay.slice(e.start, e.end);
      if (slice !== e.quote) console.log(`     ⚠ 原文切片不一致：「${slice}」`);
    }
  }

  console.log(`\n【升档建议】`);
  for (const p of res.upgradePlan) {
    console.log(`  ${p.priority}. [${p.dimension}] ${p.action}`);
    console.log(`     理由：${p.rationale}`);
    if (p.example) {
      console.log(`     before: ${p.example.before}`);
      console.log(`     after : ${p.example.after}`);
    }
    if (p.linkedEvidenceIds.length) console.log(`     关联证据：${p.linkedEvidenceIds.join(", ")}`);
  }

  if (res.warnings.length) {
    console.log(`\n【警告】`);
    for (const w of res.warnings) console.log(`  ! ${w}`);
  }

  console.log(`\n【原文】`);
  console.log(res.essay);
}
