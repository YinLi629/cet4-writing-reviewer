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

import { ANCHOR_PREFIX, anchorMap, CARD_PREFIX, segmentEssay } from "./highlight";
import {
  AMBIGUITY_LABEL,
  KIND_DEGRADED_HINT,
  KIND_LABEL,
  METHOD_LABEL,
  TRAINING_FOCUS_LABEL,
} from "./labels";
import { TRAINING_PLAYBOOK } from "./training";
import type { Evidence, ReviewResult, TrainingItem } from "./types";
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
 *
 * 每个 `<mark>` 里裹着一个指向证据卡片的链接。**报告是零 JS 的**，所以来回两个
 * 方向都只能靠朴素的 `#锚点`：浏览器原生就会跳，跳过去的高亮块由 CSS 的
 * `:target` 自己亮起来。同理，这里也不能用 onclick——那会让整份报告在
 * 禁用脚本的环境（邮件客户端、PDF 导出、某些预览器）里失去全部交互。
 */
export function renderHighlightedEssay(essay: string, evidence: Evidence[]): string {
  const segments = segmentEssay(essay, evidence);

  return segments
    .map((seg) => {
      const safe = escapeHtml(seg.text);
      if (!seg.kind || seg.ids.length === 0) return safe;
      // 合并块里只认第一条证据当锚点，和 anchorMap 保持一致
      const primary = escapeHtml(seg.ids[0]);
      return (
        `<mark class="ev ev-${seg.kind}" id="${ANCHOR_PREFIX}${primary}" ` +
        `data-ids="${escapeHtml(seg.ids.join(" "))}">` +
        `<a class="ev-link" href="#${CARD_PREFIX}${primary}">${safe}</a>` +
        `</mark>`
      );
    })
    .join("");
}

/**
 * 一张证据卡片。
 *
 * `anchors` 是「证据 id → 原文锚点元素 id」的映射（lib/highlight.ts 的 anchorMap）。
 * 必须查表而不是自己拼 `anchor-${e.id}`：重叠的证据会被合并进同一个 `<mark>`，
 * 只有其中第一条能当上 id，其余的自己拼就会指向不存在的元素。
 */
function evidenceCard(e: Evidence, anchors: Map<string, string>): string {
  const locatable = e.start !== null && e.end !== null;
  const anchor = anchors.get(e.id);
  const method = escapeHtml(METHOD_LABEL[e.locateMethod]);

  // 歧义徽章。**必须和定位方式并列出现**，不能被它顶替：徽章上写着"逐字命中原文"
  // 的同时还挂着"多处匹配"，才是这份引文真实的可信度。只在有歧义时才渲染
  const amb = e.ambiguity ? AMBIGUITY_LABEL[e.ambiguity] : null;
  const ambChip = amb
    ? `<span class="amb" title="${escapeHtml(amb.full)}">${amb.short}${
        e.hitCount && e.hitCount > 1 ? `（${e.hitCount} 处）` : ""
      }</span>`
    : "";

  return `
  <div class="card ev-card ev-card-${e.kind}" id="${CARD_PREFIX}${escapeHtml(e.id)}">
    <div class="ev-head">
      <span class="badge badge-${e.kind}"${
        e.kindDegraded ? ` title="${escapeHtml(KIND_DEGRADED_HINT)}" data-degraded="1"` : ""
      }>${KIND_LABEL[e.kind]}</span>
      <span class="dim">${escapeHtml(DIMENSION_LABEL[e.dimension])}</span>
      ${
        locatable && anchor
          ? `<a class="loc loc-link" href="#${anchor}" title="${method} —— 点击跳到原文的这一处">原文第 ${e.start}–${e.end} 字符</a>`
          : locatable
            ? `<span class="loc" title="${method}">原文第 ${e.start}–${e.end} 字符</span>`
            : `<span class="loc loc-bad">${method}</span>`
      }
      ${ambChip}
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
           </div>` +
          // 示范里的"原句"没能在原文里定位到 = 模型很可能自己造了一句原文里没有的话。
          // 不说出来的话，这份示范看起来和真的一模一样，学生照着一条不存在的
          // "原句"去对照只会更困惑。判定见 lib/review.ts 的 locateExampleQuote
          (a.exampleUnverified
            ? `<p class="ex-flag">上面那个「原句」没能在原文中逐字找到，模型可能自己造了句子——请以原文为准。</p>`
            : "")
        : // 没有示范时不能留白：留白和"渲染坏了"长得一样。但也要说清这不是错误，
          // 所以走中性配色的 .ex-flag-quiet
          `<p class="ex-flag ex-flag-quiet">${
            a.dimension === "organization"
              ? "本条没有改写示范。结构类的建议有时落不到某一个句子上，照上面那句话做即可。"
              : "本条没有改写示范，模型这次没能给出可照抄的句子——建议按上面那句话自己动手改一遍。"
          }</p>`
    }
  </div>`;
}

/**
 * 一张训练卡。
 *
 * 和 React 那边的 components/TrainingPlan.tsx 结构一一对应，两边要一起改。
 * 卡片里有两块来源不同的内容，必须靠 `.train-plain` 的浅底 + `.train-note`
 * 那句说明区分开：`reason` 是模型针对这一篇写的，其余是同一类别的所有学生
 * 都会看到的通用练法。混在一起，学生会把通用建议误当成针对自己的诊断。
 */
function trainingCard(t: TrainingItem): string {
  const book = TRAINING_PLAYBOOK[t.focus];
  const label = escapeHtml(TRAINING_FOCUS_LABEL[t.focus]);
  const links = t.linkedEvidenceIds
    .map((id) => `<a class="chip" href="#card-${escapeHtml(id)}">${escapeHtml(id)}</a>`)
    .join("");

  return `
  <div class="card train-card">
    <div class="train-head">
      <span class="chip chip-solid">${label}</span>
      ${links ? `<span class="chips">相关证据 ${links}</span>` : ""}
    </div>
    <p class="train-reason">${escapeHtml(t.reason)}</p>
    <div class="train-plain">
      <p class="train-note">以下是「${label}」这一类问题的通用练法，不是针对你这一篇写的。</p>
      <p class="train-symptom">${escapeHtml(book.symptom)}</p>
      <p class="train-label">写作时怎么做</p>
      <ul class="plain">${book.howTo.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
      <p class="train-label">平时怎么练</p>
      <ul class="plain">${book.drills.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
      <p class="train-watch"><strong>当心：</strong>${escapeHtml(book.watchOut)}</p>
    </div>
  </div>`;
}

const REPORT_CSS = `
  :root {
    /*
     * 令牌值和 app/globals.css 的浅色一套对齐——报告是网页的另一种渲染，
     * 不是另一套设计。网页换配色时这里要跟着换，否则下载下来会比网页旧一个版本。
     *
     * 报告**只有浅色**：它会被打印、会被发出去、会脱离浏览器设置单独存在，
     * 跟着开关变深色只会在纸上变成一片黑。color-scheme 也写死 light，
     * 否则深色系统的浏览器会把滚动条和表单控件画成深色，贴在奶油底上很脏。
     */
    color-scheme: light;

    --ink: #2c2436; --ink-2: #55495f; --muted: #6f6478;
    --line: #ebe2d9;
    --bg: #faf7f4; --card: #ffffff; --surface-2: #f3ede6;
    --accent: #5fd8c4; --accent-ink: #0c4a45;
    /* 薄荷绿是浅底深字用的底色，不能拿来当文字色：奶油底上读不清 */
    --link: #0f766e;
    --strength: #15803d; --strength-bg: #e9f7ef;
    --minor: #a16207; --minor-bg: #fdf4e3; --minor-line: #e8c98a;
    --major: #b91c1c; --major-bg: #fdeceb;
    --radius: 16px; --radius-sm: 10px; --radius-pill: 999px;
    --shadow: 0 1px 2px rgba(58, 42, 32, .05), 0 4px 12px rgba(58, 42, 32, .06);
    --serif: Georgia, "Times New Roman", "Songti SC", "SimSun", serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px; background: var(--bg); color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei",
                 "PingFang SC", "Hiragino Sans GB", sans-serif;
    line-height: 1.7;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 {
    font-size: 17px; margin: 36px 0 12px; padding-bottom: 8px;
    /* 一条发丝线，开头一段是薄荷——和网页上的 .section-title 同一个做法 */
    background-image: linear-gradient(90deg, var(--accent), var(--line) 140px, var(--line));
    background-repeat: no-repeat; background-position: 0 100%; background-size: 100% 2px;
  }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius);
          padding: 16px 18px; margin-bottom: 12px; box-shadow: var(--shadow); }

  .scoreboard { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .score-main { flex: 1 1 240px; background: var(--card); border: 1px solid var(--line);
                border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); }
  .score-big { font-size: 42px; font-weight: 700; line-height: 1; }
  .score-big small { font-size: 16px; font-weight: 400; color: var(--muted); }
  .score-106 { color: var(--muted); font-size: 14px; margin-top: 6px; }
  .band-pill { display: inline-block; margin-top: 12px; padding: 4px 12px; border-radius: var(--radius-pill);
               background: var(--accent); color: var(--accent-ink); font-size: 14px; font-weight: 600; }
  .band-desc { flex: 1 1 300px; background: var(--card); border: 1px solid var(--line);
               border-radius: var(--radius); padding: 20px; font-size: 14px; box-shadow: var(--shadow); }
  .band-desc .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }

  .stats { display: flex; gap: 24px; flex-wrap: wrap; color: var(--muted); font-size: 13px; margin-top: 12px; }
  .stats b { color: var(--ink); }

  .warn { background: var(--minor-bg); border: 1px solid var(--minor-line); border-radius: var(--radius);
          padding: 14px 18px; margin-bottom: 12px; font-size: 14px; }
  .warn ul { margin: 8px 0 0; padding-left: 20px; }

  .dims { display: flex; gap: 12px; flex-wrap: wrap; }
  .dim-card { flex: 1 1 220px; background: var(--card); border: 1px solid var(--line);
              border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow); }
  .dim-name { font-weight: 600; margin-bottom: 8px; }
  .meter { height: 8px; background: var(--line); border-radius: var(--radius-pill); overflow: hidden; margin-bottom: 10px; }
  /*
   * 从 0 长到行内 width 指定的终点。在浏览器里打开报告时条会生长，
   * 打印时关掉（见下）——不然打印预览可能抓到动画的第一帧，一条空槽。
   */
  @keyframes grow { from { width: 0; } }
  .meter i { display: block; height: 100%; background: var(--accent);
             animation: grow .7s cubic-bezier(.16, 1, .3, 1) both; }
  .dim-comment { font-size: 13px; color: var(--ink-2); margin: 0; }
  .dim-note { font-size: 12px; color: var(--muted); margin: 10px 0 0; font-style: italic; }

  .essay { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px;
           white-space: pre-wrap; font-size: 15px; line-height: 2; box-shadow: var(--shadow); }
  mark.ev { padding: 2px 1px; border-radius: 4px; scroll-margin-block: 24px; }
  mark.ev-strength { background: var(--strength-bg); border-bottom: 2px solid var(--strength); }
  mark.ev-minor { background: var(--minor-bg); border-bottom: 2px solid var(--minor); }
  mark.ev-major { background: var(--major-bg); border-bottom: 2px solid var(--major); }

  /*
   * 原文高亮和证据卡片之间的双向跳转，**全部靠朴素的 #锚点 + :target**，
   * 一行 JS 都没有——报告要能双击打开、发出去、打印成 PDF 都还好使。
   *
   * .ev-link 是 <mark> 里裹着的那层链接：它必须完全隐形，否则高亮里的字会变成
   * 链接色，整段原文花掉。下划线也不能留。
   */
  .ev-link { color: inherit; text-decoration: none; }
  mark.ev:target { outline: 2px solid var(--link); outline-offset: 1px; }
  .ev-card:target { box-shadow: 0 0 0 4px var(--accent-soft), var(--shadow); }

  .ev-head, .up-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .badge { font-size: 12px; padding: 2px 9px; border-radius: var(--radius-pill); font-weight: 600; }
  .badge-strength { background: var(--strength-bg); color: var(--strength); }
  .badge-minor { background: var(--minor-bg); color: var(--minor); }
  .badge-major { background: var(--major-bg); color: var(--major); }
  .dim { font-size: 12px; color: var(--muted); border: 1px solid var(--line); padding: 2px 8px; border-radius: var(--radius-pill); }
  .loc { font-size: 12px; color: var(--muted); margin-left: auto; font-variant-numeric: tabular-nums; }
  .loc-bad { color: var(--major); }
  /* 歧义徽章紧跟在坐标后面。坐标那一格有 margin-left: auto，所以这两块会
     一起被推到右端，顺序仍是「坐标 · 定位方式」在前 -->
     用 minor 的琥珀色而不是 major 的红色：这不是错误，是"请你自己确认一下" */
  .amb { font-size: 11px; color: var(--minor); background: var(--minor-bg); border: 1px solid var(--minor-line);
         border-radius: var(--radius-pill); padding: 1px 8px; white-space: nowrap; }
  /* 严重程度是兜底来的：虚线下划线表示"这里还有话没说"（说了，在 title 和
     报告顶部的警告里）。不改颜色，因为 minor 的配色本身没错 */
  .badge[data-degraded] { border-bottom: 1px dashed currentColor; }
  /* 坐标那一格现在是指回原文的链接。虚线是"可以点"的暗示，
     实线下划线在这个位置太抢眼，会和徽章抢注意力 */
  a.loc-link { color: var(--muted); text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  a.loc-link:hover { color: var(--link); }
  .ev-card { border-left: 3px solid var(--line); }
  .ev-card-strength { border-left-color: var(--strength); }
  .ev-card-minor { border-left-color: var(--minor); }
  .ev-card-major { border-left-color: var(--major); }
  blockquote { margin: 0 0 10px; padding: 8px 14px; background: var(--surface-2); border-radius: var(--radius-sm);
               font-family: var(--serif); font-size: 14px; color: var(--ink); }
  .ev-comment { margin: 0 0 6px; font-size: 14px; }
  .ev-suggestion { margin: 0; font-size: 13px; color: var(--ink-2); }
  .pri { font-size: 12px; font-weight: 700; color: var(--accent-ink); background: var(--accent);
         padding: 2px 10px; border-radius: var(--radius-pill); }
  .chips { margin-left: auto; font-size: 12px; color: var(--muted); }
  .chip { display: inline-block; margin-left: 4px; padding: 1px 7px; border-radius: var(--radius-sm);
          background: var(--bg); border: 1px solid var(--line); color: var(--link); text-decoration: none; font-variant-numeric: tabular-nums; }
  .up-action { font-weight: 600; margin: 0 0 6px; font-size: 15px; }
  .up-rationale { margin: 0; font-size: 13px; color: var(--ink-2); }
  .ex { margin-top: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
  .ex-row { display: flex; gap: 10px; padding: 9px 12px; font-size: 14px; align-items: flex-start; }
  .ex-row + .ex-row { border-top: 1px solid var(--line); }
  .ex-tag { flex: 0 0 auto; font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 4px; }
  .ex-before { background: var(--major-bg); color: var(--major); }
  .ex-after { background: var(--strength-bg); color: var(--strength); }
  /*
   * 改写示范的两种"不正常"状态：没给、给了但原文里找不到。必须显眼——
   * 留白和渲染坏了长得一样，而一份编造的示范看起来和真的一模一样
   */
  .ex-flag { margin: 9px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--minor);
             background: var(--minor-bg); border: 1px solid var(--minor-line);
             border-radius: var(--radius-sm); padding: 8px 11px; }
  /* "没给"是中性信息，不是错误——虚线灰字，别用琥珀色的告警腔调 */
  .ex-flag-quiet { color: var(--muted); background: transparent; border: 1px dashed var(--line); }

  /*
   * 训练区。⚠️ 这份 CSS 是**独立的另一份**，不是共用 app/globals.css 的——
   * 报告要自包含，不能引用外部样式。所以改网页样式时这里要跟着改一遍，
   * 类名也不必强求一致（比如这里有 ul.plain，网页那边叫 .plain-list）。
   */
  .chip-solid { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
  .train-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 11px; }
  .train-reason { font-weight: 600; margin: 0 0 13px; font-size: 15px; line-height: 1.75; }
  /* 浅底 + 内嵌边框：读起来像"附页"，和上面那段针对本篇的诊断分开 */
  .train-plain { border: 1px solid var(--line); border-radius: var(--radius-sm);
                 background: var(--surface-2); padding: 13px 15px; }
  .train-note { margin: 0 0 11px; font-size: 12px; color: var(--muted); }
  .train-symptom { margin: 0 0 12px; font-size: 13px; color: var(--ink-2); line-height: 1.75; }
  .train-label { font-size: 12px; font-weight: 700; color: var(--ink-2); margin: 0 0 5px; }
  .train-plain ul.plain { margin-bottom: 12px; font-size: 13.5px; line-height: 1.8; }
  .train-watch { margin: 0; font-size: 13px; line-height: 1.7; color: var(--minor);
                 background: var(--minor-bg); border: 1px solid var(--minor-line);
                 border-radius: var(--radius-sm); padding: 9px 12px; }

  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--line);
           color: var(--muted); font-size: 12px; line-height: 1.9; }
  ul.plain { padding-left: 20px; margin: 0; font-size: 14px; }

  @media (prefers-reduced-motion: reduce) {
    .meter i { animation: none; }
  }

  @media print {
    body { background: #fff; padding: 0; }
    /* ⚠️ 这一行和 app/globals.css 的 @media print 是**两份**，训练卡的类名
       两边都要加——只改一边的话，导出 PDF 时卡片会被切到两页上 */
    .card, .score-main, .band-desc, .dim-card, .train-card, .essay { break-inside: avoid; box-shadow: none; }
    /* 纸上没有动画。不关掉的话，打印预览可能抓到 grow 的第一帧——一条空槽 */
    .meter i { animation: none; }
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

  // 「证据 id → 原文锚点」整篇算一次，每张卡片自己算的话要跑 n 次切分
  const anchors = anchorMap(result.essay ?? "", result.evidence);
  const evidenceCards = result.evidence.map((e) => evidenceCard(e, anchors)).join("");
  const upgradeCards = result.upgradePlan.map(upgradeCard).join("");

  // 训练区。没有就**整块不显示**，连标题都不留——一个"训练区"标题下面空着
  // 比没有这一节更糟。
  // `?? []` 不是防御性编程而是必须的：lib/store.ts 是盲 `as ReviewResult`，
  // 升级前存下来的报告根本没有这个键。
  const training = result.trainingPlan ?? [];
  const trainingBlock = training.length
    ? `<h2>训练区</h2>${training.map(trainingCard).join("")}`
    : "";

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
        ${
          // 子计数，不是另一条分支：已定位/未定位的二分不变，这一项只在真的
          // 有歧义时才出现。没有就不显示，避免给人一个"这项永远是 0"的印象
          (stats.ambiguousCount ?? 0) > 0
            ? `<span title="定位成功、但原文里有不止一处相近匹配"><b>${stats.ambiguousCount}</b> 条位置有歧义</span>`
            : ""
        }
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

  ${trainingBlock}

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
