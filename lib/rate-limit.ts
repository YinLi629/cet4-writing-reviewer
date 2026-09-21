/**
 * 限流策略层：口令防爆破 + 批改频率。
 *
 * ⚠️⚠️ 先读这段，它对强度的描述和上一版**完全不同** ⚠️⚠️
 *
 * 上一版是纯内存实现，结论是"减速带，不是墙"——Vercel 上每个实例一份进程内存，
 * 并发请求分散到不同实例、各自独立计数，实际允许的次数按实例数成倍放大。
 *
 * 现在状态存在外部的 Neon Postgres 里（见 lib/rate-limit-store.ts），计数是
 * **跨实例共享**的，所以它是一堵真的墙。但换来了一套新的失效模式，按危险程度排：
 *
 * 1. **key 的可信度全靠平台**。key 取自 x-forwarded-for 的第一项（clientKeyFrom）。
 *    Vercel 会覆写这个头，所以直连部署在 Vercel 上是可信的。但**前面只要再加一层
 *    代理**（Cloudflare、自建反代），第一项就可能是调用方自己写进去的——攻击者可以
 *    给每个请求换一个"新 IP"，整套限流立刻归零。改动这一层之前先读 README 的
 *    「限流的真实边界」。
 * 2. **数据库挂了就只能降级**。降级目标不是"不限"，而是退回上一版的**内存限流器**
 *    （见 rate-limit-store.ts 的 withFallback），但内存版在多实例下是漏的。
 * 3. **按 IP 归并**。同一个出口 IP（校园网、宿舍、公司 NAT）共用配额和锁定，
 *    这是刻意的取舍——理由见 README。
 * 4. **固定窗口不是严格上限**。窗口边界处最坏允许 2 倍突发，所以对外只说
 *    "约 100 次/小时"。
 *
 * 这个模块是**纯函数**：不碰 I/O、不碰 Next.js、不碰数据库。SQL 文本的组装在
 * lib/rate-limit-sql.ts，真正的读写在 lib/rate-limit-store.ts。拆开是为了
 * scripts/selftest.ts 能在完全离线的情况下把策略和 SQL 都验一遍。
 */

export interface RateLimitPolicy {
  /** 每个窗口允许的批改请求数；<= 0 表示不限 */
  reviewLimit: number;
  /** 窗口长度（秒）。固定窗口，不是滑动窗口 */
  reviewWindowSecs: number;
  /** 口令失败时人为拖慢的毫秒数，拖垮串行爆破 */
  failDelayMs: number;
}

export const HOUR_SECS = 60 * 60;

/**
 * 口令失败的档位。
 *
 * 这几个数**刻意不做成环境变量**：它们是规格里定死的值，写死在代码里顺带消灭了
 * "两个环境变量互相矛盾"这一整类问题——比如把衰减窗口配得比锁的总时长还短，
 * 攻击者等一会儿就能自己解锁。自测里有一条断言钉着 `FAIL_DECAY_SECS > LOCK_STREAK_CAP_SECS`。
 */
export const FAIL_TIER1_COUNT = 7;
export const FAIL_TIER1_LOCK_SECS = 60;
export const FAIL_TIER2_COUNT = 10;
export const FAIL_TIER2_LOCK_SECS = 5 * 60;
/**
 * 失败计数的衰减窗口：这么久没有新的失败，就当作从零开始数。
 *
 * 注意它**只在不在锁定期内时**生效（见 isNewStreak）。否则一次失败就能顺手
 * 把一把还活着的锁清掉——锁的时长一旦被调大超过衰减窗口，那个洞就张开了。
 */
export const FAIL_DECAY_SECS = HOUR_SECS;
/**
 * 一把锁从触发那一刻起的总时长上限。
 *
 * 没有它，"到 10 次之后每次再错都锁 5 分钟"就变成一件武器：同一个出口 IP 下
 * 只要有一个人每 5 分钟打错一次，这个 IP 就被无限期锁死，而校园网这种大量人共用
 * 出口的场景下，受害者根本不知道自己是被谁连累的。到顶后自动解锁并清零计数，
 * 重新给 10 次机会——攻击者仍然只能拿到约 10 次猜测/30 分钟。
 */
export const LOCK_STREAK_CAP_SECS = 30 * 60;

/** 读取整数环境变量，非法值回落到默认值（配错了不该让服务起不来） */
function envInt(name: string, fallback: number, min: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return Math.floor(raw);
}

export function configFromEnv(): RateLimitPolicy {
  return {
    reviewLimit: envInt("REVIEW_RATE_LIMIT_PER_HOUR", 100, 0),
    reviewWindowSecs: HOUR_SECS,
    failDelayMs: envInt("ACCESS_CODE_FAIL_DELAY_MS", 400, 0),
  };
}

/**
 * 取调用方标识。
 *
 * x-forwarded-for 是逗号分隔的链，第一项是最靠近客户端的。取不到就回落到
 * 固定 key —— 这会让所有取不到 IP 的请求共用一个配额，宁可错杀不可放过。
 *
 * ⚠️ 这个头只有在可信代理后面才可信。Vercel 会覆写它，所以线上没问题；
 * 但前面再加一层代理就要重新评估——见文件头第 1 条。
 *
 * 注意"取不到就用同一个 unknown 桶"这件事在改成持久化之后变重了：以前每个实例
 * 各有一个 unknown 桶，现在全世界共用一个，100 次/小时和那把锁都是全局的。
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

/** 口令失败的状态。时间都是毫秒时间戳，null 表示"没这回事"。 */
export interface FailureState {
  failCount: number;
  lastFailAt: number | null;
  /** 当前这串锁的起算点，用于总时长封顶 */
  lockStartedAt: number | null;
  lockedUntil: number | null;
}

/**
 * 新的失败次数对应多长的锁；0 表示不锁。
 *
 * ⚠️ 档位的先后顺序是不变式：高次数必须先判。lib/rate-limit-sql.ts 里的 SQL CASE
 * 依赖同一套顺序，自测里有一条断言钉着它。
 */
export function lockSecsFor(failCount: number): number {
  if (failCount >= FAIL_TIER2_COUNT) return FAIL_TIER2_LOCK_SECS;
  if (failCount >= FAIL_TIER1_COUNT) return FAIL_TIER1_LOCK_SECS;
  return 0;
}

/** 当前是否处在锁定期内 */
export function isLocked(state: FailureState, nowMs: number): boolean {
  return state.lockedUntil !== null && state.lockedUntil > nowMs;
}

/**
 * 这次失败是否"开新一串"（即把之前的失败记录整个作废）。
 *
 * 三种情况：从来没失败过 / 距上次失败已过衰减窗口 / 锁的总时长已经用满。
 *
 * 中间的衰减有一条**必须保留的限定**：当前正被锁着就不算衰减。少了这个限定，
 * "衰减窗口比锁还长"这个不变式一旦被破坏，攻击者等够衰减时间再失败一次，
 * 就能把一把活着的锁顺手清掉。自测里同时钉着不变式和这条限定。
 */
export function isNewStreak(state: FailureState, nowMs: number): boolean {
  if (state.lastFailAt === null) return true;

  // 用 >= 是为了和 SQL 里的 `last_fail_at <= now() - interval` 逐字对齐。
  // 两边差一个毫秒不会有人发现，但"参照实现和被测实现边界不一致"会让
  // 自测在边界上给出自相矛盾的结论。
  if (!isLocked(state, nowMs) && nowMs - state.lastFailAt >= FAIL_DECAY_SECS * 1000) {
    return true;
  }

  if (
    state.lockStartedAt !== null &&
    nowMs >= state.lockStartedAt + LOCK_STREAK_CAP_SECS * 1000
  ) {
    return true;
  }

  return false;
}

/**
 * 记一次失败之后的新状态。
 *
 * 这是 SQL 那版的**语义参照实现**：内存 store 直接调它，自测拿它跟数据库的实际
 * 行为对（scripts/db-smoke.ts）。所以这里改了逻辑，那边也会跟着变——好处是两边
 * 不可能悄悄漂开，坏处是 SQL 里的 CASE 必须手动跟上。
 */
export function nextFailureState(state: FailureState, nowMs: number): FailureState {
  const fresh = isNewStreak(state, nowMs);
  const failCount = fresh ? 1 : state.failCount + 1;
  const lockSecs = lockSecsFor(failCount);

  let lockStartedAt = fresh ? null : state.lockStartedAt;
  let lockedUntil = fresh ? null : state.lockedUntil;

  if (lockSecs > 0) {
    // 起算点只在这一串锁的第一次设下，之后一直沿用，封顶才有意义
    const started = lockStartedAt ?? nowMs;
    lockStartedAt = started;
    lockedUntil = Math.min(
      nowMs + lockSecs * 1000,
      started + LOCK_STREAK_CAP_SECS * 1000,
    );
  }

  return { failCount, lastFailAt: nowMs, lockStartedAt, lockedUntil };
}

/** 口令正确：失败记录整个作废 */
export function clearedFailureState(): FailureState {
  return { failCount: 0, lastFailAt: null, lockStartedAt: null, lockedUntil: null };
}

/**
 * 固定窗口的翻滚：窗口过期就从头计，否则加一。
 *
 * 返回的新窗口起点用 nowMs 而不是"上一个窗口的终点"，所以窗口不会因为
 * 抖动而漂移——代价是边界处最坏允许 2 倍突发（见文件头第 4 条）。
 */
export function nextWindowState(
  windowStartMs: number,
  windowCount: number,
  nowMs: number,
  windowSecs: number,
): { windowStartMs: number; windowCount: number } {
  if (nowMs - windowStartMs >= windowSecs * 1000) {
    return { windowStartMs: nowMs, windowCount: 1 };
  }
  return { windowStartMs, windowCount: windowCount + 1 };
}

/** 当前窗口还剩多少毫秒过期 */
export function windowResetAfterMs(
  windowStartMs: number,
  nowMs: number,
  windowSecs: number,
): number {
  return Math.max(0, windowStartMs + windowSecs * 1000 - nowMs);
}

/**
 * 把这次请求算进去之后，用掉的次数会不会超出额度。
 *
 * 放在这一层而不是路由里，是因为它是**策略**（额度的边界怎么算），不是路由；
 * 而且路由引了 next/server，自测加载不了它，留在那儿就等于没测。
 *
 * 两个容易写错的地方，都在这一个函数里解决：
 *
 * - `limit <= 0` 表示**不限**（见 envInt 的 min 参数）。必须单独判：直接写
 *   `count > limit` 会让 0 变成"一律拒绝"，把开关拧成相反的意思。
 * - 用 `>` 而不是 `>=`。参数是**含这次请求在内**的计数：额度 100 时第 100 次请求
 *   让计数变成 100，这一次本身是允许的，第 101 次（计数 101）才拒。
 *
 * ⚠️ 调用方要自己保证"含这次"。两处的来源不同，别抄错：早拒读的是上一次留下的
 * 旧值，这个请求还没被计进去，要手动 +1；权威判定读的是写语句 RETURNING 回来的
 * 新值，它已经把这次算进去了。
 */
export function isOverLimit(limit: number, countIncludingThis: number): boolean {
  if (limit <= 0) return false;
  return countIncludingThis > limit;
}
