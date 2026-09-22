"use client";

import { useEffect, useRef, useState } from "react";

import type { ReviewProgress as ReviewProgressState } from "@/lib/types";
import { FIRST_FRAME_DEADLINE_MS, readPhase, silenceHint } from "@/lib/watchdog";

import { DiagnosisCard } from "./DiagnosisCard";
import { EvidenceList } from "./EvidenceList";

/**
 * 流式批改的等待界面：报告在输入页上边生成边长出来。
 *
 * 这个视图**用完就丢**——批改完成后照旧存 localStorage 再跳 /result，
 * 权威报告在那边。所以它不需要和最终结果对账，也就没有"部分结果与最终结果
 * 不一致"这一类问题。它也绝不落盘、绝不传给导出 HTML 报告的那条路。
 *
 * 等待期间的两个阈值不在这里，在 lib/watchdog.ts——那个文件是所有超时数字的唯一定义处，
 * 因为看门狗（lib/use-review-stream.ts）要拿同一组数去真的掐请求。见下面 silenceHint 的用法。
 *
 * 两条刻意的克制：
 *   · **不显示分数**。分数的最终值要过服务端的上限校正（依据模型自己标的
 *     major 条数与维度分），提前露出模型的原始分会让它几秒后当场跳一次。
 *     所以记分板整块留白，只写"计算中"。
 *   · **不显示百分比**。模型还要写多少字是未知的，按时间爬一个进度条是骗人。
 *     这里只报"已经拿到多少字符"，不涨就代表上游确实没动静。
 */

export interface ReviewProgressError {
  message: string;
  code?: string;
}

export interface ReviewProgressProps {
  /** 还没收到第一帧时为 null——这段窗口是上游的首字节延迟，通常不到一秒 */
  progress: ReviewProgressState | null;
  running: boolean;
  error: ReviewProgressError | null;
  onCancel: () => void;
  /** 失败后重来一次；不给就只显示"返回修改" */
  onRetry?: () => void;
  /** 失败后放弃，回到表单 */
  onBack?: () => void;
}

export function ReviewProgress({
  progress,
  running,
  error,
  onCancel,
  onRetry,
  onBack,
}: ReviewProgressProps) {
  const [elapsed, setElapsed] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // 只用来算"距离上次有新内容过了多久"。挂在 progress.chars 上就够了——
  // 心跳每 2 秒一发，chars 不变就是上游真的没有新东西
  const lastGrowthRef = useRef({ chars: progress?.chars ?? 0, at: Date.now() });

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    lastGrowthRef.current = { chars: progress?.chars ?? 0, at: Date.now() };
  }, [progress?.chars]);

  const chars = progress?.chars ?? 0;
  const silentSeconds = Math.floor((now - lastGrowthRef.current.at) / 1000);

  /**
   * 提示分两段，判定的依据是「收到第一帧没有」。
   *
   * 这一条以前是错的：原来的门槛是 `chars > 0`，于是断在首帧之前（chars 恒为 0）
   * 时提示**永远不会出现**——而那恰恰是最需要说话的时候。学生盯着「正在连接模型…」
   * 和一直往上数的秒数，没有任何线索告诉他出事了。
   *
   * 两段的文案不同，是因为原因不同：首帧之前不来数据是上游排队（连心跳都还没开始），
   * 首帧之后不来数据才是「有一会儿没动静」。说同一句话会误导。
   */
  const hint = running
    ? silenceHint(readPhase(progress !== null), silentSeconds)
    : null;

  const title = running
    ? progress
      ? "正在批改…"
      : "正在连接模型…"
    : "批改未完成";

  return (
    <>
      <div className="card">
        <div className="row-between">
          <div className="progress-title">
            {running && <span className="spinner" />}
            <strong>{title}</strong>
          </div>
          <span className="elapsed">已用 {elapsed} 秒</span>
        </div>

        <p className="muted small progress-sub">
          {progress?.model ? `模型：${progress.model}。` : ""}
          报告正一边生成一边填到下面，完成后会自动跳到完整结果页。
          {chars > 0 && ` 已收到 ${chars} 字符。`}
        </p>

        {error && (
          <div className="alert alert-error alert-inline">
            <strong>本次批改没有跑完</strong>
            {error.message}
            <div className="alert-detail">
              下面是已经生成好的部分，<b>不完整、也没有分数</b>，不能当报告看。
            </div>
          </div>
        )}

        {hint && (
          <div className="alert alert-warn alert-inline">
            {hint.phase === "streaming" ? (
              <>
                <strong>有一会儿没有新内容了</strong>
                已经 {hint.seconds} 秒没有收到新的内容。可能是模型在长思考，也可能是网络断了。
                两种都会有结果：服务端等不到上游会报错，这个页面收不到数据也会自己停下，
                不会一直转下去。
              </>
            ) : (
              <>
                <strong>模型还没开始返回</strong>
                已经等了 {hint.seconds} 秒。第一次出字通常不到一秒，等这么久多半是上游在排队。
                超过 {FIRST_FRAME_DEADLINE_MS / 1000} 秒还没动静，这个页面会停下并告诉你——
                不想等的话现在就可以取消，作文会留在输入框里。
              </>
            )}
          </div>
        )}

        <div className="row-between progress-actions">
          {running ? (
            <button type="button" className="btn" onClick={onCancel}>
              取消批改
            </button>
          ) : (
            <div className="btn-row">
              {onRetry && (
                <button type="button" className="btn btn-primary" onClick={onRetry}>
                  重新批改
                </button>
              )}
              {onBack && (
                <button type="button" className="btn btn-ghost" onClick={onBack}>
                  返回修改
                </button>
              )}
            </div>
          )}
          <span className="muted small">
            {running ? "中途取消不会保存在任何地方" : "已经生成的这部分不会被保存"}
          </span>
        </div>
      </div>

      {/*
        记分板留着位置但不填数字：跳到 /result 时版块位置不跳，
        而分数本身一出现就是最终值，从头到尾只有它一个数字
      */}
      <div className="scoreboard">
        <div className="score-main">
          <div className="score-big score-big-pending">
            {running ? "计算中" : "—"}
            <small> / 15</small>
          </div>
          <div className="score-106">
            折算 <b>—</b> 分 · 作文满分 106.5
          </div>
          <div className="band-pill">档次待定</div>
        </div>

        <div className="band-desc">
          <div className="label-cap">本档官方描述</div>
          <span className="muted">
            分数和档次要等系统核对完扣分项才给出——先报一个再改口，比晚一点报更难受。
          </span>
          <div className="stat-row">
            <span>
              <b>{progress?.stats.wordCount ?? "—"}</b> 词
            </span>
            <span>
              <b>{progress?.stats.sentenceCount ?? "—"}</b> 句
            </span>
            <span>
              <b>{progress?.stats.paragraphCount ?? "—"}</b> 段
            </span>
          </div>
        </div>
      </div>

      <DiagnosisCard
        summary={progress?.summary}
        strengths={progress?.strengths ?? []}
        dimensionScores={progress?.dimensionScores ?? []}
        partial
      />

      <h2 className="section-title">升档建议</h2>
      <div className="card">
        <span className="muted">
          {running
            ? "批改完成后生成——升档建议要对着最终的档次写，提前生成只会指向一个错的靶子。"
            : "这次没有跑完，所以没有升档建议。"}
        </span>
      </div>

      <h2 className="section-title">
        证据溯源
        <span className="section-sub">每条判断都对应原文的具体位置</span>
      </h2>
      {progress && progress.evidence.length > 0 ? (
        <EvidenceList evidence={progress.evidence} />
      ) : (
        <div className="card">
          <span className="muted">
            {running ? "正在摘取原文证据…" : "这次没有跑完，所以没有证据可看。"}
          </span>
        </div>
      )}

      {/*
        这里比 /result 少了"原文批注"。不是省事：某条引文的高亮坐标取决于整批引文
        （lib/evidence.ts 按长度排序并互斥占位），证据没到齐之前坐标根本不存在，
        硬画只会画出会移动的下划线。定位本身是毫秒级的 CPU 活，不拖慢收尾。
      */}
    </>
  );
}
