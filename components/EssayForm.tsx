"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { BANDS } from "@/lib/rubric";
import { SAMPLE_ESSAYS } from "@/lib/samples";
import { pushHistory, saveResult } from "@/lib/store";
import { countEnglishWords } from "@/lib/text-stats";
import type { ReviewErrorResponse, ReviewResult } from "@/lib/types";

import { LoadingStages } from "./LoadingStages";

/** CET-4 作文的字数要求是「不少于 120 词」，超过 180 词通常也不再加分 */
const TARGET_MIN = 120;
const TARGET_MAX = 180;

export function EssayForm() {
  const router = useRouter();

  const [essay, setEssay] = useState("");
  const [topic, setTopic] = useState("");
  const [targetBandLevel, setTargetBandLevel] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [modelName, setModelName] = useState<string>("");

  const abortRef = useRef<AbortController | null>(null);

  // 提前问一下服务端有没有配 key，别让用户写完作文才发现跑不起来
  useEffect(() => {
    let cancelled = false;
    fetch("/api/review")
      .then((r) => r.json())
      .then((d: { ready?: boolean; model?: string }) => {
        if (cancelled) return;
        setApiReady(Boolean(d.ready));
        setModelName(d.model ?? "");
      })
      .catch(() => {
        if (!cancelled) setApiReady(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 组件卸载时掐掉还在飞的请求，避免 setState 打在已卸载的组件上
  useEffect(() => () => abortRef.current?.abort(), []);

  const wordCount = useMemo(() => countEnglishWords(essay), [essay]);
  const tooShort = essay.trim().length > 0 && essay.trim().length < 20;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;

    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          essay,
          topic: topic.trim() || undefined,
          targetBandLevel: targetBandLevel ? Number(targetBandLevel) : undefined,
        }),
        signal: controller.signal,
      });

      const payload = (await res.json().catch(() => null)) as
        | ReviewResult
        | ReviewErrorResponse
        | null;

      if (!res.ok) {
        const err = payload as ReviewErrorResponse | null;
        setError({
          message: err?.error ?? `请求失败（HTTP ${res.status}）。`,
          code: err?.code,
        });
        return;
      }

      const result = payload as ReviewResult;
      saveResult(result);
      pushHistory(result);
      router.push("/result");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // 用户自己取消的，不用报错
        return;
      }
      setError({
        message: `请求没有发出去：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  };

  if (pending) {
    return <LoadingStages modelName={modelName} />;
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

      {error && (
        <div className="alert alert-error">
          <strong>批改失败</strong>
          {error.message}
          {error.code === "TIMEOUT" && (
            <div style={{ marginTop: 6 }}>
              作文字数越多耗时越长，可以调大 <code>.env.local</code> 里的{" "}
              <code>REVIEW_TIMEOUT_MS</code>。
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="topic">
          题目 / 要求
          <span className="hint">选填，但填了才能判断是否切题</span>
        </label>
        <textarea
          id="topic"
          className="textarea"
          style={{ minHeight: 84 }}
          placeholder="例如：Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words."
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
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
          className="select"
          style={{ maxWidth: 320 }}
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

      <div className="sample-row" style={{ marginBottom: 18 }}>
        <span className="small muted" style={{ alignSelf: "center" }}>
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
            <span className="muted" style={{ fontWeight: 400 }}>
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
              setError(null);
            }}
          >
            清空
          </button>
        )}

        <span className="muted small" style={{ marginLeft: "auto" }}>
          通常需要 20–60 秒
        </span>
      </div>
    </form>
  );
}
