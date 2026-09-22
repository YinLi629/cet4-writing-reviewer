import { anchorMap } from "@/lib/highlight";
import type { ReviewResult } from "@/lib/types";

import { BandCard } from "./BandCard";
import { EvidenceList } from "./EvidenceList";
import { HighlightedEssay } from "./HighlightedEssay";
import { TrainingPlan } from "./TrainingPlan";
import { UpgradePlan } from "./UpgradePlan";

import { Reveal } from "./Reveal";

/**
 * 结果页主体。
 *
 * ## 分两栏
 *
 * 宽屏上是左右并排：**左原文、右批改**（`.report-layout` 的网格）。左栏跟着页面
 * 停住、自己滚，所以核对一条证据时不用再从卡片滚回去找原文——那正是这一版要
 * 解决的问题。窄屏回落成单栏，顺序和分栏之前一样。
 *
 * ⚠️ **DOM 顺序是「批改在前、原文在后」**，宽屏那一版靠 CSS 把原文摆到左边。
 * 这么排是因为窄屏（也是手机）读的就是 DOM 顺序：先看多少分、该改什么，
 * 想深究时再往下看原文。视觉顺序和 DOM 顺序不一致的代价是 Tab 顺序跟着 DOM 走
 * ——但批改才是这一页的主内容，先过它是对的。
 *
 * ## 为什么只有左栏没有 Reveal
 *
 * 其他每一节都套一层 Reveal（往下滚时上移淡入）。能用在这里，是因为这一页的数据
 * 一次性到位、渲染完就不动了；流式视图里每个 SSE 帧都在替换子节点，进场动画
 * 会被反复重放，所以那边一个都没有。
 *
 * 左栏不套：它在宽屏上是个 sticky 的侧栏，而 Reveal 是 transform 动画，
 * transform 会给里边的东西另造一个包含块（sticky 的定位基准会跟着变）。
 * 另外它是"参照物"，一进页面就该在那儿，不该等滚到才浮出来。
 */
export function ReportView({ result }: { result: ReviewResult }) {
  // 证据卡片要指回原文的高亮块，所以映射得在这一层算——只有这里同时握着
  // 原文和证据。算一遍给整份列表用，不必每张卡片各跑一次 segmentEssay
  const anchors = anchorMap(result.essay, result.evidence);

  return (
    <div className="report-layout">
      <div className="report-main">
        {result.warnings.length > 0 && (
          <Reveal>
            <div className="alert alert-warn">
              <strong>关于这份报告的可信度</strong>
              <ul>
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          </Reveal>
        )}

        {/* 60ms 的延迟：让分数板跟在标题后面落定，而不是和它抢同一帧 */}
        <Reveal delayMs={60}>
          <BandCard result={result} />
        </Reveal>

        <Reveal>
          <h2 className="section-title">升档建议</h2>
          <UpgradePlan plan={result.upgradePlan} />
        </Reveal>

        <Reveal>
          <h2 className="section-title">
            证据溯源
            <span className="section-sub">每条判断都对应原文的具体位置</span>
          </h2>
          <EvidenceList evidence={result.evidence} anchors={anchors} />
        </Reveal>

        {/*
          训练区放在证据溯源之后——它是"那我接下来怎么练"的落点，属于批改结论的
          最后一站。再往后就只剩那行 meta 了。

          `?.` 不是防御性编程而是必须的：lib/store.ts 是盲 `as ReviewResult`，
          升级前存下来的报告根本没有 trainingPlan 这个键。整节为空时**不显示**，
          连标题都不留——一个"训练区"标题下面什么都没有比没有这一节更糟。
        */}
        {result.trainingPlan && result.trainingPlan.length > 0 && (
          <Reveal>
            <h2 className="section-title">
              训练区
              <span className="section-sub">
                这篇暴露出的毛病，平时分别该怎么练
              </span>
            </h2>
            <TrainingPlan plan={result.trainingPlan} />
          </Reveal>
        )}

        <p className="note report-meta">
          批改模型：{result.meta.model}　·　耗时 {(result.meta.elapsedMs / 1000).toFixed(1)} 秒　·
          标准版本 {result.meta.rubricVersion}　·　生成于{" "}
          {new Date(result.meta.createdAt).toLocaleString("zh-CN", { hour12: false })}
        </p>
      </div>

      {/* 窄屏上这一节排在最后，所以它得自带标题——宽屏时标题留在滚动区外面，
          「这是原文批注」始终看得见 */}
      <aside className="report-aside">
        <h2 className="section-title">
          原文批注
          <span className="section-sub">点高亮跳到右边的证据卡，点卡片上的坐标跳回来</span>
        </h2>
        <div className="report-aside-scroll">
          <HighlightedEssay essay={result.essay} evidence={result.evidence} />
        </div>
      </aside>
    </div>
  );
}
