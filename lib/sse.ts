/**
 * Server-Sent Events 的编解码。
 *
 * 只用到了一个很小的子集：服务端一帧一帧地写 `event:` + `data:`，客户端按空行切帧。
 * 没有 id/retry/重连——批改是有状态的单次请求，断线重来一遍比续传更简单也更可靠。
 *
 * 两个函数都是同构的（不碰 Node 也不碰 DOM），所以自测能直接跑。
 */

/** 一帧解析出来的结果。 */
export interface SseFrame {
  event: string;
  /** JSON.parse 之后的值；解析失败时为 undefined，此时看 raw */
  data: unknown;
  /** 原始 data 文本，解析失败时用来记日志 */
  raw: string;
}

/**
 * 编码一帧。
 *
 * JSON.stringify 会把字符串里的换行转义成字面的 \n（两个字符），所以
 * data 永远只占一行，不会把帧结构撑破——这是这里敢直接拼字符串的前提。
 */
export function encodeSseFrame(event: string, data: unknown): string {
  const payload = JSON.stringify(data);
  return `event: ${event}\ndata: ${payload === undefined ? "null" : payload}\n\n`;
}

/**
 * 流式响应的响应头。
 *
 * `Cache-Control: no-transform` 是这里最要紧的一个，不是装饰：
 * next 15 默认给每个请求套一层 compression（见
 * node_modules/next/dist/server/lib/router-server.js），而它内置的 compressible
 * 把 text/event-stream 判定为**可压缩**，阈值检查也不救场（流式响应没有
 * Content-Length）。目前帧还能立刻出去，只是因为 next 每次 res.write 之后会调
 * res.flush()。加上 no-transform 让 shouldTransform() 直接返回 false，
 * 把压缩整个从链路上摘掉，就不再依赖那个实现细节了。
 *
 * X-Accel-Buffering 是给自托管的 nginx 用的（Vercel 上没有 nginx，但无害）。
 */
export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export interface SseFrameParser {
  /** 喂进一块新收到的文本，返回这一块里凑齐的帧（可能是 0 个或多个）。 */
  push(chunk: string): SseFrame[];
}

/**
 * 按空行切帧的增量解析器。
 *
 * 关键约束：**一个帧可能被切在两块 chunk 之间**，切点还可能在空行正中间
 * （前一块以 \r\n\r 结尾、后一块以 \n 开头）。所以这里刻意不对换行做归一化——
 * 一旦按块把孤立的 \r 或 \n 规整成 \n，上面那种切法就会被误判成一个空行，
 * 凭空多切出一帧来。做法是保留原始缓冲、每次在整个缓冲里找最早的空行。
 * 缓冲只留没凑成帧的尾巴，所以不会无限增长。
 */
export function createSseFrameParser(): SseFrameParser {
  let buffer = "";

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const frames: SseFrame[] = [];

      for (;;) {
        const boundary = findFrameBoundary(buffer);
        if (!boundary) break;

        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseBlock(block);
        if (frame) frames.push(frame);
      }

      return frames;
    },
  };
}

/** 找最早出现的空行。返回下标和长度（\n\n=2、\r\n\r\n=4、\r\r=2）。 */
function findFrameBoundary(
  text: string,
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;

  for (const sep of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const index = text.indexOf(sep);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, length: sep.length };
  }

  return best;
}

/**
 * 解析一个帧块。返回 null 表示这个块没有 data（比如只有注释行或空块）。
 *
 * 按规范：以 ':' 开头的是注释；data 的多行要用换行拼起来；没有 data 的块不派发。
 */
function parseBlock(block: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // 规范规定冒号后紧跟的**一个**空格要去掉，多出来的空格是数据的一部分
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return null;

  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw), raw };
  } catch {
    // 解析失败也把帧交出去（带上 raw 和 undefined 的 data），让调用方决定怎么处理。
    // 在这里静默丢掉会更糟：那样上层只会看到"流结束了但没有结果"，
    // 而真正的原因（这个帧坏了）就丢了。
    return { event, data: undefined, raw };
  }
}
