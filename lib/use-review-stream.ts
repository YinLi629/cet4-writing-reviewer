"use client";

/**
 * 提交批改并消费服务端的 SSE 进度流。
 *
 * 为什么单独抽一个 hook：EssayForm 里本来就既有表单状态又有网络状态，加上流式之后
 * 还要分帧、归约、处理四种终止态，混在一起就没法读了。这里把"一次批改的完整生命周期"
 * 整个收进来，EssayForm 只管渲染。
 *
 * **四种终止态**，少处理一个都会变成永远转的圈：
 *   1. `result` 帧 —— 存结果、记历史、跳 /result。渐进内容用完就丢，不落盘
 *   2. `error` 帧 —— 保留已经收到的内容再报错。钱已经花了，扔掉是最亏的选择
 *   3. 干净 EOF —— 平台掐断（maxDuration）、网络断、代理读超时。看起来像"流正常结束"，
 *      其实什么都没拿到，必须当错误处理
 *   4. AbortError —— 用户自己按了取消，不报错、回到表单
 *
 * 还有一条不能忘：**非 SSE 的响应也必须处理**。口令错、限流、上游 401/5xx 全都发生在
 * 开流之前，服务端会用真正的状态码 + JSON 体回绝；`REVIEW_STREAM=0` 时成功响应也是 JSON。
 * 所以分支依据是响应的 content-type，不是状态码。
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { createSseFrameParser, type SseFrame } from "./sse";
import { pushHistory, saveAccessCode, saveResult } from "./store";
import {
  DIMENSIONS,
  type DimensionScore,
  type ReviewProgress,
  type ReviewRequest,
  type ReviewResult,
  type ReviewStreamEvent,
} from "./types";

/** 一次批改所处的阶段。 */
export type ReviewStreamPhase =
  | "idle" // 没在跑（表单可编辑）
  | "running" // 正在批改，progress 会陆续填充
  | "finished" // 结果已到手，正在跳转
  | "failed"; // 终止性失败。progress 可能不是空的——那是不完整的部分内容

export interface ReviewStreamError {
  message: string;
  code?: string;
}

export interface UseReviewStream {
  phase: ReviewStreamPhase;
  /** 已经拿到的部分结果；没开始时是 null */
  progress: ReviewProgress | null;
  error: ReviewStreamError | null;
  start(request: ReviewRequest): void;
  cancel(): void;
  /** 丢掉部分内容回到表单（失败后选择"返回修改"时用） */
  reset(): void;
}

export function useReviewStream(): UseReviewStream {
  const router = useRouter();

  const [phase, setPhase] = useState<ReviewStreamPhase>("idle");
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [error, setError] = useState<ReviewStreamError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // 卸载后不要再 setState。跳转（router.push）会卸载本组件，
  // 而收尾代码就在跳转之后，不加这个闸门会往已卸载的组件上写状态
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 组件卸载就掐掉还在飞的请求：用户关标签页/离开后，服务端那边的
      // request.signal 也会跟着触发，上游调用被中止，不再为一篇没人等的作文计费
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setPhase("idle");
    setProgress(null);
    setError(null);
  }, []);

  const start = useCallback(
    (request: ReviewRequest) => {
      // 已经在跑就别重入。表单的提交按钮此时也是禁用的，这里只是兜底
      if (abortRef.current) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase("running");
      setProgress(null);
      setError(null);

      const fail = (message: string, code?: string): void => {
        if (!aliveRef.current) return;
        setError({ message, code });
        setPhase("failed");
      };

      /**
       * 用户主动取消：不报错、不保留半截内容，直接回表单。
       * 这是用户明确表达了"我不想要了"，留一张没有分数的残报告反而碍事。
       * （对比 error 帧：那个是意外，内容要留着。）
       */
      const cancelled = (): void => {
        if (!aliveRef.current) return;
        setPhase("idle");
        setProgress(null);
        setError(null);
      };

      /** 拿到权威结果：存盘 + 跳转。渐进内容在这里被彻底丢弃。 */
      const succeed = (result: ReviewResult): void => {
        // 只在真的批改成功后才记住口令——口令错了就不该被持久化，
        // 否则下次访问会预填一个错的值
        const code = request.accessCode?.trim();
        if (code) saveAccessCode(code);
        saveResult(result);
        pushHistory(result);

        if (!aliveRef.current) return;
        // 停在 finished 而不是 idle：跳转是异步的，回到 idle 会闪一下表单
        setPhase("finished");
        router.push("/result");
      };

      void (async () => {
        try {
          const res = await fetch("/api/review", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          });

          const contentType = res.headers.get("content-type") ?? "";

          // 不是流：要么是开流之前的失败（真状态码 + JSON 错误体），
          // 要么是 REVIEW_STREAM=0 时那条老路径的成功响应。两种都到这里
          if (!contentType.includes("text/event-stream")) {
            const payload = (await res.json().catch(() => null)) as
              | ReviewResult
              | { error?: unknown; code?: unknown }
              | null;

            if (!res.ok) {
              const body = payload as { error?: unknown; code?: unknown } | null;
              fail(
                typeof body?.error === "string"
                  ? body.error
                  : `请求失败（HTTP ${res.status}）。`,
                typeof body?.code === "string" ? body.code : undefined,
              );
              return;
            }

            if (!payload || typeof payload !== "object" || !("band" in payload)) {
              fail("服务端返回的内容不是一份批改报告。");
              return;
            }
            succeed(payload as ReviewResult);
            return;
          }

          const reader = res.body?.getReader();
          if (!reader) {
            fail("服务端返回了流式响应，但里面没有内容。");
            return;
          }

          const decoder = new TextDecoder();
          const parser = createSseFrameParser();

          // 循环的退出原因。用返回值而不是外层变量，是为了让类型收窄正常工作——
          // 在闭包里赋值的变量，外层读到的类型是声明类型，收窄不了
          let outcome: FrameOutcome = { kind: "continue" };

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            const frames = parser.push(decoder.decode(value, { stream: true }));
            outcome = handleFrames(frames, { fail, setProgress });
            if (outcome.kind !== "continue") break;
          }

          if (outcome.kind === "result") {
            succeed(outcome.result);
            return;
          }
          if (outcome.kind === "error") return; // fail 已经在里面报过了

          if (controller.signal.aborted) {
            // read() 正常结束、同时用户刚按下取消。不这么写的话 phase 会卡在
            // running 上，界面上就是一个永远转的圈
            cancelled();
            return;
          }

          // 走到这里说明流干净地结束了，却没有 result 帧。
          // 这跟"还在跑"必须区分开，否则转圈会永远转下去
          fail("批改连接中断了，没有收到完整结果。请重试。");
        } catch (err) {
          if (isAbortError(err)) {
            cancelled();
            return;
          }
          fail(
            `请求没有发出去：${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          abortRef.current = null;
        }
      })();
    },
    [router],
  );

  return { phase, progress, error, start, cancel, reset };
}

/** 一批帧处理完之后的走向。 */
type FrameOutcome =
  | { kind: "continue" }
  | { kind: "result"; result: ReviewResult }
  | { kind: "error" };

interface FrameSink {
  fail(message: string, code?: string): void;
  setProgress(update: (prev: ReviewProgress | null) => ReviewProgress | null): void;
}

function handleFrames(frames: SseFrame[], sink: FrameSink): FrameOutcome {
  for (const frame of frames) {
    const event = asStreamEvent(frame.event, frame.data);
    if (!event) {
      // 载荷坏了。丢掉这一帧继续读，别让一帧脏数据毁掉整次批改——
      // 真正的正确性由最后的 result 帧保证，中间的都是展示
      console.error("[review] 收到无法解析的流式帧：", frame.event, frame.raw);
      continue;
    }

    if (event.type === "result") return { kind: "result", result: event.result };
    if (event.type === "error") {
      sink.fail(event.error, event.code);
      return { kind: "error" };
    }

    sink.setProgress((prev) => applyEvent(prev, event));
  }
  return { kind: "continue" };
}

/** 把一帧的载荷还原成 ReviewStreamEvent；形状对不上就返回 null。 */
function asStreamEvent(eventName: string, data: unknown): ReviewStreamEvent | null {
  if (!data || typeof data !== "object") return null;
  // 帧名和载荷里的 type 必须一致。不一致说明中间的某个环节（代理、版本错配，
  // 或者有人手搓了一个响应）给了我们看不懂的东西——与其猜哪个是准的，
  // 不如当它没到：少一帧展示不致命，读错一帧可能导致整份报告是错的
  if ((data as { type?: unknown }).type !== eventName) return null;
  return data as ReviewStreamEvent;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 把一个流式事件并入渐进状态。终止帧（result/error）不会走到这里。 */
function applyEvent(
  prev: ReviewProgress | null,
  event: ReviewStreamEvent,
): ReviewProgress | null {
  switch (event.type) {
    case "meta":
      // meta 是流的第一帧，progress 从此有值。它之前到达的展示帧会被丢掉，
      // 但那是服务端违约（见 lib/review.ts 的时序约定），正常路径下不会发生
      return {
        stats: event.stats,
        model: event.model,
        topic: event.topic,
        chars: 0,
        strengths: [],
        dimensionScores: [],
        evidence: [],
      };

    // chars 不涨就是诚实的"上游没有新内容"。这里没有、也不该有百分比：
    // 总量是未知的，按时间爬一个进度条是骗人
    case "progress":
      return prev ? { ...prev, chars: event.chars } : prev;

    case "summary":
      return prev ? { ...prev, summary: event.value } : prev;

    case "strengths":
      return prev ? { ...prev, strengths: event.value } : prev;

    case "dimensionScores":
      return prev
        ? {
            ...prev,
            dimensionScores: mergeDimensions(prev.dimensionScores, event.value),
          }
        : prev;

    case "evidence": {
      if (!prev) return prev;
      // 服务端的扫描结果长度单调不减，同一帧不会被推两次；
      // 这层去重是防"重连/重放"这类将来才可能出现的情况，代价是一次 some()
      if (prev.evidence.some((e) => e.id === event.value.id)) return prev;
      return { ...prev, evidence: [...prev.evidence, event.value] };
    }

    default:
      return prev;
  }
}

/**
 * 按 dimension 合并维度分。
 *
 * 服务端一帧只推一个维度（模型输出到哪推到哪），所以这里要合并而不是覆盖。
 * 排成 DIMENSIONS 的顺序，是为了让维度卡在生成过程中不会因为到达顺序而左右跳。
 */
function mergeDimensions(
  prev: DimensionScore[],
  incoming: DimensionScore[],
): DimensionScore[] {
  const merged = [...prev];
  for (const item of incoming) {
    const at = merged.findIndex((d) => d.dimension === item.dimension);
    if (at === -1) merged.push(item);
    else merged[at] = item;
  }
  return merged.sort(
    (a, b) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension),
  );
}
