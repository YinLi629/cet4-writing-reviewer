/**
 * DeepSeek 客户端。
 *
 * DeepSeek 的接口是 OpenAI 兼容的，所以这里用原生 fetch 直接打，
 * 不引入 openai SDK——少一个依赖，也少一层黑盒。
 *
 * 想换成别家（通义 / Kimi / 智谱 / 本地 Ollama）只需改 DEEPSEEK_BASE_URL，
 * 前提是对方兼容 /chat/completions 与 response_format=json_object。
 */

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
  // 后者要 Node 20.3+，而 Next 15 只要求 Node 18，不值得为一个便利方法抬版本门槛。
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: opts.maxTokens ?? 4096,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      // 分清是谁掐的。客户端先断开时不能报超时——既误导用户，也会把
      // "用户自己关页面"记成服务端故障
      if (external?.aborted) {
        throw new LLMError("CLIENT_ABORTED", "客户端已断开连接，批改已中止。");
      }
      throw new LLMError(
        "TIMEOUT",
        `批改超时（超过 ${Math.round(getTimeoutMs() / 1000)} 秒）。可以调大 .env.local 里的 REVIEW_TIMEOUT_MS，或换一篇短一点的作文。`,
      );
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
    // 上游的错误响应只进服务端日志。里面可能有余额提示、代理调试信息、
    // 请求 id 之类不该给匿名调用方看的东西
    const bodyText = await res.text().catch(() => "");
    console.error(`[deepseek] 上游返回 ${res.status}：`, bodyText.slice(0, 1000));

    throw new LLMError(
      "UPSTREAM_ERROR",
      res.status === 401 || res.status === 403
        ? "模型服务拒绝了这次调用（鉴权失败）。多半是服务端的 DEEPSEEK_API_KEY 无效或已过期，请检查配置。"
        : "模型服务返回了错误，批改未能完成。请稍后重试；若持续失败请查看服务端日志。",
      res.status,
    );
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
