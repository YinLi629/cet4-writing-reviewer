/**
 * 生成一份**自包含**的 HTML 批改报告。
 *
 * 自包含的意思是：样式全部内联，不引用任何外部资源、不依赖 JS。
 * 生成出来的 .html 可以直接双击打开、发给老师、或者用浏览器打印成 PDF。
 *
 * ⚠️ 安全：作文原文和模型输出都会进到这份 HTML 里，两者都是不可信输入。
 * 所有插值一律走 escapeHtml()。不要图省事把原文整段拼进去——
 * 学生作文里出现一个 `<script>` 就能让生成的报告变成 XSS 载体。
 */

import { segmentEssay } from "./highlight";
import { KIND_LABEL, METHOD_LABEL } from "./labels";
import type { Evidence, ReviewResult } from "./types";
import { DIMENSION_LABEL } from "./types";

export function escapeHtml(input: string): string {
  return input.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}

/**
 * 渲染带高亮的原文。
 *
 * 注意顺序：**先按字符区间切段，再逐段转义**。绝不能先把整篇转义再插标签——
 * 转义会改变字符长度（`<` 变成 `&lt;`），之后所有的偏移量全部错位。
 */
export function renderHighlightedEssay(essay: string, evidence: Evidence[]): string {
  const segments = segmentEssay(essay, evidence);

  return segments
    .map((seg) => {
      const safe = escapeHtml(seg.text);
      if (!seg.kind) return safe;
      return (
        `<mark class="ev ev-${seg.kind}" id="anchor-${escapeHtml(seg.ids[0])}" ` +
        `data-ids="${escapeHtml(seg.ids.join(" "))}">${safe}</mark>`
      );
    })
    .join("");
}

function evidenceCard(e: Evidence): string {
  const locatable = e.start !== null && e.end !== null;
  return `
  <div class="card ev-card ev-card-${e.kind}" id="card-${escapeHtml(e.id)}">
    <div class="ev-head">
      <span class="badge badge-${e.kind}">${KIND_LABEL[e.kind]}</span>
      <span class="dim">${escapeHtml(DIMENSION_LABEL[e.dimension])}</span>
      ${
        locatable
          ? `<span class="loc" title="${escapeHtml(METHOD_LABEL[e.locateMethod])}">原文第 ${e.start}–${e.end} 字符</span>`
          : `<span class="loc loc-bad">${escapeHtml(METHOD_LABEL[e.locateMethod])}</span>`
      }
    </div>
    <blockquote>${escapeHtml(e.quote)}</blockquote>
    <p class="ev-comment">${escapeHtml(e.comment)}</p>
    ${
      e.suggestion
        ? `<p class="ev-suggestion"><strong>建议：</strong>${escapeHtml(e.suggestion)}</p>`
        : ""
    }
  </div>`;
}

function upgradeCard(a: ReviewResult["upgradePlan"][number], index: number): string {
  const links = a.linkedEvidenceIds
    .map((id) => `<a class="chip" href="#card-${escapeHtml(id)}">${escapeHtml(id)}</a>`)
    .join("");

  return `
  <div class="card up-card">
    <div class="up-head">
      <span class="pri">优先 ${index + 1}</span>
      <span class="dim">${escapeHtml(DIMENSION_LABEL[a.dimension])}</span>
      ${links ? `<span class="chips">证据 ${links}</span>` : ""}
    </div>
    <p class="up-action">${escapeHtml(a.action)}</p>
    <p class="up-rationale">${escapeHtml(a.rationale)}</p>
    ${
      a.example
        ? `<div class="ex">
             <div class="ex-row"><span class="ex-tag ex-before">原</span><span>${escapeHtml(a.example.before)}</span></div>
             <div class="ex-row"><span class="ex-tag ex-after">改</span><span>${escapeHtml(a.example.after)}</span></div>
           </div>`
        : ""
    }
  </div>`;
}

const REPORT_CSS = `
  :root {
    --ink: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --bg: #fafaf8;
    --card: #ffffff; --accent: #1f6feb;
    --strength: #1a7f4b; --strength-bg: #e8f5ee;
    --minor: #b06a00; --minor-bg: #fdf3e2;
    --major: #c0392b; --major-bg: #fdecea;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    line-height: 1.7;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 36px 0 12px; padding-bottom: 8px; border-bottom: 2px solid var(--line); }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; margin-bottom: 12px; }

  .scoreboard { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .score-main { flex: 1 1 240px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; }
  .score-big { font-size: 42px; font-weight: 700; line-height: 1; }
  .score-big small { font-size: 16px; font-weight: 400; color: var(--muted); }
  .score-106 { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .band-pill { display: inline-block; margin-top: 12px; padding: 4px 12px; border-radius: 999px;
               background: var(--accent); color: #fff; font-size: 14px; font-weight: 600; }
  .band-desc { flex: 1 1 300px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px; font-size: 14px; }
  .band-desc .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }

  .stats { display: flex; gap: 24px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-top: 12px; }
  .stats b { color: var(--ink); }

  .warn { background: var(--minor-bg); border: 1px solid #f0d9b0; border-radius: 8px; padding: 14px 18px; margin-bottom: 12px; font-size: 14px; }
  .warn ul { margin: 8px 0 0; padding-left: 20px; }

  .dims { display: flex; gap: 12px; flex-wrap: wrap; }
  .dim-card { flex: 1 1 220px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .dim-name { font-weight: 600; margin-bottom: 8px; }
  .meter { height: 6px; background: var(--line); border-radius: 3px; overflow: hidden; margin-bottom: 10px; }
  .meter i { display: block; height: 100%; background: var(--accent); }
  .dim-comment { font-size: 13px; color: #444; margin: 0; }
  .dim-note { font-size: 12px; color: var(--muted); margin: 10px 0 0; font-style: italic; }

  .essay { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 20px;
           white-space: pre-wrap; font-size: 15px; line-height: 2; }
  mark.ev { padding: 2px 1px; border-radius: 3px; cursor: help; }
  mark.ev-strength { background: var(--strength-bg); border-bottom: 2px solid var(--strength); }
  mark.ev-minor { background: var(--minor-bg); border-bottom: 2px solid var(--minor); }
  mark.ev-major { background: var(--major-bg); border-bottom: 2px solid var(--major); }

  .ev-head, .up-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .badge { font-size: 12px; padding: 2px 9px; border-radius: 999px; font-weight: 600; }
  .badge-strength { background: var(--strength-bg); color: var(--strength); }
  .badge-minor { background: var(--minor-bg); color: var(--minor); }
  .badge-major { background: var(--major-bg); color: var(--major); }
  .dim { font-size: 12px; color: var(--muted); border: 1px solid var(--line); padding: 2px 8px; border-radius: 999px; }
  .loc { font-size: 12px; color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
  .loc-bad { color: var(--major); }
  .ev-card { border-left: 3px solid var(--line); }
  .ev-card-strength { border-left-color: var(--strength); }
  .ev-card-minor { border-left-color: var(--minor); }
  .ev-card-major { border-left-color: var(--major); }
  blockquote { margin: 0 0 10px; padding: 8px 14px; background: var(--bg); border-radius: 6px;
               font-family: Georgia, "Times New Roman", serif; font-size: 14px; color: #333; }
  .ev-comment { margin: 0 0 6px; font-size: 14px; }
  .ev-suggestion { margin: 0; font-size: 13px; color: #444; }
  .pri { font-size: 12px; font-weight: 700; color: #fff; background: var(--accent); padding: 2px 10px; border-radius: 999px; }
  .chips { margin-left: auto; font-size: 12px; color: var(--muted); }
  .chip { display: inline-block; margin-left: 4px; padding: 1px 7px; border-radius: 4px;
          background: var(--bg); border: 1px solid var(--line); color: var(--accent); text-decoration: none; font-variant-numeric: tabular-nums; }
  .up-action { font-weight: 600; margin: 0 0 6px; font-size: 15px; }
  .up-rationale { margin: 0; font-size: 13px; color: #555; }
  .ex { margin-top: 12px; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .ex-row { display: flex; gap: 10px; padding: 9px 12px; font-size: 14px; align-items: flex-start; }
  .ex-row + .ex-row { border-top: 1px solid var(--line); }
  .ex-tag { flex: 0 0 auto; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 4px; }
  .ex-before { background: var(--major-bg); color: var(--major); }
  .ex-after { background: var(--strength-bg); color: var(--strength); }

  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12px; line-height: 1.9; }
  ul.plain { padding-left: 20px; margin: 0; font-size: 14px; }

  @media print {
    body { background: #fff; padding: 0; }
    .card, .score-main, .band-desc, .dim-card, .essay { break-inside: avoid; }
    .chip { color: var(--ink); }
  }
`;

export interface ReportHtmlOptions {
  /** 报告标题，默认「四级作文批改报告」 */
  title?: string;
}

/** 生成完整的自包含 HTML 字符串 */
export function buildReportHtml(
  result: ReviewResult,
  options: ReportHtmlOptions = {},
): string {
  const title = options.title ?? "四级作文批改报告";
  const { band, score15, score106, stats, meta } = result;

  const created = new Date(meta.createdAt);
  const createdText = Number.isNaN(created.getTime())
    ? meta.createdAt
    : created.toLocaleString("zh-CN", { hour12: false });

  const dims = result.dimensionScores
    .map(
      (d) => `
    <div class="dim-card">
      <div class="dim-name">${escapeHtml(DIMENSION_LABEL[d.dimension])} <span style="color:var(--muted);font-weight:400">${d.score}/5</span></div>
      <div class="meter"><i style="width:${Math.round((d.score / 5) * 100)}%"></i></div>
      <p class="dim-comment">${escapeHtml(d.comment)}</p>
    </div>`,
    )
    .join("");

  const strengths = result.strengths.length
    ? `<h2>做对了什么</h2><div class="card"><ul class="plain">${result.strengths
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ul></div>`
    : "";

  const warnings = result.warnings.length
    ? `<div class="warn"><strong>需要注意（关于本报告的可信度）</strong><ul>${result.warnings
        .map((w) => `<li>${escapeHtml(w)}</li>`)
        .join("")}</ul></div>`
    : "";

  const evidenceCards = result.evidence.map(evidenceCard).join("");
  const upgradeCards = result.upgradePlan.map(upgradeCard).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(band.label)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">

  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${meta.topic ? `题目：${escapeHtml(meta.topic)} · ` : ""}生成于 ${escapeHtml(createdText)}</div>

  ${warnings}

  <div class="scoreboard">
    <div class="score-main">
      <div class="score-big">${score15}<small> / 15</small></div>
      <div class="score-106">折算 <b>${score106}</b> 分（作文满分 106.5）</div>
      <div class="band-pill">${escapeHtml(band.label)}　${band.range[0]}–${band.range[1]} 分</div>
    </div>
    <div class="band-desc">
      <div class="label">本档官方描述</div>
      ${escapeHtml(band.descriptor)}
      <div class="stats">
        <span><b>${stats.wordCount}</b> 词</span>
        <span><b>${stats.sentenceCount}</b> 句</span>
        <span><b>${stats.paragraphCount}</b> 段</span>
        <span><b>${stats.verifiedCount}/${stats.evidenceCount}</b> 条证据已定位</span>
      </div>
    </div>
  </div>

  <h2>总评</h2>
  <div class="card">${escapeHtml(result.summary)}</div>

  ${strengths}

  <h2>维度诊断</h2>
  <div class="dims">${dims}</div>
  <p class="dim-note">四级作文采用整体评分法，上表维度分仅用于显示强弱分布，不参与总分计算。</p>

  <h2>升档建议</h2>
  ${upgradeCards || '<div class="card">本次没有生成升档建议。</div>'}

  <h2>证据溯源（${stats.evidenceCount} 条）</h2>
  ${evidenceCards}

  <h2>原文批注</h2>
  <div class="essay">${renderHighlightedEssay(
    result.essay ?? "",
    result.evidence,
  )}</div>

  <footer>
    批改模型：${escapeHtml(meta.model)}　·　耗时 ${(meta.elapsedMs / 1000).toFixed(1)} 秒<br>
    评分标准：CET-4 作文整体评分法（15 分制，折算 106.5 分）　·　标准版本 ${escapeHtml(meta.rubricVersion)}　·　报告生成 ${escapeHtml(createdText)}<br>
    分数为模型辅助评判结果，仅供练习参考，不代表考试成绩。
  </footer>

</div>
</body>
</html>`;
}
