/**
 * 带硬性大小上限的请求体读取。
 *
 * 为什么需要这个：Next.js App Router 的 route handler **没有**默认 body 大小限制
 * （Pages API 那个 1MB 只作用于 pages/api）。不设限的话，任何匿名请求都能让服务端
 * 先把任意大的 JSON 完整读进内存并解析，之后才走到口令校验——闸门拦不住这一步。
 * lib/review.ts 里的 MAX_ESSAY_CHARS 也拦不住，因为它是 JSON.parse **之后**才检查的。
 *
 * 只查 Content-Length 是不够的：恶意客户端可以不发这个头、改用 chunked 编码。
 * 所以这里流式读取并累计字节数，一超限就立刻停手，剩下的 body 不再读。
 */

/**
 * 128 KB。依据：essay 上限 8000 个 UTF-16 单元，最坏情况是 4000 个 emoji，
 * JSON 转义后每个占 12 字节（\uXXXX\uXXXX）≈ 48 KB，加 topic（上限 1000 单元）
 * 和 JSON 结构，128 KB 有充足余量但仍然把解析开销钉死在可控范围内。
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
