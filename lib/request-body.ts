/**
 * 带硬性大小上限的请求体读取。
 *
 * 为什么需要这个：Next.js App Router 的 route handler **没有**默认 body 大小限制
 * （Pages API 那个 1MB 只作用于 pages/api）。不设限的话，任何匿名请求都能让服务端
 * 先把任意大的 JSON 完整读进内存并解析，之后才走到口令校验——闸门拦不住这一步。
 *
 * 注意这一层在 JSON.parse **之前**，是唯一的硬闸。lib/review.ts 里的校验全都
 * 发生在那之后，拦不住"先把内存吃掉"这件事。
 *
 * 只查 Content-Length 是不够的：恶意客户端可以不发这个头、改用 chunked 编码。
 * 所以这里流式读取并累计字节数，一超限就立刻停手，剩下的 body 不再读。
 */

/**
 * 128 KB。**这是现在整个接口真正的输入天花板**——作文本身不限字数（见
 * lib/types.ts），所以下限之外的边界只剩这一条。
 *
 * 定这个数的依据换过一次。原来是"8000 字符上限的最坏情况（4000 个 emoji，
 * JSON 转义后每个 12 字节）+ 余量"倒推出来的；字数上限取消之后那个算法失效了，
 * 现在的依据是**模型上下文窗口**：
 *
 *   英文    1 字符 ≈ 1 字节          128 KB ≈ 12 万字符
 *   汉字    1 字符 = 3 字节          128 KB ≈ 4 万字符
 *   emoji   转义后 12 字节一个        128 KB ≈ 1 万个
 *
 * 三种最坏情况折算成 token 都在几万量级，加上提示词和 max_tokens 的输出预算，
 * 仍然装得进 deepseek-chat 的上下文窗口。也就是说：**只要请求体过得来，
 * 模型那边就不会因为超长而报错**——超长输入会得到一个正常的批改结果，
 * 而不是一个看不懂的上游错误。这是这个数最重要的性质，改小之前先想清楚。
 */
export const MAX_BODY_BYTES = 128 * 1024;

export type ReadBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "TOO_LARGE" | "INVALID_JSON" };

export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<ReadBodyResult> {
  const raw = await readTextWithLimit(request, maxBytes);
  if (raw === null) return { ok: false, reason: "TOO_LARGE" };

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }
}

/** 超限返回 null。用 TextDecoder 的流式模式，避免多字节字符被分块切断。 */
async function readTextWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  // Content-Length 命中时可以省掉读取开销，但它不可信，所以只是快路径，
  // 真正的强制在下面的累计计数里
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = request.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // 关键：不把剩下的读完。否则"限制"只是延迟了内存占用
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已 cancel 或已释放，忽略
    }
  }
}
