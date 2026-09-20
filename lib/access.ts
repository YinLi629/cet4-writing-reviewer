/**
 * 访问口令。
 *
 * 站点公开部署后，POST /api/review 烧的是站长自己的模型额度，任何人都能调。
 * 所以加一道共享口令：拿到口令才能批改。
 *
 * 校验刻意放在路由层（HTTP 边界），不放进 lib/review.ts 的批改逻辑里。
 * 两个原因：批改领域层不该知道鉴权这回事；而 scripts/selftest.ts 的端到端
 * 用例是直接调 reviewEssay() 的，把校验塞进去会把那些用例全带崩。
 *
 * 这个模块是纯函数式的，不碰 Next.js，所以自测里可以直接测。
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * .env.local.example 里的占位值。它非空，会被"配了口令"的检查放过，
 * 结果就是口令形同虚设——和 DEEPSEEK_API_KEY 的 sk-xxxx 是同一类坑。
 */
const PLACEHOLDER_CODE = /^change-me(-please)?$/i;

/**
 * 取服务端配置的口令。空值或占位值一律视为"没配"。
 *
 * 注意"没配"的后果是拒绝一切请求（见 verifyAccessCode），不是放行——
 * 公开站点上，忘了配口令而静默裸奔的代价太大了。
 */
export function getAccessCode(): string | undefined {
  const code = process.env.REVIEW_ACCESS_CODE?.trim();
  if (!code || PLACEHOLDER_CODE.test(code)) return undefined;
  return code;
}

export function hasAccessCode(): boolean {
  return getAccessCode() !== undefined;
}

export type AccessVerdict =
  | { ok: true }
  | { ok: false; reason: "MISSING_CONFIG" | "INVALID" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * 校验调用方传来的口令。
 *
 * 用 timingSafeEqual 而不是 `===`，避免通过响应耗时逐字节试出口令。
 * 但 timingSafeEqual 在两侧长度不等时直接抛错，所以先各自摘要成定长再比，
 * 顺带也不泄露真实口令的长度。
 *
 * provided 不是字符串（undefined / 数字 / 对象）时一律判 INVALID，
 * 不做隐式转换——`String(undefined)` 这种宽容会带来意想不到的放行。
 */
export function verifyAccessCode(provided: unknown): AccessVerdict {
  const expected = getAccessCode();
  if (!expected) return { ok: false, reason: "MISSING_CONFIG" };
  if (typeof provided !== "string") return { ok: false, reason: "INVALID" };

  return timingSafeEqual(digest(provided), digest(expected))
    ? { ok: true }
    : { ok: false, reason: "INVALID" };
}
