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
 *   限流 → 锁定检查 → 读 body（带上限）→ 验口令 → 调模型
 * 每一步都尽量把不该处理的请求挡在下一步之前，尤其是挡在收费的模型调用之前。
 */

import { NextResponse } from "next/server";

import { hasAccessCode, verifyAccessCode } from "@/lib/access";
import { getModel, hasApiKey, LLMError } from "@/lib/deepseek";
import { clientKeyFrom, sharedLimiter } from "@/lib/rate-limit";
import { readJsonBody } from "@/lib/request-body";
import { reviewEssay } from "@/lib/review";
import { MAX_ESSAY_CHARS, type ReviewErrorResponse } from "@/lib/types";

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

export async function POST(request: Request) {
  const limiter = sharedLimiter();
  const clientKey = clientKeyFrom(request);

  // ① 频率限制。无论口令对错都计数——否则拿错口令空刷接口就绕过去了
  const rate = limiter.checkReview(clientKey);
  if (!rate.allowed) {
    return errorResponse(
      "RATE_LIMITED",
      `批改请求太频繁了，请 ${humanizeWait(rate.retryAfterMs)}后再试。`,
      { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
    );
  }

  // ② 锁定检查放在读 body 之前：被锁的调用方连解析都不该触发。
  //    这一层挡的是"同一个 IP 反复猜口令"，正常用户碰不到。
  const lock = limiter.lockState(clientKey);
  if (!lock.allowed) {
    return errorResponse(
      "RATE_LIMITED",
      `访问口令连续输错太多次，已暂时锁定，请 ${humanizeWait(lock.retryAfterMs)}后再试。`,
      { "Retry-After": String(Math.ceil(lock.retryAfterMs / 1000)) },
    );
  }

  // ③ 读 body，带硬性大小上限。注意必须跑在 JSON.parse 之前——
  //    见 lib/request-body.ts 顶部注释
  const read = await readJsonBody(request);
  if (!read.ok) {
    return read.reason === "TOO_LARGE"
      ? errorResponse(
          "PAYLOAD_TOO_LARGE",
          `请求体太大了。作文字数上限是 ${MAX_ESSAY_CHARS} 字符，如果没超，请检查是不是多带了别的内容。`,
        )
      : errorResponse("INVALID_INPUT", "请求体不是合法 JSON。");
  }
  const body = read.value;

  // ④ 先验口令，再谈批改——没通过就别浪费模型额度
  const verdict = verifyAccessCode(
    (body as { accessCode?: unknown } | null)?.accessCode,
  );
  if (!verdict.ok) {
    const code =
      verdict.reason === "MISSING_CONFIG" ? "MISSING_ACCESS_CODE" : "INVALID_ACCESS_CODE";

    // 只有"口令错了"才记失败。缺配置是站长的锅，不该把调用方锁掉
    if (code === "INVALID_ACCESS_CODE") {
      limiter.recordFailure(clientKey);
      // 人为拖慢，抬高串行爆破的成本。代价是正常用户打错一次也要等这一下
      if (limiter.failDelayMs > 0) {
        await new Promise((r) => setTimeout(r, limiter.failDelayMs));
      }
    }

    return errorResponse(
      code,
      code === "MISSING_ACCESS_CODE"
        ? "服务端没有配置访问口令，批改功能暂不可用。请在环境变量里设置 REVIEW_ACCESS_CODE 后重启或重新部署。"
        : "访问口令不正确。请检查后重试。",
    );
  }
  limiter.recordSuccess(clientKey);

  try {
    // 透传 request.signal：用户关标签页/刷新后，上游调用会被中止，
    // 不再为一个没人在等的响应继续烧额度
    const result = await reviewEssay(
      (body ?? {}) as Parameters<typeof reviewEssay>[0],
      request.signal,
    );
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      // 客户端自己断开的，响应没人收，也不该记成服务端故障
      if (err.code === "CLIENT_ABORTED") {
        return errorResponse("CLIENT_ABORTED", "客户端已断开连接。");
      }
      return errorResponse(err.code, err.message);
    }

    // 非预期错误：日志留全量，响应只给一句话，避免把内部细节泄露出去
    console.error("[api/review] 未预期的错误：", err);
    return errorResponse("UNKNOWN", "服务端出现未预期的错误，请查看运行终端里的日志。");
  }
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
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
