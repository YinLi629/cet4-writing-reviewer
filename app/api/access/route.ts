/**
 * POST /api/access —— 口令页的校验入口。
 *
 * 它只回答一个问题：这个口令对不对。**不碰模型、不占批改配额。**
 *
 * 为什么值得单开一条路由，而不是让口令页把口令记下来直接跳到 /review：
 * 那样输错口令也能进批改页，要等写完一整篇点下「开始批改」才发现口令不对——
 * 而那次尝试**已经计进配额了**（见 README「计数口径」：计的是"口令通过的请求"，
 * 不是"真正调用了模型的请求"）。一次额度加一篇作文，一起白花。
 *
 * ## 它不能变成一把无限次的猜口令机
 *
 * 这条路由不调模型、不花钱，看起来人畜无害，但它是**又一个验口令的入口**：
 * 只要它比 /api/review 宽松一点点，爆破的人就会改从这里进。所以它走的是
 * **完全相同**的防爆破路径——早检查锁 → 错了记失败、按档位上锁、人为拖慢。
 * 共用的处置和文案都在 lib/access-gate.ts，不在这里重写一遍。
 *
 * 和批改路由有两处**有意**的不同，都是"不花钱"这个事实带来的：
 *
 * - **不做配额早拒。** 口令页不消耗那每小时 100 次——它没有让站长花一分钱。
 * - **输对了不清零失败计数。** recordSuccess 会顺手清零，但它的语义是"批改了一次"，
 *   借用它会顺带吃掉一次配额。代价是"在口令页连错 6 次、第 7 次输对"之后再错一次
 *   就会被锁——刻意的取舍：要清零就得在存储层加一个"只清失败、不计数"的方法
 *   （Postgres 和内存两份实现都要写、自测也要跟着加），换来的只是少一次误锁。
 *   正常路径不受影响：接着去批改一次，那条写语句会把失败记录一起清零。
 */

import { NextResponse } from "next/server";

import { verifyAccessCode } from "@/lib/access";
import {
  ACCESS_DENIED_MESSAGE,
  lockedAfterFailureMessage,
  lockedMessage,
  MISSING_CONFIG_MESSAGE,
  penalizeAccessFailure,
} from "@/lib/access-gate";
import { clientKeyFrom } from "@/lib/rate-limit";
import { getGate } from "@/lib/rate-limit-store";
import { readJsonBody } from "@/lib/request-body";
import type { ReviewErrorResponse } from "@/lib/types";

export const runtime = "nodejs";

/**
 * 这条路由用得上的状态码。和 app/api/review/route.ts 的 statusFor 是同一套映射，
 * 但那条路由覆盖全部错误码，这里只有四种情形，摊开写比引一个映射表清楚。
 */
const STATUS: Record<string, number> = {
  INVALID_ACCESS_CODE: 401,
  INVALID_INPUT: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  MISSING_ACCESS_CODE: 500,
};

function deny(
  code: ReviewErrorResponse["code"],
  message: string,
  headers?: HeadersInit,
): NextResponse<ReviewErrorResponse> {
  return NextResponse.json<ReviewErrorResponse>(
    { error: message, code },
    { status: STATUS[code] ?? 500, headers },
  );
}

/** 锁定时的 Retry-After 头，两条 429 共用 */
function retryAfter(ms: number): HeadersInit {
  return { "Retry-After": String(Math.ceil(ms / 1000)) };
}

export async function POST(request: Request) {
  const gate = getGate();
  const clientKey = clientKeyFrom(request);

  // ① 早拒，放在读 body 之前：被锁的调用方连解析都不该触发
  const state = await gate.peek(clientKey);
  if (state.lockRetryAfterMs > 0) {
    return deny("RATE_LIMITED", lockedMessage(state.lockRetryAfterMs), retryAfter(state.lockRetryAfterMs));
  }

  // ② 读 body，带硬性大小上限。用的是和批改路由同一个读取器——
  //    口令页没有任何理由比批改页宽松
  const read = await readJsonBody(request);
  if (!read.ok) {
    return read.reason === "TOO_LARGE"
      ? deny("PAYLOAD_TOO_LARGE", "请求体太大了（超过 128 KB）。")
      : deny("INVALID_INPUT", "请求体不是合法 JSON。");
  }

  // ③ 验口令
  const verdict = verifyAccessCode(
    (read.value as { accessCode?: unknown } | null)?.accessCode,
  );
  if (!verdict.ok) {
    // 缺配置是站长的锅，不该把调用方锁掉（和批改路由同一条规矩）
    if (verdict.reason === "MISSING_CONFIG") {
      return deny("MISSING_ACCESS_CODE", MISSING_CONFIG_MESSAGE);
    }
    const { lockedForMs } = await penalizeAccessFailure(gate, clientKey);
    if (lockedForMs > 0) {
      return deny("RATE_LIMITED", lockedAfterFailureMessage(lockedForMs), retryAfter(lockedForMs));
    }
    return deny("INVALID_ACCESS_CODE", ACCESS_DENIED_MESSAGE);
  }

  // ④ 通过。响应里不带任何东西——尤其不回显口令本身
  return NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
