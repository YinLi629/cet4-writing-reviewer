/**
 * POST /api/review —— 批改入口。
 *
 * 这个路由只做三件事：读请求、调 lib/review、把错误翻译成合适的状态码。
 * 所有业务逻辑都在 lib/ 里，路由本身保持薄。
 */

import { NextResponse } from "next/server";

import { getModel, hasApiKey, LLMError } from "@/lib/deepseek";
import { reviewEssay } from "@/lib/review";
import type { ReviewErrorResponse } from "@/lib/types";

// DeepSeek 调用需要 Node 运行时（用到了 process.env 和较长的超时）
export const runtime = "nodejs";
// 批改一篇作文可能要几十秒，别让平台提前掐断
export const maxDuration = 120;

function statusFor(code: ReviewErrorResponse["code"]): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "MISSING_API_KEY":
      // 是服务端配置问题，不是调用方的错
      return 500;
    case "TIMEOUT":
      return 504;
    case "UPSTREAM_ERROR":
    case "BAD_MODEL_OUTPUT":
      return 502;
    default:
      return 500;
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json<ReviewErrorResponse>(
      { error: "请求体不是合法 JSON。", code: "INVALID_INPUT" },
      { status: 400 },
    );
  }

  try {
    const result = await reviewEssay(
      (body ?? {}) as Parameters<typeof reviewEssay>[0],
    );
    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (err instanceof LLMError) {
      return NextResponse.json<ReviewErrorResponse>(
        { error: err.message, code: err.code },
        { status: statusFor(err.code) },
      );
    }

    // 非预期错误：日志留全量，响应只给一句话，避免把内部细节泄露出去
    console.error("[api/review] 未预期的错误：", err);
    return NextResponse.json<ReviewErrorResponse>(
      { error: "服务端出现未预期的错误，请查看运行终端里的日志。", code: "UNKNOWN" },
      { status: 500 },
    );
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
      model: getModel(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
