/**
 * 分析 eval 跑出来的原始结果，把"机器能判定的问题"全挑出来。
 *
 * 分工：这个脚本负责所有可量化、可自动判定的检查（分数分布、结构合规、
 * 定位成功率、套话检测、一致性…）。剩下的"分数给得对不对、诊断说得准不准"
 * 需要人读，脚本只把可疑样本挑出来排好，不替你下结论。
 *
 * 跑法：npm run eval:analyze -- --file=.eval-out/raw-xxx.json
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord } from "./run";
import type { ReviewResult } from "../../lib/types";
import { applicableCeilings, enforcedCeilings, strictestCeiling } from "../../lib/rubric";
import { EVAL_OUT_DIR } from "./paths";

interface Raw {
  startedAt: string;
  model: string;
  records: RunRecord[];
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function pickFile(): string {
  const explicit = argValue("file");
  if (explicit) return explicit;
  const files = readdirSync(EVAL_OUT_DIR)
    .filter((f) => f.startsWith("raw-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(".eval-out 里没有 raw-*.json，先跑 npm run eval");
  return join(EVAL_OUT_DIR, files[files.length - 1]);
}

const line = (c = "─") => console.log(c.repeat(72));
const head = (s: string) => {
  console.log();
  line();
  console.log(s);
  line();
};

/** 一眼看出是不是"放之四海而皆准"的废话 */
const PLATITUDE = [
  /多(读|背|练|写|听|看)/,
  /注意语法/,
  /积累(词汇|单词|素材)/,
  /加强(练习|训练|学习)/,
  /平时(要|多)/,
  /养成(良好)?习惯/,
  /提高(英语|语言)(水平|能力)/,
  /认真(检查|审题)/,
  /扩大词汇量/,
];

function isPlatitude(s: string): string | null {
  for (const re of PLATITUDE) {
    const m = re.exec(s);
    if (m) return m[0];
  }
  return null;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`;
}

function main(): void {
  const file = pickFile();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Raw;
  const all = raw.records;
  const ok = all.filter((r) => r.ok && r.result);
  const bad = all.filter((r) => !r.ok);

  console.log(`文件：${file}`);
  console.log(`时间：${raw.startedAt}　模型：${raw.model}`);
  console.log(`共 ${all.length} 次调用，成功 ${ok.length}，失败 ${bad.length}`);

  // ---------------------------------------------------------------- 失败
  if (bad.length > 0) {
    head("✗ 调用失败");
    for (const r of bad) console.log(`  ${r.id}: ${r.error?.code} ${r.error?.message}`);
  }

  const R = (r: RunRecord) => r.result as ReviewResult;

  // ---------------------------------------------------------------- 分数
  head("① 分数分布");
  const hist = new Map<number, string[]>();
  for (const r of ok) {
    const s = R(r).score15;
    hist.set(s, [...(hist.get(s) ?? []), r.id]);
  }
  for (const s of [...hist.keys()].sort((a, b) => b - a)) {
    const ids = hist.get(s)!;
    console.log(`  ${String(s).padStart(2)} 分 │${"█".repeat(ids.length)} ${ids.join(" ")}`);
  }
  const mid = ok.filter((r) => R(r).score15 >= 7 && R(r).score15 <= 12).length;
  console.log(`\n  落在 7-12 这一大段的比例：${pct(mid, ok.length)}（越高说明区分度越差）`);

  // 期望区间命中率
  head("② 与预期档位的偏差");
  let hit = 0;
  const miss: RunRecord[] = [];
  for (const r of ok) {
    const s = R(r).score15;
    const [lo, hi] = r.expected;
    const inside = s >= lo && s <= hi;
    if (inside) hit++;
    else miss.push(r);
    const mark = inside ? "✓" : "✗";
    const delta = s < lo ? `偏低 ${lo - s}` : s > hi ? `偏高 ${s - hi}` : "";
    console.log(
      `  ${mark} ${r.id.padEnd(6)} 预期 ${String(lo).padStart(2)}-${String(hi).padEnd(2)}` +
        ` 实得 ${String(s).padStart(2)} ${delta.padEnd(8)} ${r.note}`,
    );
  }
  console.log(`\n  命中 ${hit}/${ok.length}（${pct(hit, ok.length)}）`);
  const over = miss.filter((r) => R(r).score15 > r.expected[1]).length;
  const under = miss.filter((r) => R(r).score15 < r.expected[0]).length;
  console.log(`  偏高 ${over}　偏低 ${under}　` +
    `${over > under ? "→ 系统性上浮" : under > over ? "→ 系统性压低" : "→ 无明显偏向"}`);

  // ---------------------------------------------------------------- 一致性
  head("③ 同一篇重复跑的一致性");
  const byBase = new Map<string, RunRecord[]>();
  for (const r of ok) {
    const base = r.id.split("#")[0];
    byBase.set(base, [...(byBase.get(base) ?? []), r]);
  }
  const repeated = [...byBase.entries()].filter(([, v]) => v.length > 1);
  if (repeated.length === 0) console.log("  （本次没有重复跑的用例）");
  for (const [base, group] of repeated) {
    const scores = group.map((g) => R(g).score15);
    const spread = Math.max(...scores) - Math.min(...scores);
    console.log(
      `  ${spread === 0 ? "✓" : spread <= 1 ? "~" : "✗"} ${base.padEnd(6)} ` +
        `分数 ${scores.join(" / ")}　极差 ${spread}`,
    );
  }

  // ---------------------------------------------------------------- 结构
  head("④ 结构合规");
  let dimOk = 0, evOk = 0, planOk = 0, prioOk = 0, dimCovered = 0;
  // 本轮改动的立论就是"example 在实际输出里经常缺席"，所以次数要**按条**统计
  // 而不是按篇——按篇统计的话，一篇里 3 条建议只给了 1 个示范也算"这一篇有示范"，
  // 提示词改动到底是把 40% 提到 90% 还是从 40% 提到 45%，就完全看不出来。
  let exGiven = 0, exTotal = 0, exUnverified = 0, trainOk = 0;
  const structBad: string[] = [];
  for (const r of ok) {
    const res = R(r);
    const dims = res.dimensionScores.length === 3;
    const ev = res.stats.evidenceCount >= 5 && res.stats.evidenceCount <= 15;
    const plan = res.upgradePlan.length >= 3 && res.upgradePlan.length <= 5;
    const prio = res.upgradePlan.every((p, i) => p.priority === i + 1);
    const covered = ["content", "language", "organization"].every((d) =>
      res.evidence.some((e) => e.dimension === d),
    );
    // 旧存档没有这个键（lib/store.ts 是盲 as ReviewResult），`?? []` 不是多余的防御
    const training = res.trainingPlan ?? [];
    const trained = training.length > 0 && training.length <= 3;
    const badEx = res.upgradePlan.filter((p) => p.exampleUnverified).length;
    exTotal += res.upgradePlan.length;
    exGiven += res.upgradePlan.filter((p) => p.example).length;
    exUnverified += badEx;

    if (dims) dimOk++;
    if (ev) evOk++;
    if (plan) planOk++;
    if (prio) prioOk++;
    if (covered) dimCovered++;
    if (trained) trainOk++;
    const problems = [
      !dims && "维度分不是 3 项",
      !ev && `证据 ${res.stats.evidenceCount} 条（要求 5-15）`,
      !plan && `升档建议 ${res.upgradePlan.length} 条（要求 3-5）`,
      !prio && "priority 不连续",
      !covered && "有维度没有证据",
      // 训练区缺席**不算问题**（"这篇没有反复出现的毛病"是合法结论），
      // 所以不列进 problems，只在下面看出现率
      training.length > 3 && `训练项 ${training.length} 条（上限 3）`,
      badEx > 0 && `有 ${badEx} 条示范没能在原文定位`,
    ].filter(Boolean);
    if (problems.length) structBad.push(`  ✗ ${r.id.padEnd(6)} ${problems.join("；")}`);
  }
  console.log(`  维度分齐全：      ${pct(dimOk, ok.length)}`);
  console.log(`  证据条数 5-15：   ${pct(evOk, ok.length)}`);
  console.log(`  升档建议 3-5 条： ${pct(planOk, ok.length)}`);
  console.log(`  priority 连续：   ${pct(prioOk, ok.length)}`);
  console.log(`  三维度都有证据：  ${pct(dimCovered, ok.length)}`);
  console.log(`  升档示范覆盖率：  ${pct(exGiven, exTotal)}（${exGiven}/${exTotal} 条建议给了示范，越高越好）`);
  console.log(`  示范未能定位：    ${exUnverified} 条${exUnverified > 0 ? "  ← 模型编了原文里没有的句子，要人看" : ""}`);
  console.log(`  训练区出现率：    ${pct(trainOk, ok.length)}（缺席是合法的，不必强求 100%）`);
  if (structBad.length) console.log("\n" + structBad.join("\n"));

  // ---------------------------------------------------------------- 证据
  head("⑤ 证据定位");
  const methods = new Map<string, number>();
  let evTotal = 0, evVerified = 0;
  const unverifiedIds: string[] = [];
  for (const r of ok) {
    for (const e of R(r).evidence) {
      evTotal++;
      methods.set(e.locateMethod, (methods.get(e.locateMethod) ?? 0) + 1);
      if (e.verified) evVerified++;
      else unverifiedIds.push(`${r.id}:${e.id}「${e.quote.slice(0, 30)}」`);
    }
  }
  console.log(`  总证据 ${evTotal} 条，定位成功 ${evVerified}（${pct(evVerified, evTotal)}）`);
  for (const [m, n] of [...methods.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${m.padEnd(12)} ${String(n).padStart(3)}  ${pct(n, evTotal)}`);
  }
  if (unverifiedIds.length) {
    console.log(`\n  未能定位的 ${unverifiedIds.length} 条（模型没逐字抄）：`);
    for (const s of unverifiedIds) console.log(`    ${s}`);
  }

  // 引文长度
  head("⑥ 引文长度（prompt 要求 5-40 词）");
  const lens: Array<{ id: string; words: number; q: string }> = [];
  for (const r of ok) {
    for (const e of R(r).evidence) {
      const words = (e.quote.match(/[A-Za-z0-9]+/g) ?? []).length;
      lens.push({ id: `${r.id}:${e.id}`, words, q: e.quote });
    }
  }
  const short = lens.filter((l) => l.words < 3);
  const long = lens.filter((l) => l.words > 40);
  console.log(`  平均 ${(lens.reduce((a, b) => a + b.words, 0) / lens.length).toFixed(1)} 词`);
  console.log(`  < 3 词（太短，容易多义）：${short.length}`);
  for (const l of short) console.log(`    ${l.id} 「${l.q.slice(0, 50)}」`);
  console.log(`  > 40 词（违背 prompt 要求）：${long.length}`);
  for (const l of long) console.log(`    ${l.id} ${l.words} 词「${l.q.slice(0, 60)}…」`);

  // kind 分布
  head("⑦ kind 分布（全标 major 等于没有区分度）");
  const kinds = new Map<string, number>();
  for (const r of ok) for (const e of R(r).evidence) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  for (const k of ["strength", "minor", "major"]) {
    const n = kinds.get(k) ?? 0;
    console.log(`  ${k.padEnd(10)} ${String(n).padStart(3)}  ${pct(n, evTotal)}`);
  }
  const allMajor = ok.filter((r) => {
    const evs = R(r).evidence;
    return evs.length > 0 && evs.every((e) => e.kind === "major");
  });
  if (allMajor.length) console.log(`  全 major 的作文：${allMajor.map((r) => r.id).join(" ")}`);

  // ---------------------------------------------------------------- 升档建议
  head("⑧ 升档建议质量");
  const plans = ok.flatMap((r) => R(r).upgradePlan.map((p) => ({ id: r.id, ...p })));
  const plat = plans.filter((p) => isPlatitude(p.action) || isPlatitude(p.rationale));
  const withExample = plans.filter((p) => p.example);
  const beforeFromEssay = plans.filter((p) => {
    if (!p.example) return false;
    const res = R(ok.find((r) => r.id === p.id)!);
    return res.essay.includes(p.example.before.trim());
  });
  console.log(`  共 ${plans.length} 条建议`);
  console.log(`  带 before/after 示范：${pct(withExample.length, plans.length)}`);
  console.log(`  示范的 before 逐字来自原文：${pct(beforeFromEssay.length, withExample.length)}`);
  console.log(`  疑似套话：${plat.length}`);
  for (const p of plat) console.log(`    ${p.id} 「${p.action}」`);

  // ---------------------------------------------------------------- 警告
  head("⑨ 系统警告汇总");
  const withWarn = ok.filter((r) => R(r).warnings.length > 0);
  console.log(`  ${withWarn.length}/${ok.length} 篇产生了警告`);
  const warnTexts = new Map<string, number>();
  for (const r of ok) {
    for (const w of R(r).warnings) {
      const key = w.replace(/\d+/g, "N");
      warnTexts.set(key, (warnTexts.get(key) ?? 0) + 1);
    }
  }
  for (const [w, n] of [...warnTexts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ×${n}  ${w}`);
  }

  // ---------------------------------------------------------------- 自洽性
  head("⑩ 自洽性（总分是否被自己的诊断支撑）");
  console.log("  规则来自 lib/rubric.ts 的 CEILING_RULES。prompt 里给模型的是完整规则表，");
  console.log("  代码只强制其中不会被单条标注噪声触发的几条（enforced）。\n");
  const ctxOf = (res: ReviewResult) => {
    const dim = (d: string) =>
      res.dimensionScores.find((x) => x.dimension === d)?.score ?? null;
    return {
      majorCount: res.evidence.filter((e) => e.kind === "major").length,
      organizationScore: dim("organization"),
      contentScore: dim("content"),
      wordCount: res.stats.wordCount,
      paragraphCount: res.stats.paragraphCount,
    };
  };

  let violated = 0, corrected = 0, wouldViolate = 0;
  const violList: string[] = [];
  const wouldList: string[] = [];
  for (const r of ok) {
    const res = R(r);
    const ctx = ctxOf(res);
    const cap = strictestCeiling(enforcedCeilings(ctx));
    if (cap && res.score15 > cap.maxScore) {
      violated++;
      violList.push(`  ✗ ${r.id.padEnd(6)} 得分 ${res.score15} > 强制上限 ${cap.maxScore}（${cap.id}）`);
    }
    const softCap = strictestCeiling(applicableCeilings(ctx));
    if (softCap && res.score15 > softCap.maxScore) {
      wouldViolate++;
      wouldList.push(`  ~ ${r.id.padEnd(6)} 得分 ${res.score15} > 完整规则上限 ${softCap.maxScore}（${softCap.id}，未强制）`);
    }
    if (res.warnings.some((w) => w.includes("分数已由系统校正"))) corrected++;
  }
  console.log(`  违反【强制】上限的：${violated}/${ok.length}${violated === 0 ? "  ✓" : ""}`);
  for (const s of violList) console.log(s);
  console.log(`  被系统强制校正过分数的：${corrected} 篇`);
  console.log(`\n  超出【完整】规则表（含未强制的软规则）的：${wouldViolate} 篇`);
  console.log("  这些是模型该自己守住、但没守住的——用来判断 prompt 里的指引够不够用：");
  for (const s of wouldList) console.log(s);

  console.log("\n  各规则触发次数（触发 = 这条规则在该篇上给出了上限）：");
  const ruleHits = new Map<string, { n: number; enforced: boolean }>();
  for (const r of ok) {
    const ctx = ctxOf(R(r));
    for (const c of applicableCeilings(ctx)) {
      const prev = ruleHits.get(c.id);
      ruleHits.set(c.id, { n: (prev?.n ?? 0) + 1, enforced: prev?.enforced ?? false });
    }
    for (const c of enforcedCeilings(ctx)) {
      const prev = ruleHits.get(c.id);
      ruleHits.set(c.id, { n: prev?.n ?? 0, enforced: true });
    }
  }
  for (const [id, v] of [...ruleHits.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${id.padEnd(19)} ×${String(v.n).padStart(2)}  ${v.enforced ? "强制" : "仅 prompt"}`);
  }

  // ---------------------------------------------------------------- organization
  head("⑪ organization 维度是否在真谈结构");
  const CONNECTIVE = /^(First|Second|Third|Firstly|Secondly|Thirdly|In conclusion|In short|All in all|Another reason|The most common|Besides|Moreover|Furthermore|However|Therefore|To sum up|Last)/i;
  let orgTotal = 0, orgConn = 0;
  const orgConnIds: string[] = [];
  const orgDist = new Map<number, number>();
  const fakeStruct: string[] = [];
  for (const r of ok) {
    const res = R(r);
    const orgScore = res.dimensionScores.find((d) => d.dimension === "organization")?.score;
    if (orgScore !== undefined) orgDist.set(orgScore, (orgDist.get(orgScore) ?? 0) + 1);
    // 只有一段的长文却给组织高分，就是没看客观统计
    if (orgScore !== undefined && orgScore >= 4 && res.stats.paragraphCount <= 1 && res.stats.wordCount >= 100) {
      fakeStruct.push(`  ✗ ${r.id.padEnd(6)} ${res.stats.wordCount} 词只有 1 段，organization 却给了 ${orgScore}/5`);
    }
    for (const e of res.evidence) {
      if (e.dimension !== "organization") continue;
      orgTotal++;
      if (CONNECTIVE.test(e.quote.trim())) {
        orgConn++;
        orgConnIds.push(`${r.id}:${e.id}`);
      }
    }
  }
  console.log(`  organization 证据 ${orgTotal} 条，其中以连接词开头、只证明"这里有过渡词"的 ${orgConn} 条（${pct(orgConn, orgTotal)}）`);
  if (orgConnIds.length) console.log(`    ${orgConnIds.join(" ")}`);
  console.log(`\n  organization 维度分分布（只有 4 和 5 说明这一项没有区分度）：`);
  for (const [s, n] of [...orgDist.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`    ${s}/5  ×${n}`);
  }
  console.log(`\n  单段长文却拿到 organization ≥4/5 的：${fakeStruct.length}`);
  for (const s of fakeStruct) console.log(s);

  // ---------------------------------------------------------------- 重复引文
  // 口径与 lib/review.ts 的警告一致：只算**同维度内**的重复。跨维度复用在
  // 评测里全是正常的（一句话同时是内容证据和结构证据），算进来只会变成假阳性。
  head("⑫ 重复引文（同一维度里，同一段原文被用在多条证据里）");
  let dupRuns = 0, dupTotal = 0, crossDim = 0;
  for (const r of ok) {
    const res = R(r);
    const seen = new Map<string, string[]>();
    for (const e of res.evidence) {
      const k = `${e.dimension}::${e.quote.trim()}`;
      seen.set(k, [...(seen.get(k) ?? []), `${e.id}/${e.dimension}/${e.kind}`]);
    }
    const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
    if (dups.length) {
      dupRuns++;
      dupTotal += dups.length;
      for (const [k, ids] of dups) {
        console.log(`  ${r.id.padEnd(6)} ${ids.join(" + ")}  「${k.split("::")[1].slice(0, 42)}」`);
      }
    }
    // 单单统计跨维度复用，作为参考（不计入问题）
    const byQuote = new Map<string, Set<string>>();
    for (const e of res.evidence) {
      const q = e.quote.trim();
      byQuote.set(q, (byQuote.get(q) ?? new Set()).add(e.dimension));
    }
    crossDim += [...byQuote.values()].filter((d) => d.size > 1).length;
  }
  console.log(`\n  ${dupRuns}/${ok.length} 篇有同维度重复引文，共 ${dupTotal} 处`);
  console.log(`  （另有 ${crossDim} 处是跨维度复用同一句，属正常，不计入）`);

  // ---------------------------------------------------------------- 汇总
  head("⑬ 最需要人读的样本");
  const needsEyes = new Set<string>();
  for (const r of ok) {
    const res = R(r);
    const s = res.score15;
    if (s < r.expected[0] || s > r.expected[1]) needsEyes.add(r.id);
    if (res.warnings.length > 0) needsEyes.add(r.id);
    if (res.evidence.some((e) => !e.verified)) needsEyes.add(r.id);
    const evs = res.evidence;
    if (evs.length > 0 && evs.every((e) => e.kind === "major")) needsEyes.add(r.id);
    // 单段长文却拿到组织高分，或引用被重复使用
    const orgScore = res.dimensionScores.find((d) => d.dimension === "organization")?.score;
    if (orgScore !== undefined && orgScore >= 4 && res.stats.paragraphCount <= 1 && res.stats.wordCount >= 100) {
      needsEyes.add(r.id);
    }
    // 同上：只看同维度重复，跨维度复用不算需要人工复核
    if (new Set(evs.map((e) => `${e.dimension}::${e.quote.trim()}`)).size < evs.length) {
      needsEyes.add(r.id);
    }
  }
  for (const r of repeated) {
    const scores = r[1].map((g) => R(g).score15);
    if (Math.max(...scores) - Math.min(...scores) > 1) needsEyes.add(r[0]);
  }
  console.log(`  ${[...needsEyes].join(" ") || "（无）"}`);
  console.log("\n  读法：npm run eval:show -- --file=" + file + " --id=<id>");
}

main();
