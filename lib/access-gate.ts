/**
 * 口令这道闸门的**共享处置与文案**。
 *
 * 为什么单独开一个模块：现在有两条路由都要验口令——`/api/review`（批改）和
 * `/api/access`（口令页）。两条走的是**同一条**防爆破路径：错口令一样记失败、
 * 一样按档位上锁、一样人为拖慢。两处各写一遍的话，改了其中一处的档位或拖慢时长，
 * 另一处就成了缺口——而口令页恰恰是最容易被当成"另一个入口"而漏掉的：
 * 它不调模型、不花钱，看起来人畜无害，但**它可以被当成无限次的猜口令机**。
 *
 * 这里刻意不碰 Next.js（不 import next/server）：返回的是纯数据，由路由翻译成
 * 状态码和响应体。于是这一层能在 selftest 里用一个假的 gate 直接断言。
 */

import type { RateLimitGate } from "./rate-limit-store";

/** 把毫秒换算成「多久后再试」的人话 */
export function humanizeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}

/**
 * 一次口令失败的统一处置：记一笔失败 → 人为拖慢 → 把"这次刚好锁上"的时长交回去。
 *
 * 顺序是有讲究的：拖慢放在 recordFailure **之后**，那一段延迟正好盖住数据库那次
 * 往返；反过来写就是白等两段时间。
 *
 * 拖慢的代价是正常用户打错一次也要等这一下（默认 400ms）。这是刻意的：
 * 串行爆破的成本被抬高了，而真正手滑的人只多等不到半秒。
 */
export async function penalizeAccessFailure(
  gate: RateLimitGate,
  clientKey: string,
): Promise<{ lockedForMs: number }> {
  const failure = await gate.recordFailure(clientKey);
  if (gate.policy.failDelayMs > 0) {
    await new Promise((r) => setTimeout(r, gate.policy.failDelayMs));
  }
  return { lockedForMs: failure.lockRetryAfterMs };
}

/** 锁定期内进来（还没验口令就被挡回）时的文案 */
export function lockedMessage(waitMs: number): string {
  return `访问口令连续输错太多次，已暂时锁定，请 ${humanizeWait(waitMs)}后再试。`;
}

/**
 * 这一次失败**刚好把人锁上**时的文案。
 *
 * 和上面那条分开写，是因为触发时机不同：这条是"你刚刚输错的那一下就是第 7 次"。
 * 如果这里回报笼统的"口令不正确"，用户只会以为是自己又打错了，再试一次才被告知
 * 被锁——那一次尝试又是几十秒的等待。
 */
export function lockedAfterFailureMessage(waitMs: number): string {
  return `访问口令不正确，且连续输错次数过多，已锁定，请 ${humanizeWait(waitMs)}后再试。`;
}

/** 服务端压根没配口令（和"你输错了"是两回事，状态码也不同） */
export const MISSING_CONFIG_MESSAGE =
  "服务端没有配置访问口令，批改功能暂不可用。请在环境变量里设置 REVIEW_ACCESS_CODE 后重启或重新部署。";

/** 纯粹的口令不对 */
export const ACCESS_DENIED_MESSAGE = "访问口令不正确。请检查后重试。";
