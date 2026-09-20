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
const DEFAULT_TIMEOUT_MS = 120_000;

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
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 4096,
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new LLMError(
        "TIMEOUT",
        `批改超时（超过 ${Math.round(getTimeoutMs() / 1000)} 秒）。可以调大 .env.local 里的 REVIEW_TIMEOUT_MS，或换一篇短一点的作文。`,
      );
    }
    throw new LLMError(
      "UPSTREAM_ERROR",
      `无法连接到模型服务：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // 把上游的错误信息透出来，但绝不回显 api key
    const bodyText = await res.text().catch(() => "");
    const snippet = bodyText.slice(0, 500);
    throw new LLMError(
      "UPSTREAM_ERROR",
      `模型服务返回 ${res.status}。${snippet ? `响应：${snippet}` : ""}`,
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

  // 剥掉 ```json ... ``` 包裹
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
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

  throw new LLMError(
    "BAD_MODEL_OUTPUT",
    `模型没有返回合法 JSON。原始输出前 300 字：${trimmed.slice(0, 300)}`,
  );
}
