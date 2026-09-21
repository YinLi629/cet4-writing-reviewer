/**
 * DeepSeek 客户端。
 *
 * DeepSeek 的接口是 OpenAI 兼容的，所以这里用原生 fetch 直接打，
 * 不引入 openai SDK——少一个依赖，也少一层黑盒。
 *
 * 想换成别家（通义 / Kimi / 智谱 / 本地 Ollama）只需改 DEEPSEEK_BASE_URL，
 * 前提是对方兼容 /chat/completions 与 response_format=json_object。
 */

import { createSseFrameParser, type SseFrame } from "./sse";
import type { ReviewErrorResponse } from "./types";

export class LLMError extends Error {
  code: ReviewErrorResponse["code"];
  status?: number;

  constructor(code: ReviewErrorResponse["code"], message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
/**
 * 100 秒，比 app/api/review/route.ts 的 maxDuration = 120 秒少 20 秒。
 *
 * 这个差值不能省：模型在第 99 秒返回后，还要解析输出、定位证据（逐条在原文里
 * 找）、组织响应，这些都要时间。两者相等的话，平台会在我们收尾时把函数掐掉，
 * 用户只看到一个平台级报错，而额度已经花掉了。
 *
 * 流式路径（openChatStream / readChatStream）里这个数的含义变大了：它成了**覆盖整个生成过程的
 * 总预算**，而不再只是"等到响应头"。这不是顺带的好处，是必须的修正——
 * fetch 在响应头到达时就 resolve 了，原来那个在 fetch 之后就 clearTimeout 的写法
 * 会让生成阶段完全没有上限，上游挂住就会一直计费。停滞超时见 getStallMs()。
 */
const DEFAULT_TIMEOUT_MS = 100_000;

/**
 * 0，不是 0.2。这是评测量出来的，不是想当然。
 *
 * 2026-09 用同一份代码连着跑了两遍 28 篇语料（lib/prompt 与 lib/rubric 完全未改），
 * 结果 28 篇里有 13 篇分数变化，平均绝对波动 0.75 分/篇，最大 4 分（c9 13→9）。
 * 最能说明问题的是 b5：content/language/organization 三项维度分和 major 条数
 * **逐项完全相同**，总分却从 14 变成 12——分数抖动不是来自模型的诊断，而是
 * 采样本身。
 *
 * 改成 0 之后连跑两遍，波动降到 0.07 和 0.25 分/篇（两个样本），即 3-10 倍
 * 的改善。**但没有降到 0**：维度分仍会翻（content 4↔3、language 4↔3），所以
 * 「同一篇作文两次提交拿到同一个分数」还没有完全做到，只能说抖动小了一个
 * 数量级。剩下的部分来自服务端（批处理、MoE 路由），temperature 管不着。
 *
 * 对一个批改网站来说这仍然是产品级问题：同一篇作文交两次、一次 13 分一次 9 分，
 * 用户没法信任这个分数。temperature 是这里唯一能直接掐掉的随机源，所以取 0。
 *
 * 要看实际效果，用 `npm run eval` 连跑两遍，再 `npm run eval:compare` 对比。
 */
const DEFAULT_TEMPERATURE = 0;

export function getModel(): string {
  return process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL;
}

function getBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getTimeoutMs(): number {
  const raw = Number(process.env.REVIEW_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * 30 秒没有收到任何新字节就中止。
 *
 * 流式路径额外需要这个计时器。总预算（REVIEW_TIMEOUT_MS）只能说明"总共超过了
 * 100 秒"，而用户实际遇到的失败几乎都是"卡住了、连接还在"。两者的提示语不一样，
 * 后者能直接告诉用户发生了什么，前者只能给一个没有指导意义的数字。
 */
const DEFAULT_STALL_MS = 30_000;

function getStallMs(): number {
  const raw = Number(process.env.REVIEW_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_MS;
}

/**
 * .env.local.example 里的占位值。它非空，所以会被"配了 key"的检查放过，
 * 结果是把占位符当 key 发给上游，用户只能看到一个没头没尾的 401。
 */
const PLACEHOLDER_KEY = /^sk-x+$/i;

/**
 * 取真实的 API key。占位值一律视为没配，让调用方尽早报出可操作的错误。
 */
export function getApiKey(): string | undefined {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key || PLACEHOLDER_KEY.test(key)) return undefined;
  return key;
}

export function hasApiKey(): boolean {
  return getApiKey() !== undefined;
}

export interface ChatJSONOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 覆盖默认模型，一般不用传 */
  model?: string;
  /**
   * 调用方的中止信号（路由传的是 request.signal）。用户关标签页 / 刷新时，
   * 上游调用会被一起掐掉，不再为一个没人在收的响应继续烧额度。
   */
  signal?: AbortSignal;
}

export interface ChatJSONResult<T> {
  data: T;
  raw: string;
  model: string;
  elapsedMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * 调用模型并解析出 JSON 对象。
 *
 * 解析分三层兜底，因为即使开了 json_object，模型偶尔还是会包一层
 * Markdown 代码块或者在前面加一句"好的，以下是批改结果"。
 */
export async function chatJSON<T>(opts: ChatJSONOptions): Promise<ChatJSONResult<T>> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new LLMError(
      "MISSING_API_KEY",
      "服务端没有可用的 DEEPSEEK_API_KEY。如果 .env.local 里还是 sk-xxxx 这样的占位值，" +
        "请换成 https://platform.deepseek.com/api_keys 里的真实 key，然后重启开发服务器。",
    );
  }

  const model = opts.model ?? getModel();
  const startedAt = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

  // 把调用方的信号并进同一个 controller。手写而不用 AbortSignal.any：
  // 后者要 Node 20.3+。项目现在的最低版本是 19（package.json 的 engines，
  // 被 @neondatabase/serverless 逼上来的），仍然够不着那个方法；而且手写这版
  // 能在 finally 里 removeEventListener，AbortSignal.any 没有对应的撤销方式。
  const external = opts.signal;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(apiKey),
      body: JSON.stringify(buildChatBody(opts, model, false)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      // 分清是谁掐的。客户端先断开时不能报超时——既误导用户，也会把
      // "用户自己关页面"记成服务端故障
      throw abortErrorFor(external?.aborted ? "client" : "budget");
    }
    // 网络层细节只进服务端日志，不透给客户端
    console.error("[deepseek] 请求模型服务失败：", err);
    throw new LLMError(
      "UPSTREAM_ERROR",
      "无法连接到模型服务。请检查服务端网络与 DEEPSEEK_BASE_URL 配置，详情见服务端日志。",
    );
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", onExternalAbort);
  }

  if (!res.ok) {
    const failure = await upstreamFailure(res);
    throw failure.error;
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: ChatJSONResult<T>["usage"];
      }
    | null;

  const raw = payload?.choices?.[0]?.message?.content ?? "";
  if (!raw.trim()) {
    throw new LLMError("BAD_MODEL_OUTPUT", "模型返回了空内容。");
  }

  const data = extractJson<T>(raw);
  return {
    data,
    raw,
    model,
    elapsedMs: Date.now() - startedAt,
    usage: payload?.usage,
  };
}

/**
 * 从模型输出里抠出 JSON。
 * 三级兜底：直接解析 → 剥 Markdown 代码块 → 截取首尾花括号之间的内容。
 */
export function extractJson<T>(raw: string): T {
  const trimmed = raw.trim();

  const attempts: string[] = [trimmed];

  // 剥掉 ```json ... ``` 包裹。这里刻意不在捕获组两侧写 \s*：
  // 贪婪 \s* 夹一个懒惰组是经典的二次回溯形状，空白交给后面的 trim() 处理就够了
  const fence = trimmed.match(/```(?:json)?([\s\S]*?)```/);
  if (fence?.[1]) attempts.push(fence[1].trim());

  // 截取第一个 { 到最后一个 }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    attempts.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as T;
    } catch {
      // 试下一种
    }
  }

  // 日志里只留开头一小段：模型输出的主体是作文引文，全文写进日志就等于
  // 把学生作文落到了服务端磁盘上，和 README 承诺的"不落库"相悖。
  // 开头这几十字符足以判断"是不是又包了层代码块/加了句客套话"。
  console.error(
    `[deepseek] 模型输出不是合法 JSON（${trimmed.length} 字符，开头：${trimmed.slice(0, 80).replace(/\s+/g, " ")}）`,
  );

  throw new LLMError(
    "BAD_MODEL_OUTPUT",
    "模型没有返回可解析的 JSON，批改未能完成。这通常重试一次就好；若持续出现请查看服务端日志。",
  );
}

// ---------------------------------------------------------------------------
// 请求构造与错误分类（chatJSON 与流式路径共用）
//
// 抽出来的理由不是"少写几行"，而是这几处正是自测盯得最紧的地方：
// 同样的失败必须在两条传输路径上给出同样的错误码和同样的文案。
// 复制一份的话，改了这边忘了那边是迟早的事。
// ---------------------------------------------------------------------------

function chatHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildChatBody(
  opts: ChatJSONOptions,
  model: string,
  stream: boolean,
  withJsonMode = true,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: opts.maxTokens ?? 4096,
    ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
    stream,
  };
}

type AbortReason = "client" | "budget" | "stall" | "none";

/** 中止原因 → 错误。两条路径共用，保证同样的失败给出同样的文案。 */
function abortErrorFor(reason: AbortReason): LLMError {
  if (reason === "client") {
    return new LLMError("CLIENT_ABORTED", "客户端已断开连接，批改已中止。");
  }
  if (reason === "stall") {
    return new LLMError(
      "TIMEOUT",
      `模型超过 ${Math.round(getStallMs() / 1000)} 秒没有返回新内容，批改已中止。这通常是上游抖动，重试一次一般就好。`,
    );
  }
  return new LLMError(
    "TIMEOUT",
    `批改超时（超过 ${Math.round(getTimeoutMs() / 1000)} 秒）。可以调大 .env.local 里的 REVIEW_TIMEOUT_MS，或换一篇短一点的作文。`,
  );
}

/**
 * 上游返回非 2xx。
 *
 * 把 bodyText 一并交出去，是因为流式路径要在**推出任何一帧之前**判断这次失败
 * 是不是"上游不接受 response_format"——是的话就去掉它重试一次，
 * 而重试的决定只能看响应体。开流之后就改不了状态码了，所以这一步必须提前。
 */
async function upstreamFailure(
  res: Response,
): Promise<{ status: number; bodyText: string; error: LLMError }> {
  const bodyText = await res.text().catch(() => "");
  // 上游的错误响应只进服务端日志。里面可能有余额提示、代理调试信息、
  // 请求 id 之类不该给匿名调用方看的东西
  console.error(`[deepseek] 上游返回 ${res.status}：`, bodyText.slice(0, 1000));

  const error = new LLMError(
    "UPSTREAM_ERROR",
    res.status === 401 || res.status === 403
      ? "模型服务拒绝了这次调用（鉴权失败）。多半是服务端的 DEEPSEEK_API_KEY 无效或已过期，请检查配置。"
      : "模型服务返回了错误，批改未能完成。请稍后重试；若持续失败请查看服务端日志。",
    res.status,
  );

  return { status: res.status, bodyText, error };
}

// ---------------------------------------------------------------------------
// 流式
// ---------------------------------------------------------------------------

export interface ChatStreamOptions extends ChatJSONOptions {
  /** 每收到一段文本增量调一次。回调抛异常会被吞掉，不能影响读取。 */
  onDelta?: (text: string) => void;
}

export interface ChatStreamRead {
  raw: string;
  model: string;
  elapsedMs: number;
  /** 上游给的结束原因。"length" 表示被 max_tokens 截断了。 */
  finishReason: string | null;
}

/**
 * 已经建立、还没消费的流。
 *
 * 分成"打开"和"读取"两步，是为了让调用方能在**还没有向客户端写出任何字节之前**
 * 就知道上游接不接受这次请求。少了这一步，上游的 401/5xx 就只能变成流里的一帧，
 * 客户端的错误界面和 README 的错误码表都会失准。
 */
export interface ChatStreamHandle {
  model: string;
  /**
   * 消费整个流。只能调用一次。
   * 注意没有 usage：DeepSeek 只在 stream_options.include_usage 时才在流里给，
   * 而那个字段有些兼容端点不认，不值得为一份没人消费的数据冒这个险。
   */
  read(): Promise<ChatStreamRead>;
  /** 不打算消费就调它：取消上游连接、清掉计时器 */
  dispose(): void;
}

/** 总预算 / 停滞 / 客户端断开，三个中止来源合成一个 controller，并记住是谁掐的。 */
interface StreamWatch {
  controller: AbortController;
  reason: AbortReason;
  /** 收到新数据就续命（重置停滞计时器） */
  kick(): void;
  dispose(): void;
}

function createAbortWatch(external: AbortSignal | undefined): StreamWatch {
  const controller = new AbortController();
  const watch: StreamWatch = {
    controller,
    reason: "none",
    kick: () => arm(),
    dispose: () => {
      clearTimeout(budgetTimer);
      clearTimeout(stallTimer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };

  const budgetTimer = setTimeout(() => {
    if (watch.reason === "none") watch.reason = "budget";
    controller.abort();
  }, getTimeoutMs());

  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (watch.reason === "none") watch.reason = "stall";
      controller.abort();
    }, getStallMs());
  };
  arm();

  const onExternalAbort = () => {
    watch.reason = "client";
    controller.abort();
  };
  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  return watch;
}

/**
 * 发起一次流式请求并确认上游接受了它。**此时还没有读到任何内容。**
 *
 * 抛出的 LLMError 带着原始状态码，所以路由还能用正常的状态码回绝客户端。
 */
export async function openChatStream(
  opts: ChatStreamOptions,
): Promise<ChatStreamHandle> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new LLMError(
      "MISSING_API_KEY",
      "服务端没有可用的 DEEPSEEK_API_KEY。如果 .env.local 里还是 sk-xxxx 这样的占位值，" +
        "请换成 https://platform.deepseek.com/api_keys 里的真实 key，然后重启开发服务器。",
    );
  }

  const model = opts.model ?? getModel();
  const startedAt = Date.now();
  const watch = createAbortWatch(opts.signal);

  const post = (withJsonMode: boolean) =>
    fetch(`${getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(apiKey),
      body: JSON.stringify(buildChatBody(opts, model, true, withJsonMode)),
      signal: watch.controller.signal,
    });

  const failedFetch = (err: unknown): never => {
    watch.dispose();
    if (err instanceof Error && err.name === "AbortError") {
      throw abortErrorFor(watch.reason);
    }
    console.error("[deepseek] 请求模型服务失败：", err);
    throw new LLMError(
      "UPSTREAM_ERROR",
      "无法连接到模型服务。请检查服务端网络与 DEEPSEEK_BASE_URL 配置，详情见服务端日志。",
    );
  };

  let res: Response;
  try {
    res = await post(true);
  } catch (err) {
    return failedFetch(err);
  }

  if (!res.ok) {
    const failure = await upstreamFailure(res);

    // 兜底：上游不认 stream + response_format 这个组合时，去掉 response_format
    // 重试一次。去掉之后仍然安全——提示词本来就把"只输出一个 JSON 对象"写死了，
    // extractJson 有三层兜底，增量扫描器也能容忍 JSON 前面多几句客套话。
    //
    // 只在 400 且响应体明确提到 response_format 时才重试，不做无条件降级：
    // json_object 确实减少了模型输出的废话，正常路径上不该丢掉它。
    if (failure.status === 400 && /response_format/i.test(failure.bodyText)) {
      console.error(
        "[deepseek] 上游不接受 response_format，去掉它重试一次（流式组合的兜底）",
      );
      try {
        res = await post(false);
      } catch (err) {
        return failedFetch(err);
      }
      if (!res.ok) {
        watch.dispose();
        throw (await upstreamFailure(res)).error;
      }
    } else {
      watch.dispose();
      throw failure.error;
    }
  }

  if (!res.body) {
    watch.dispose();
    throw new LLMError("UPSTREAM_ERROR", "模型服务没有返回响应体，批改未能完成。");
  }

  return makeStreamHandle(res, model, startedAt, watch, opts.onDelta);
}

function makeStreamHandle(
  res: Response,
  model: string,
  startedAt: number,
  watch: StreamWatch,
  onDelta: ((text: string) => void) | undefined,
): ChatStreamHandle {
  let consumed = false;

  return {
    model,
    async read(): Promise<ChatStreamRead> {
      if (consumed) throw new Error("ChatStreamHandle.read() 只能调用一次。");
      consumed = true;
      try {
        return await readStreamBody(res, model, startedAt, watch, onDelta);
      } finally {
        // 读取结束（正常或异常）就撤掉计时器，别让它们在流关掉之后继续跑
        watch.dispose();
      }
    },
    dispose(): void {
      if (consumed) return;
      consumed = true;
      watch.dispose();
      // 主动取消：上游还有 token 在往外吐，我们不要了
      res.body?.cancel().catch(() => undefined);
    },
  };
}

async function readStreamBody(
  res: Response,
  model: string,
  startedAt: number,
  watch: StreamWatch,
  onDelta: ((text: string) => void) | undefined,
): Promise<ChatStreamRead> {
  const body = res.body;
  if (!body) {
    throw new LLMError("UPSTREAM_ERROR", "模型服务没有返回响应体，批改未能完成。");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = createSseFrameParser();

  let raw = "";
  let finishReason: string | null = null;

  const consume = (frames: SseFrame[]): void => {
    for (const frame of frames) {
      // [DONE] 不是 JSON，解析器会给出 data: undefined + raw: "[DONE]"
      if (frame.raw.trim() === "[DONE]") continue;

      const payload = frame.data as
        | {
            choices?: Array<{
              delta?: { content?: unknown };
              finish_reason?: unknown;
            }>;
          }
        | undefined;
      const choice = payload?.choices?.[0];
      if (!choice) continue;

      if (typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      const text = choice.delta?.content;
      if (typeof text !== "string" || !text) continue;

      raw += text;
      try {
        onDelta?.(text);
      } catch (err) {
        // 回调只负责展示，它的异常绝不能打断读取
        console.error("[deepseek] onDelta 回调抛出异常，已忽略：", err);
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 停滞的定义就是"没有新字节"，所以任何一块数据都要续命。
      // 这里必须在 push 之前——即使这一块只是半帧，也证明上游还活着。
      watch.kick();
      consume(parser.push(decoder.decode(value, { stream: true })));
    }
    // 收尾：最后一块可能没带结尾空行，补一个让解析器把攒着的帧吐出来
    consume(parser.push(decoder.decode()));
    consume(parser.push("\n\n"));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw abortErrorFor(watch.reason);
    }
    console.error("[deepseek] 读取模型流失败：", err);
    throw new LLMError(
      "UPSTREAM_ERROR",
      "读取模型输出时连接中断，批改未能完成。请重试一次。",
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已取消或已释放，忽略
    }
  }

  return { raw, model, elapsedMs: Date.now() - startedAt, finishReason };
}

/**
 * 把流式读到的累积文本解析成 JSON。
 *
 * 和 chatJSON 走同一个 extractJson，所以两条路径的解析规则不会分叉。
 * 关键：最终对象永远是对**累积全文**解析一次得到的，增量扫描（lib/json-stream.ts）
 * 只负责进度展示，它坏了也影响不到正确性。
 */
export function parseStreamedJSON<T>(read: ChatStreamRead): T {
  if (!read.raw.trim()) {
    throw new LLMError("BAD_MODEL_OUTPUT", "模型返回了空内容。");
  }

  try {
    return extractJson<T>(read.raw);
  } catch (err) {
    // 被 max_tokens 截断时给一条能指导行动的错误，而不是笼统的"不是合法 JSON"
    if (
      read.finishReason === "length" &&
      err instanceof LLMError &&
      err.code === "BAD_MODEL_OUTPUT"
    ) {
      throw new LLMError(
        "BAD_MODEL_OUTPUT",
        `模型输出被 max_tokens 截断了（${read.raw.length} 字符），批改未能完成。请重试一次。`,
      );
    }
    throw err;
  }
}
