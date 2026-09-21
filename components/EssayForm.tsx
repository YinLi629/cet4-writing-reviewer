"use client";

import { useEffect, useMemo, useState } from "react";

import { BANDS } from "@/lib/rubric";
import { SAMPLE_ESSAYS } from "@/lib/samples";
import { loadAccessCode } from "@/lib/store";
import { countEnglishWords } from "@/lib/text-stats";
import {
  MAX_TOPIC_CHARS,
  MIN_ESSAY_CHARS,
  type ReviewRequest,
} from "@/lib/types";
import { useReviewStream } from "@/lib/use-review-stream";

import { ReviewProgress } from "./ReviewProgress";

/** CET-4 作文的字数要求是「不少于 120 词」，超过 180 词通常也不再加分 */
const TARGET_MIN = 120;
const TARGET_MAX = 180;

export function EssayForm() {
  const [essay, setEssay] = useState("");
  const [topic, setTopic] = useState("");
  const [targetBandLevel, setTargetBandLevel] = useState<string>("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [gated, setGated] = useState<boolean | null>(null);
  const [persistence, setPersistence] = useState<"postgres" | "memory" | null>(null);
  const [accessCode, setAccessCode] = useState("");

  // 一次批改的完整生命周期（请求、流式增量、终止态、跳转）都在这个 hook 里，
  // 表单只管收集输入和渲染
  const { phase, progress, error, start, cancel, reset } = useReviewStream();

  // pending 覆盖 running 和 finished 两段：后者是"结果已到手、正在跳转"，
  // 这时松开禁用会让用户看到表单闪一下
  const pending = phase === "running" || phase === "finished";

  // 口令是记住的，下次访问直接预填，不用重输
  useEffect(() => {
    setAccessCode(loadAccessCode() ?? "");
  }, []);

  // 提前问一下服务端有没有配 key 和口令，别让用户写完作文才发现跑不起来
  useEffect(() => {
    let cancelled = false;
    fetch("/api/review")
      .then((r) => r.json())
      .then((d: { ready?: boolean; gated?: boolean; persistence?: string }) => {
        if (cancelled) return;
        setApiReady(Boolean(d.ready));
        setGated(Boolean(d.gated));
        // 只认这两个明确的值。字段缺失（比如前端是新的、后端还是旧的）时不显示
        // 提示——宁可少提示，也不能凭一个 undefined 就说"限流没生效"吓人
        const mode = d.persistence;
        setPersistence(mode === "postgres" || mode === "memory" ? mode : null);
      })
      .catch(() => {
        if (!cancelled) setApiReady(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const wordCount = useMemo(() => countEnglishWords(essay), [essay]);
  const tooShort =
    essay.trim().length > 0 && essay.trim().length < MIN_ESSAY_CHARS;
  // 没有 tooLong：作文不限字数。唯一还能拦住超长输入的是服务端的 128 KB
  // 请求体上限，那是异常情况，不值得在表单里提前吓唬人。

  const buildRequest = (): ReviewRequest => ({
    essay,
    topic: topic.trim() || undefined,
    targetBandLevel: targetBandLevel ? Number(targetBandLevel) : undefined,
    accessCode: accessCode.trim() || undefined,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    start(buildRequest());
  };

  // running 时是无条件切换（连第一帧都还没到也要给个等待界面，那段是上游的首字节延迟）；
  // failed 时只在已经拿到了内容的情况下留在进度视图里——否则连半成品都没有，
  // 该做的是回到表单、把错误摆在输入框上方
  if (pending || (phase === "failed" && progress)) {
    return (
      <ReviewProgress
        progress={progress}
        running={pending}
        error={error}
        onCancel={cancel}
        onRetry={() => start(buildRequest())}
        onBack={reset}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {apiReady === false && (
        <div className="alert alert-error">
          <strong>服务端还没有配置 API Key</strong>
          把项目根目录的 <code>.env.local.example</code> 复制成{" "}
          <code>.env.local</code>，填入 <code>DEEPSEEK_API_KEY=sk-...</code>
          ，然后重启开发服务器。现在提交会直接报错。
        </div>
      )}

      {gated === false && (
        <div className="alert alert-error">
          <strong>服务端还没有配置访问口令</strong>
          在环境变量里设置 <code>REVIEW_ACCESS_CODE</code>
          ——本地写进 <code>.env.local</code>，线上写进 Vercel 的环境变量，然后重启或重新部署。
          出于安全考虑，没配口令时服务端会拒绝一切批改请求。
        </div>
      )}

      {/* 用 warn 而不是 error：站点照常能用，退化的只是限流的强度。
          两种原因都走这里：没配 DATABASE_URL，或者配了但数据库连不上 */}
      {persistence === "memory" && (
        <div className="alert alert-warn">
          <strong>限流的持久化存储没有生效</strong>
          服务端现在把限流状态存在单个实例的内存里，要么是没配{" "}
          <code>DATABASE_URL</code>
          ，要么是数据库连不上（后一种情况服务端日志里有一条告警）。本地开发无所谓，
          线上这样部署会让这道限制漏掉。在 Vercel 的环境变量里配好{" "}
          <code>DATABASE_URL</code> 后重新部署。
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <strong>批改失败</strong>
          {error.message}
          {error.code === "INVALID_ACCESS_CODE" && (
            <div className="alert-detail">
              检查一下上面的「访问口令」是否与服务端配置的{" "}
              <code>REVIEW_ACCESS_CODE</code> 一致。
            </div>
          )}
          {error.code === "TIMEOUT" && (
            <div className="alert-detail">
              作文字数越多耗时越长，可以调大 <code>.env.local</code> 里的{" "}
              <code>REVIEW_TIMEOUT_MS</code>。
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="accessCode">
          访问口令
          <span className="hint">
            站点的批改额度有限，需要口令才能用。输入一次后会记在这个浏览器上
          </span>
        </label>
        <input
          id="accessCode"
          className="input field-narrow"
          type="password"
          autoComplete="off"
          placeholder="向站点主人索取"
          value={accessCode}
          onChange={(e) => setAccessCode(e.target.value)}
          disabled={pending}
        />
      </div>

      <div className="field">
        <label htmlFor="topic">
          题目 / 要求
          <span className="hint">
            选填，但填了才能判断是否切题。只写题干，上限 {MAX_TOPIC_CHARS} 字符
          </span>
        </label>
        <textarea
          id="topic"
          className="textarea textarea-short"
          placeholder="例如：Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words."
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={MAX_TOPIC_CHARS}
          disabled={pending}
        />
      </div>

      <div className="field">
        <label htmlFor="essay">
          作文正文
          <span className="hint">直接粘贴或手写，保留原始拼写和标点，批改会更准</span>
        </label>
        <textarea
          id="essay"
          className="textarea textarea-essay"
          placeholder="Paste your essay here..."
          value={essay}
          onChange={(e) => setEssay(e.target.value)}
          disabled={pending}
          spellCheck={false}
        />
      </div>

      <div className="field">
        <label htmlFor="target">
          目标档次
          <span className="hint">选填。选了之后升档建议会对着这个目标写</span>
        </label>
        <select
          id="target"
          className="select field-narrow"
          value={targetBandLevel}
          onChange={(e) => setTargetBandLevel(e.target.value)}
          disabled={pending}
        >
          <option value="">不指定，按上一档给建议</option>
          {[...BANDS]
            .filter((b) => b.level > 0)
            .reverse()
            .map((b) => (
              <option key={b.level} value={b.level}>
                {b.label}（{b.range[0]}–{b.range[1]} 分）
              </option>
            ))}
        </select>
      </div>

      <div className="sample-row">
        <span className="small muted sample-label">
          没有现成作文？试试：
        </span>
        {SAMPLE_ESSAYS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="btn"
            onClick={() => {
              setEssay(s.text);
              setTopic(s.topic);
            }}
          >
            {s.label}
            <span className="muted sample-hint">
              {s.hint}
            </span>
          </button>
        ))}
      </div>

      <div className="form-footer">
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={pending || tooShort || !essay.trim()}
        >
          开始批改
        </button>

        <span className={`counter${essay && (wordCount < TARGET_MIN || wordCount > TARGET_MAX) ? " counter-warn" : ""}`}>
          {wordCount} 词
          {essay && wordCount < TARGET_MIN ? `（还差 ${TARGET_MIN - wordCount} 词）` : ""}
          {essay && wordCount > TARGET_MAX ? `（超过建议的 ${TARGET_MAX} 词）` : ""}
        </span>

        {essay && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setEssay("");
              reset();
            }}
          >
            清空
          </button>
        )}

        <span className="muted small form-note">
          通常 10 秒左右，长作文会更久
        </span>
      </div>
    </form>
  );
}
