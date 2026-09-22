/**
 * 客户端读超时的阈值，以及「沉默多久该提示一句」的判定。
 *
 * 为什么单独开一个模块：这几个数字有两拨人在用，而且必须完全一致——
 * `lib/use-review-stream.ts` 的看门狗拿它去真的掐请求，`components/ReviewProgress.tsx`
 * 拿它决定要不要提示。两边各写一份的话，迟早会出现「提示说再等等、请求其实已经被掐了」
 * 这种自相矛盾的界面，而且只在慢网络上偶发。
 *
 * ⚠️ 这里每个数字都在和服务端的超时赛跑。改动之前先读：
 *   · `lib/deepseek.ts` 的 `DEFAULT_TIMEOUT_MS`（总预算，默认 100 秒）
 *   · `lib/deepseek.ts` 的 `DEFAULT_STALL_MS`（上游停滞，默认 30 秒）
 *   · `lib/review.ts` 的 `PROGRESS_INTERVAL_MS`（心跳，2 秒）
 *   · `app/api/review/route.ts` 的 `maxDuration`（平台在 120 秒掐断函数）
 */

/**
 * 首帧之前的读超时。
 *
 * 之所以给得这么长，是因为这一段**根本没有存活信号可用**：服务端在上游返回响应头之前
 * 一个事件都不发（`lib/review.ts` 的时序约定），于是「连接已经死了」和「正在正常等待上游」
 * 在客户端看来一模一样——都不来数据。既然分不清，就不能猜，只能等到服务端自己的总预算
 * （100 秒）走完，再宽限 10 秒让它的报错先飞过来。
 *
 * 设短的代价是**误杀**：上游首字节偶尔会慢到几十秒，那种批改本来是能成的。
 * 这个阈值只负责"最后兜底"，让用户早点知道情况的是下面的提示，不是这里。
 */
export const FIRST_FRAME_DEADLINE_MS = 110_000;

/**
 * 首帧之后的读超时。
 *
 * 这一段有硬信号：首帧发出来之后，服务端每 2 秒一个心跳（`PROGRESS_INTERVAL_MS`）。
 * 所以 40 秒沉默 = 20 个心跳一个都没到，不可能是「上游在长思考」——上游真卡住时
 * 服务端照样发心跳，而且会在 30 秒（`REVIEW_STALL_MS`）时报错推下来。
 *
 * 留到 40 秒而不是刚好 30 秒，是为了让服务端那条**更具体**的报错先到达：
 * 「上游停滞」和「你的网络断了」对用户是两件不同的事，能说准就不要说含糊。
 */
export const STREAM_STALL_DEADLINE_MS = 40_000;

/**
 * 沉默多久开始提示一句。
 *
 * 比服务端 30 秒的停滞超时短：先给一句安抚让人知道没死，再让服务端的报错接上。
 * 首帧之前也用它——正常首字节不到一秒，二十秒还没动静就确实该说一声了。
 */
export const SILENCE_HINT_SECONDS = 20;

/** 读循环处在哪一段。两段的「沉默」含义完全不同，所以阈值也不同 */
export type ReadPhase = "waiting-first-frame" | "streaming";

/** 收到过第一个字节没有。收到了就说明服务端的心跳已经在跑了 */
export function readPhase(headSeen: boolean): ReadPhase {
  return headSeen ? "streaming" : "waiting-first-frame";
}

/** 当前这一段对应的读超时阈值 */
export function deadlineFor(phase: ReadPhase): number {
  return phase === "streaming" ? STREAM_STALL_DEADLINE_MS : FIRST_FRAME_DEADLINE_MS;
}

export interface SilenceHint {
  phase: ReadPhase;
  /** 已经沉默了多少秒，凑成整数直接进文案 */
  seconds: number;
}

/**
 * 沉默这么久，该不该提示。
 *
 * 返回 `null` 表示还在正常范围内，**一个字都不要说**。这条"不哭狼"的边界比阈值本身
 * 更容易被改坏：首帧之后的正常心跳是 2 秒一次，但首帧之前完全正常的等待也可能有
 * 十几秒，那种时候弹一句"好像出问题了"只会让人白紧张，然后过两秒内容就到了。
 */
export function silenceHint(
  phase: ReadPhase,
  silentSeconds: number,
): SilenceHint | null {
  // NaN / Infinity 一律当作"无法判断"。算不出来的时候宁可不说
  if (!Number.isFinite(silentSeconds)) return null;
  if (silentSeconds < SILENCE_HINT_SECONDS) return null;
  return { phase, seconds: Math.floor(silentSeconds) };
}

/**
 * 看门狗判死时给用户看的话。
 *
 * 分两段写是因为**用户能做的事不一样**：中途断连八成是网络，首帧不来八成是上游排队，
 * 而且后者重试一次往往就好了。含糊其辞地说"超时了"会让人以为是自己的作文有问题。
 */
export function deadlineMessage(phase: ReadPhase): string {
  return phase === "streaming"
    ? `批改连接中断了：已经 ${STREAM_STALL_DEADLINE_MS / 1000} 秒没有收到任何数据（正常时每 2 秒有一次心跳）。多半是网络断了，检查网络后重试。`
    : `等了 ${FIRST_FRAME_DEADLINE_MS / 1000} 秒模型还是没有开始返回，已经放弃。可能是上游排队，也可能是网络不通，过一会儿重试通常就好。`;
}

/**
 * 看门狗判死时给错误起的代号。
 *
 * 首帧超时复用服务端那套的 `TIMEOUT`：原因八成在服务端/上游那边，
 * 界面给它配的提示（调大 `REVIEW_TIMEOUT_MS`）也正好对得上。
 * 中途断连是新开的号，语义是"链路"，跟服务端的超时不是一回事，不能混。
 */
export function deadlineCode(phase: ReadPhase): string {
  return phase === "streaming" ? "CONNECTION_LOST" : "TIMEOUT";
}
