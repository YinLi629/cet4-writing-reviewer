/**
 * 内存限流：口令防爆破 + 批改频率。
 *
 * ⚠️⚠️ 先读这段，别对它的强度有幻想 ⚠️⚠️
 *
 * 这是**减速带，不是墙**。Vercel 是无服务器架构：每个实例有独立的进程内存，
 * 实例会随时回收、也会横向扩容。所以这里的计数只在「同一个实例内」有效。
 * 攻击者并发打过来，请求会被分散到不同实例，各自的计数互不可见，
 * 实际允许的尝试次数按实例数成倍放大。
 *
 * 真正跨实例限流需要 Redis / Vercel KV / Upstash 这类外部存储——那正好也是
 * 「结果分享」那条线缺的同一块基础设施。在那之前，防线的主力是
 * **口令本身的熵**：够长的随机串，在线爆破在任何速率下都不现实。
 *
 * ⚠️ 第二个前提：key 取自 x-forwarded-for / x-real-ip。
 * 这些头**只有在可信代理后面才可信**。Vercel 会覆写它们，所以线上没问题；
 * 但如果你把服务直接暴露在公网（不经过代理），攻击者可以随便伪造这个头
 * 来给每个请求换一个"新 IP"，限流形同虚设。
 *
 * 结论：它拦得住脚本小子和手滑连点，拦不住有准备的攻击者。这是刻意的取舍——
 * 在没有外部存储之前，加一层廉价的减速带仍比什么都不加好。
 */

export interface LimiterConfig {
  /** 每个窗口允许的批改请求数；<= 0 表示不限 */
  reviewLimit: number;
  reviewWindowMs: number;
  /** 连续失败多少次口令后锁定 */
  maxFailures: number;
  lockoutMs: number;
  /** 口令失败时人为拖慢的毫秒数，拖垮串行爆破 */
  failDelayMs: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** 读取整数环境变量，非法值回落到默认值（配错了不该让服务起不来） */
function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return Math.floor(raw);
}

export function configFromEnv(): LimiterConfig {
  return {
    reviewLimit: envInt("REVIEW_RATE_LIMIT_PER_HOUR", 15, 0),
    reviewWindowMs: HOUR_MS,
    maxFailures: envInt("ACCESS_CODE_MAX_ATTEMPTS", 5, 1),
    lockoutMs: envInt("ACCESS_CODE_LOCKOUT_MS", 15 * 60 * 1000, 0),
    failDelayMs: envInt("ACCESS_CODE_FAIL_DELAY_MS", 400, 0),
  };
}

export interface LimiterVerdict {
  allowed: boolean;
  /** 还要等多少毫秒才能再试；allowed 为 true 时是 0 */
  retryAfterMs: number;
}

interface FailureState {
  count: number;
  lockedUntil: number;
  lastAt: number;
}

/** 触发机会性清理的阈值 */
const SWEEP_AT_SIZE = 2000;
const SWEEP_EVERY_OPS = 200;

/**
 * 工厂：每个实例持有独立的 Map，自测可以建互不干扰的实例。
 */
export function createRateLimiter(config: LimiterConfig = configFromEnv()) {
  const reviewHits = new Map<string, number[]>();
  const failures = new Map<string, FailureState>();
  let ops = 0;

  /**
   * 机会性清理。不清的话，攻击者换 IP 灌请求能把 Map 撑爆内存——
   * 那就成了"限流器自己变成漏洞"。
   */
  function maybeSweep(now: number): void {
    ops += 1;
    const tooBig = reviewHits.size + failures.size >= SWEEP_AT_SIZE;
    if (!tooBig && ops % SWEEP_EVERY_OPS !== 0) return;

    for (const [key, hits] of reviewHits) {
      const alive = hits.filter((t) => now - t < config.reviewWindowMs);
      if (alive.length > 0) reviewHits.set(key, alive);
      else reviewHits.delete(key);
    }
    for (const [key, st] of failures) {
      const idle = now - st.lastAt > config.lockoutMs;
      // 锁定期内不能删，否则锁就没了
      if (idle && st.lockedUntil <= now) failures.delete(key);
    }
  }

  return {
    /** 供路由读取，避免它自己去读环境变量 */
    failDelayMs: config.failDelayMs,
    config,

    /**
     * 批改请求的频率限制。**无论口令对错都先算一次**——否则拿错口令
     * 空刷接口就不受限了。调用即计数，所以只能在真的要处理请求时调。
     */
    checkReview(key: string, now: number = Date.now()): LimiterVerdict {
      maybeSweep(now);
      if (config.reviewLimit <= 0) return { allowed: true, retryAfterMs: 0 };

      const hits = (reviewHits.get(key) ?? []).filter(
        (t) => now - t < config.reviewWindowMs,
      );
      if (hits.length >= config.reviewLimit) {
        const oldest = hits[0] ?? now;
        return {
          allowed: false,
          retryAfterMs: Math.max(0, config.reviewWindowMs - (now - oldest)),
        };
      }
      hits.push(now);
      reviewHits.set(key, hits);
      return { allowed: true, retryAfterMs: 0 };
    },

    /** 只看锁定状态，不计数。放在读 body 之前，被锁的请求连解析都不该触发 */
    lockState(key: string, now: number = Date.now()): LimiterVerdict {
      const st = failures.get(key);
      if (!st || st.lockedUntil <= now) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: st.lockedUntil - now };
    },

    /** 记一次口令失败，到上限就进入锁定 */
    recordFailure(key: string, now: number = Date.now()): void {
      maybeSweep(now);
      const st = failures.get(key) ?? { count: 0, lockedUntil: 0, lastAt: now };
      st.count += 1;
      st.lastAt = now;
      if (st.count >= config.maxFailures) {
        st.lockedUntil = now + config.lockoutMs;
        // 归零：锁定期间不再累加，解锁后重新从 0 数
        st.count = 0;
      }
      failures.set(key, st);
    },

    /** 口令正确：清掉这个 key 的失败记录 */
    recordSuccess(key: string): void {
      failures.delete(key);
    },

    /** 仅供自测观察内部规模，确认清理真的在跑 */
    size(): number {
      return reviewHits.size + failures.size;
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

let shared: RateLimiter | null = null;

/**
 * 进程级共享实例。注意模块级单例在无服务器环境下是「每实例一份」——
 * 这正是上面那段警告的由来。
 */
export function sharedLimiter(): RateLimiter {
  if (!shared) shared = createRateLimiter();
  return shared;
}

/**
 * 取调用方标识。
 *
 * x-forwarded-for 是逗号分隔的链，第一项是最靠近客户端的。取不到就回落到
 * 固定 key —— 这会让所有取不到 IP 的请求共用一个配额，宁可错杀不可放过。
 */
export function clientKeyFrom(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}
