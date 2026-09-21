/**
 * POST /api/review —— 批改入口。
 *
 * 这个路由只做四件事：读请求、校验访问口令、调 lib/review、把错误翻译成
 * 合适的状态码。所有业务逻辑都在 lib/ 里，路由本身保持薄。
 *
 * 口令校验放这一层而不是 lib/review.ts：批改逻辑不该关心鉴权，而且
 * scripts/selftest.ts 的端到端用例是直接调 reviewEssay() 的，塞进去会带崩它们。
 *
 * 请求处理顺序是有讲究的，从便宜到贵：
 *   状态早拒（锁定 + 配额）→ 读 body（带上限）→ 验口令 → 记一次配额 → 调模型
 * 每一步都尽量把不该处理的请求挡在下一步之前，尤其是挡在收费的模型调用之前。
 *
 * 其中两处顺序是被规则本身决定的，不是随手排的：
 *
 * - **配额判定在验口令之后**。错口令的那几次不占 100 次额度（两道限制各管各的），
 *   所以判定只能等口令过了再做。副作用：作文因为太短在 lib/review.ts 的
 *   normalizeInput 里被拒（400）时，这一次**已经**计进 100 了。对外只能说
 *   "口令通过的请求才计数"，不能说"真正调用了模型才计数"。
 * - **第 ④ 步一条语句里同时清零失败计数和自增配额**。口令正确有两个后果，压成一条
 *   语句既省一次往返，也让它们在同一把行锁上原子生效——不然会有一个可观测的中间态。
 *
 * 第 ① 步的早拒读的是**上一次**留下的状态，它只负责省掉一次 body 解析。权威判定是
 * 第 ④ 步那条写语句的 RETURNING（自增和判定在同一条原子语句里）。别把早拒当权威：
 * 并发下它会漏，而这正是并发爆破要防的。
 */

import { NextResponse } from "next/server";

import { hasAccessCode, verifyAccessCode } from "@/lib/access";
import { getModel, hasApiKey, LLMError } from "@/lib/deepseek";
import { clientKeyFrom, isOverLimit } from "@/lib/rate-limit";
import { getGate, persistenceMode } from "@/lib/rate-limit-store";
import { readJsonBody } from "@/lib/request-body";
import { reviewEssay, reviewEssayStream } from "@/lib/review";
import { encodeSseFrame, SSE_RESPONSE_HEADERS } from "@/lib/sse";
import {
  type ReviewErrorResponse,
  type ReviewRequest,
  type ReviewStreamEvent,
} from "@/lib/types";

// DeepSeek 调用需要 Node 运行时（用到了 process.env 和较长的超时）
export const runtime = "nodejs";
// 批改一篇作文可能要几十秒，别让平台提前掐断。
// 注意与 lib/deepseek.ts 的 DEFAULT_TIMEOUT_MS 留有差值——模型超时返回后，
// 解析模型输出、定位证据、组织响应都还要时间，两者相等会让平台先掐断函数。
export const maxDuration = 120;

function statusFor(code: ReviewErrorResponse["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "MISSING_API_KEY":
    case "MISSING_ACCESS_CODE":
      // 都是服务端配置问题，不是调用方的错
      return 500;
    case "INVALID_ACCESS_CODE":
      return 401;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "RATE_LIMITED":
      return 429;
    // 499 是 nginx 的约定（客户端主动断开）。这里基本没人收得到，只是让日志可读
    case "CLIENT_ABORTED":
      return 499;
    case "TIMEOUT":
      return 504;
    case "UPSTREAM_ERROR":
    case "BAD_MODEL_OUTPUT":
      return 502;
    default:
      return 500;
  }
}

function errorResponse(
  code: ReviewErrorResponse["code"],
  message: string,
  headers?: HeadersInit,
): NextResponse<ReviewErrorResponse> {
  return NextResponse.json<ReviewErrorResponse>(
    { error: message, code },
    { status: statusFor(code), headers },
  );
}

/** 把毫秒换算成「多久后再试」的人话 */
function humanizeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}

// isOverLimit 在 lib/rate-limit.ts —— 它是策略，放那儿自测才够得着

export async function POST(request: Request) {
  const gate = getGate();
  const clientKey = clientKeyFrom(request);

  // ① 状态早拒，放在读 body 之前：被锁的、超额度的调用方连解析都不该触发。
  //    锁定排在前面是因为它的信息更具体（"输错太多次"比"太频繁"更能解释现状）。
  const state = await gate.peek(clientKey);

  if (state.lockRetryAfterMs > 0) {
    return errorResponse(
      "RATE_LIMITED",
      `访问口令连续输错太多次，已暂时锁定，请 ${humanizeWait(state.lockRetryAfterMs)}后再试。`,
      { "Retry-After": String(Math.ceil(state.lockRetryAfterMs / 1000)) },
    );
  }
  // +1：peek 读到的计数不含当前这个请求（见 isOverLimit）
  if (isOverLimit(gate.policy.reviewLimit, state.windowCount + 1)) {
    return errorResponse(
      "RATE_LIMITED",
      `批改请求太频繁了，请 ${humanizeWait(state.windowResetAfterMs)}后再试。`,
      { "Retry-After": String(Math.ceil(state.windowResetAfterMs / 1000)) },
    );
  }

  // ② 读 body，带硬性大小上限。注意必须跑在 JSON.parse 之前——
  //    见 lib/request-body.ts 顶部注释
  const read = await readJsonBody(request);
  if (!read.ok) {
    return read.reason === "TOO_LARGE"
      ? errorResponse(
          "PAYLOAD_TOO_LARGE",
          "请求体太大了（超过 128 KB）。作文本身不限制字数，正常一篇远远到不了这个量级，请检查是不是把别的内容一起粘进来了。",
        )
      : errorResponse("INVALID_INPUT", "请求体不是合法 JSON。");
  }
  const body = read.value;

  // ③ 验口令。没通过就别谈批改——更别浪费模型额度
  const verdict = verifyAccessCode(
    (body as { accessCode?: unknown } | null)?.accessCode,
  );
  if (!verdict.ok) {
    const code =
      verdict.reason === "MISSING_CONFIG" ? "MISSING_ACCESS_CODE" : "INVALID_ACCESS_CODE";

    // 只有"口令错了"才记失败。缺配置是站长的锅，不该把调用方锁掉
    if (code === "INVALID_ACCESS_CODE") {
      const failure = await gate.recordFailure(clientKey);
      // 人为拖慢，抬高串行爆破的成本。代价是正常用户打错一次也要等这一下。
      // 放在 recordFailure 之后：这一下延迟正好盖住数据库那次往返
      if (gate.policy.failDelayMs > 0) {
        await new Promise((r) => setTimeout(r, gate.policy.failDelayMs));
      }
      // 这次失败刚好锁上的话，文案里直接说清楚还要等多久——否则用户只会看到
      // "口令不正确"，再试一次才被告知被锁了
      if (failure.lockRetryAfterMs > 0) {
        return errorResponse(
          "RATE_LIMITED",
          `访问口令不正确，且连续输错次数过多，已锁定，请 ${humanizeWait(failure.lockRetryAfterMs)}后再试。`,
          { "Retry-After": String(Math.ceil(failure.lockRetryAfterMs / 1000)) },
        );
      }
    }

    return errorResponse(
      code,
      code === "MISSING_ACCESS_CODE"
        ? "服务端没有配置访问口令，批改功能暂不可用。请在环境变量里设置 REVIEW_ACCESS_CODE 后重启或重新部署。"
        : "访问口令不正确。请检查后重试。",
    );
  }

  // ④ 配额判定，权威值来自这条写语句自己返回的计数（见文件头）。
  //    顺带把失败计数清零——口令正确这件事一次生效
  const used = await gate.recordSuccess(clientKey);
  if (isOverLimit(gate.policy.reviewLimit, used.windowCount)) {
    return errorResponse(
      "RATE_LIMITED",
      `批改请求太频繁了，请 ${humanizeWait(used.windowResetAfterMs)}后再试。`,
      { "Retry-After": String(Math.ceil(used.windowResetAfterMs / 1000)) },
    );
  }

  const input = (body ?? {}) as ReviewRequest;

  // REVIEW_STREAM=0 是运维逃生口：整个退回"一次请求一次返回"。
  // 客户端是按响应的 content-type 分支的，所以不需要它配合改什么。
  if (process.env.REVIEW_STREAM === "0") {
    try {
      // 透传 request.signal：用户关标签页/刷新后，上游调用会被中止，
      // 不再为一个没人在等的响应继续烧额度
      const result = await reviewEssay(input, request.signal);
      return NextResponse.json(result, {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (err) {
      const d = describeError(err);
      return errorResponse(d.code, d.message);
    }
  }

  return streamReview(request, input);
}

/**
 * 错误 → { code, message }。
 *
 * 两条路径共用一份映射，是为了让"同一个失败"在流式和非流式下给出同样的文案。
 * 流式那条路还多一层要求：开了流之后状态码已经发出去了，这几个字段会变成
 * 流里的一帧 error，客户端拿到的必须还是同一句话。
 */
function describeError(err: unknown): {
  code: ReviewErrorResponse["code"];
  message: string;
} {
  if (err instanceof LLMError) {
    // 客户端自己断开的，响应没人收，也不该记成服务端故障
    return {
      code: err.code,
      message: err.code === "CLIENT_ABORTED" ? "客户端已断开连接。" : err.message,
    };
  }

  // 非预期错误：日志留全量，响应只给一句话，避免把内部细节泄露出去
  console.error("[api/review] 未预期的错误：", err);
  return {
    code: "UNKNOWN",
    message: "服务端出现未预期的错误，请查看运行终端里的日志。",
  };
}

/**
 * 流式批改：把 reviewEssayStream 的事件翻成 SSE 帧。
 *
 * 这里有一个**结构性的**要求：必须先把上游打开，再决定要不要开流。
 *
 * 原因是上游的鉴权失败（401/403）、被限流、5xx 全都发生在还没有任何内容的时候，
 * 它们完全可以用正常的状态码回绝掉——客户端的错误界面（按 code 分流）和 README
 * 的错误码表都依赖这一点。而一旦开始往响应里写字节，状态码就改不了了，
 * 那些失败只能退化成流里的一帧 error，状态码一律变成 200。
 *
 * 做法：先跑流水线、把帧攒在内存里，等到"第一个事件到达（= 上游已经打开）"
 * 或者"流水线整个失败"为止，再决定返回 SSE 还是返回 JSON 错误。
 * 攒的那点数据最多一帧（meta），可以忽略。
 */
async function streamReview(
  request: Request,
  body: ReviewRequest,
): Promise<Response> {
  const encoder = new TextEncoder();
  const queued: Uint8Array[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const push = (chunk: Uint8Array): void => {
    if (closed) return;
    if (!controller) {
      queued.push(chunk);
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      // 客户端已经断开，后面的帧都丢掉
      closed = true;
    }
  };

  const onEvent = (event: ReviewStreamEvent): void => {
    push(encoder.encode(encodeSseFrame(event.type, event)));
    // 第一个事件一定是在上游打开成功之后才发出的（见 reviewEssayStream），
    // 所以它到达就等于"这次请求至少不会以状态码失败收场了"
    markReady();
  };

  // 结果包一层，避免 Promise 的 rejected 状态和"值是 undefined"混在一起
  const outcome = reviewEssayStream(body, request.signal, onEvent).then(
    () => ({ failed: false as const }),
    (err: unknown) => ({ failed: true as const, err }),
  );

  await Promise.race([ready, outcome]);

  if (queued.length === 0) {
    // 一个事件都没发出来 = 上游没打开，或者输入校验就没过。
    // 此时 outcome 必然已经落定（要么它让 race 结束了，要么 ready 从没 resolve 过），
    // 所以这个 await 不会挂住。
    const settled = await outcome;
    const d = settled.failed
      ? describeError(settled.err)
      : describeError(new Error("批改没有产生任何事件"));
    return errorResponse(d.code, d.message);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of queued) c.enqueue(chunk);
      queued.length = 0;
    },
    cancel() {
      // 客户端断开（关标签页/点取消）。request.signal 会一起触发，
      // 上游调用随之被中止，不再为一个没人在等的批改继续计费。
      closed = true;
      controller = null;
    },
  });

  // 收尾。失败只能补一帧 error——响应头早就发出去了，改不了状态码。
  void outcome.then((settled) => {
    if (settled.failed) {
      const d = describeError(settled.err);
      // 载荷带上 type，和其它帧保持同一种形状——客户端就可以一视同仁地
      // 当成 ReviewStreamEvent 来读，不用给 error 单独开一条解析分支
      push(
        encoder.encode(
          encodeSseFrame("error", {
            type: "error",
            error: d.message,
            code: d.code,
          }),
        ),
      );
    }
    closed = true;
    try {
      controller?.close();
    } catch {
      // 已经关了，或者客户端断开时被取消过，忽略
    }
  });

  return new Response(stream, {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  });
}

/**
 * GET /api/review —— 给前端探活用。
 * 输入页据此提前提示"还没配 API key"，而不是让用户写完作文才报错。
 */
export async function GET() {
  return NextResponse.json(
    {
      ready: hasApiKey(),
      // 没配口令时服务端会拒绝一切批改，输入页据此提前提示
      gated: hasAccessCode(),
      model: getModel(),
      // 限流状态存在哪。给一个模式串而不是布尔：出问题时第一句要问的正是
      // "它到底有没有真的用上数据库"，两个值比 true/false 多带一半信息。
      // ⚠️ 它报的是**配置**（有没有 DATABASE_URL），不是"数据库此刻活着"——
      // 运行期挂掉会降级到内存，这里看不出来，只有终端里那条告警会说话
      persistence: persistenceMode(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
