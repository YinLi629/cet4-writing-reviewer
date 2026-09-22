/**
 * 限流状态的存取。
 *
 * 两个实现，都由 `getGate()` 组装出去：
 *
 * - `createPgStore`     —— 真正的方案，状态在 Neon Postgres 里，跨实例共享
 * - `createMemoryStore` —— 进程内 Map。既是自测的测试替身，也是没配 `DATABASE_URL`
 *   时的退路，**还是数据库故障时的降级目标**
 *
 * 外加两个包装（各自只做一件事，可以叠）：
 *
 * - `withFallback`      —— 把"数据库不可用"翻译成"降级到内存实现 + 大声记日志"
 * - `withPeriodicSweep` —— 每约 1000 次早拒顺手清一次陈旧行（无服务器环境没有
 *   后台任务，清理只能搭在流量上）
 *
 * ⚠️ 别和 lib/store.ts 搞混：那个是**浏览器**侧的 localStorage 读写（结果 / 草稿 / 口令），
 * 这个在服务端。名字像纯属巧合。
 *
 * ## 降级为什么不是"放行"
 *
 * 数据库连不上时，直觉做法是直接放行（fail open）。但那样换来的是**零上限**：
 * 数据库一抖，限流整个消失，而这正是最需要它的时候。
 *
 * 更好的降级目标是**退回上一版的内存限流器**——同样不会把用户挡在门外，但至少
 * 在每个实例内部还在计数。代价是内存版在多实例下会漏（这正是当初要改成持久化的
 * 原因），所以降级必须是**响的**：日志要打，`GET /api/review` 的 persistence 要变，
 * 页面上要出现黄条。三条都做了——"限流悄悄变漏"比"限流没配"更危险，
 * 因为前者会给人一种有墙的错觉。
 */

import {
  dbQuery,
  getDatabaseUrl,
  hasDatabase,
  rowNumber,
  DbUnavailableError,
} from "./db";
import {
  clearedFailureState,
  configFromEnv,
  nextFailureState,
  nextWindowState,
  windowResetAfterMs,
  type FailureState,
  type RateLimitPolicy,
} from "./rate-limit";
import {
  buildFailureUpsert,
  buildPeek,
  buildSuccessAndCount,
  buildSweep,
} from "./rate-limit-sql";

/**
 * 陈旧行保留多少个窗口。按窗口长度算，改窗口长度时不用再改一个独立的数字。
 *
 * ⚠️ 它必须**大于锁的总时长封顶**（自测里钉着这条），否则清理会把一把还活着的锁
 * 连行一起删掉：攻击者那边只是发现自己突然又能猜了，而失败计数和封顶的起算点
 * 也一起归零。
 */
export const SWEEP_RETENTION_WINDOWS = 24;

/** 读 body 之前的廉价早拒所需的全部状态 */
export interface GateState {
  /** >0 表示正被锁，值是还要等多少毫秒 */
  lockRetryAfterMs: number;
  /** 当前窗口已用次数（已按窗口翻滚修正：过期的窗口算 0） */
  windowCount: number;
  /** 当前窗口还有多久翻滚 */
  windowResetAfterMs: number;
}

export interface FailureOutcome {
  failCount: number;
  /** >0 表示这次失败把调用方锁上了 */
  lockRetryAfterMs: number;
}

export interface SuccessOutcome {
  windowCount: number;
  windowResetAfterMs: number;
}

export interface RateLimitStore {
  /** 只看状态，不计数。权威判定在下面两条写语句的返回值里，这里只是早拒 */
  peek(key: string): Promise<GateState>;
  /** 记一次口令失败，按新计数选档上锁 */
  recordFailure(key: string): Promise<FailureOutcome>;
  /** 口令正确：清零失败记录 + 计一次批改 */
  recordSuccess(key: string): Promise<SuccessOutcome>;
  /** 机会性清理陈旧行 */
  sweep(): Promise<void>;
}

/** 路由拿到的门控对象。把 policy 一起带出来，路由就不用自己去读环境变量 */
export interface RateLimitGate extends RateLimitStore {
  readonly policy: RateLimitPolicy;
}

// ---------------------------------------------------------------------------
// Postgres 实现
// ---------------------------------------------------------------------------

export function createPgStore(policy: RateLimitPolicy): RateLimitGate {
  const windowSecs = policy.reviewWindowSecs;

  return {
    policy,

    async peek(key: string): Promise<GateState> {
      const stmt = buildPeek(key, windowSecs);
      const rows = await dbQuery(stmt.text, stmt.params);
      const row = rows[0];
      if (!row) return { lockRetryAfterMs: 0, windowCount: 0, windowResetAfterMs: 0 };
      return {
        lockRetryAfterMs: rowNumber(row, "lock_retry_after_secs", 0) * 1000,
        windowCount: rowNumber(row, "window_count", 0),
        windowResetAfterMs: rowNumber(row, "window_reset_after_secs", 0) * 1000,
      };
    },

    async recordFailure(key: string): Promise<FailureOutcome> {
      const stmt = buildFailureUpsert(key);
      const rows = await dbQuery(stmt.text, stmt.params);
      const row = rows[0];
      if (!row) {
        // 写语句没返回行说明发生了完全意料之外的事。宁可当作"没锁上"——
        // 口令校验那条路还在，而且下一次失败会重新计数
        return { failCount: 0, lockRetryAfterMs: 0 };
      }
      return {
        failCount: rowNumber(row, "fail_count", 0),
        lockRetryAfterMs: rowNumber(row, "retry_after_secs", 0) * 1000,
      };
    },

    async recordSuccess(key: string): Promise<SuccessOutcome> {
      const stmt = buildSuccessAndCount(key, windowSecs);
      const rows = await dbQuery(stmt.text, stmt.params);
      const row = rows[0];
      if (!row) return { windowCount: 0, windowResetAfterMs: 0 };
      return {
        windowCount: rowNumber(row, "window_count", 0),
        windowResetAfterMs: rowNumber(row, "reset_after_secs", 0) * 1000,
      };
    },

    async sweep(): Promise<void> {
      const stmt = buildSweep(windowSecs * SWEEP_RETENTION_WINDOWS);
      await dbQuery(stmt.text, stmt.params);
    },
  };
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

interface MemoryEntry {
  failure: FailureState;
  windowStartMs: number;
  windowCount: number;
  updatedAtMs: number;
}

/**
 * 进程内实现。
 *
 * 它和 SQL 版是**两套独立实现**，所以有漂开的风险——`nextFailureState` 那条
 * 语义参照链就是为此存在的：内存版调的是 lib/rate-limit.ts 的纯函数，SQL 版
 * 把同一套规则写成了 CASE。scripts/db-smoke.ts 拿真实数据库跑一遍，就是为了
 * 让这两条路对上。
 */
export function createMemoryStore(
  policy: RateLimitPolicy,
  now: () => number = Date.now,
): RateLimitGate {
  const entries = new Map<string, MemoryEntry>();
  const windowSecs = policy.reviewWindowSecs;

  function entryFor(key: string): MemoryEntry {
    const found = entries.get(key);
    if (found) return found;
    const fresh: MemoryEntry = {
      failure: clearedFailureState(),
      windowStartMs: now(),
      windowCount: 0,
      updatedAtMs: now(),
    };
    entries.set(key, fresh);
    return fresh;
  }

  return {
    policy,

    async peek(key: string): Promise<GateState> {
      const entry = entries.get(key);
      if (!entry) return { lockRetryAfterMs: 0, windowCount: 0, windowResetAfterMs: 0 };

      const t = now();
      const lockedUntil = entry.failure.lockedUntil ?? 0;
      const windowExpired = t - entry.windowStartMs >= windowSecs * 1000;

      return {
        lockRetryAfterMs: lockedUntil > t ? lockedUntil - t : 0,
        windowCount: windowExpired ? 0 : entry.windowCount,
        windowResetAfterMs: windowExpired
          ? 0
          : windowResetAfterMs(entry.windowStartMs, t, windowSecs),
      };
    },

    async recordFailure(key: string): Promise<FailureOutcome> {
      const entry = entryFor(key);
      const t = now();
      entry.failure = nextFailureState(entry.failure, t);
      entry.updatedAtMs = t;

      const lockedUntil = entry.failure.lockedUntil ?? 0;
      return {
        failCount: entry.failure.failCount,
        lockRetryAfterMs: lockedUntil > t ? lockedUntil - t : 0,
      };
    },

    async recordSuccess(key: string): Promise<SuccessOutcome> {
      const entry = entryFor(key);
      const t = now();
      entry.failure = clearedFailureState();

      const next = nextWindowState(entry.windowStartMs, entry.windowCount, t, windowSecs);
      entry.windowStartMs = next.windowStartMs;
      entry.windowCount = next.windowCount;
      entry.updatedAtMs = t;

      return {
        windowCount: entry.windowCount,
        windowResetAfterMs: windowResetAfterMs(entry.windowStartMs, t, windowSecs),
      };
    },

    async sweep(): Promise<void> {
      const t = now();
      const retentionMs = windowSecs * SWEEP_RETENTION_WINDOWS * 1000;
      for (const [key, entry] of entries) {
        // >= 和 SQL 那边的 `updated_at < now() - interval` 对齐（同一时刻算过期）
        if (t - entry.updatedAtMs >= retentionMs) entries.delete(key);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 降级包装
// ---------------------------------------------------------------------------

let lastLoggedAtMs = 0;
let suppressedSinceLastLog = 0;

/** 最近一次数据库故障的时刻。persistenceMode() 靠它把"配了且活着"和"配了但挂了"分开 */
let lastDbProblemAtMs = 0;

/** 每 60 秒最多打一条，中间折叠计数——数据库挂了 + 机器人打，日志会淹掉终端 */
const LOG_INTERVAL_MS = 60_000;

function reportDbProblem(err: unknown): void {
  const t = Date.now();
  // 记在去重**之前**：日志可以折叠，但"现在正降级着"这件事不能被折叠掉——
  // 页面上的提示就是靠它亮起来的
  lastDbProblemAtMs = t;

  if (t - lastLoggedAtMs < LOG_INTERVAL_MS) {
    suppressedSinceLastLog += 1;
    return;
  }

  const detail =
    err instanceof DbUnavailableError
      ? `${err.kind === "timeout" ? "超时" : "错误"}：${err.message}`
      : String(err);
  const folded =
    suppressedSinceLastLog > 0 ? `（自上次告警以来另有 ${suppressedSinceLastLog} 次已折叠）` : "";

  console.error(
    `[rate-limit] ⚠️ 数据库不可用，限流已降级为**单实例内存**实现——` +
      `多实例下这道限制会漏。${detail}${folded}`,
  );

  lastLoggedAtMs = t;
  suppressedSinceLastLog = 0;
}

// ---------------------------------------------------------------------------
// 机会性清理
// ---------------------------------------------------------------------------

/** 每这么多次早拒顺手清一次陈旧行 */
const SWEEP_EVERY_PEEKS = 1000;

/**
 * 每 `SWEEP_EVERY_PEEKS` 次 `peek` 顺带清一次陈旧行。
 *
 * 清理必须搭在**有流量**的地方：无服务器环境没有后台任务和长驻进程，定时器活不过
 * 一次请求。挂在 `peek` 上是因为每个请求都会跑它一次（配额早拒要用），"见过多少
 * 请求"这件事只有它知道。
 *
 * 计数是**每实例**的，所以实例多的时候清得更勤——清理本来就是幂等的，快慢无所谓，
 * 多清几次无害。
 *
 * 清理失败只记日志：它是机会性的，不能因为删不掉旧行就让这次请求失败，更不能变成
 * 一个没人接的 rejection。
 *
 * ⚠️ 这里是 **await** 而不是"发出去不管"，代价是第 1000 次请求会多等这一下
 * （数据库挂着的话，最坏 4 秒超时 + 接下来 peek 自己的 4 秒）。之所以认这个代价：
 * 无服务器环境里不 await 的 promise 有可能在响应发出后就被冻掉，而清理失败是
 * **静默**的——表会一直涨到把库撑爆，然后限流整个消失。一次请求慢一点，
 * 比"清理从来没真正跑过"要好。
 */
function withPeriodicSweep(gate: RateLimitGate): RateLimitGate {
  let peeks = 0;

  return {
    policy: gate.policy,

    async peek(key) {
      peeks += 1;
      if (peeks % SWEEP_EVERY_PEEKS === 0) {
        try {
          await gate.sweep();
        } catch (err) {
          reportDbProblem(err);
        }
      }
      return gate.peek(key);
    },

    recordFailure: (key) => gate.recordFailure(key),
    recordSuccess: (key) => gate.recordSuccess(key),
    sweep: () => gate.sweep(),
  };
}

/**
 * 主实现不可用时落到 `fallback`，并把故障记进日志。
 *
 * 每个方法各自 try/catch，而不是包一层代理：这样"读失败"和"写失败"可以有不同的
 * 兜底语义（比如写失败时返回的那个"没锁上"是安全的，因为口令校验不依赖它）。
 */
export function withFallback(
  primary: RateLimitGate,
  fallback: RateLimitGate,
): RateLimitGate {
  return {
    policy: primary.policy,

    async peek(key) {
      try {
        return await primary.peek(key);
      } catch (err) {
        reportDbProblem(err);
        return fallback.peek(key);
      }
    },

    async recordFailure(key) {
      try {
        return await primary.recordFailure(key);
      } catch (err) {
        reportDbProblem(err);
        return fallback.recordFailure(key);
      }
    },

    async recordSuccess(key) {
      try {
        return await primary.recordSuccess(key);
      } catch (err) {
        reportDbProblem(err);
        return fallback.recordSuccess(key);
      }
    },

    async sweep() {
      try {
        await primary.sweep();
      } catch (err) {
        reportDbProblem(err);
      }
      // fallback 也要扫，而且**不能只在 primary 失败时才扫**。
      //
      // 这里原来只有 primary.sweep()，于是降级期间写进内存 Map 的那些条目
      // 永远没人清：DB 挂着的时候来一波伪造 IP 的洪泛，Map 就是一个假 IP 一条，
      // 只增不减。DB 恢复之后更糟——那时 primary 每次都成功，catch 分支再也进不去，
      // 长驻进程（next start 自托管，不像 serverless 会随实例回收）里这些条目
      // 会一直留到进程重启为止。
      //
      // 内存实现不抛异常，所以直接调；primary 是否失败与此无关。
      await fallback.sweep();
    },
  };
}

// ---------------------------------------------------------------------------
// 生产入口
// ---------------------------------------------------------------------------

let cachedGate: { key: string; gate: RateLimitGate } | null = null;
let warnedMemoryOnly = false;

/**
 * 路由用的门控对象。没有 `DATABASE_URL` 就退回内存实现（本地开发），
 * 并**在第一次调用时大声打一次日志**——页面上那行提示没人保证会被看到。
 */
export function getGate(policy: RateLimitPolicy = configFromEnv()): RateLimitGate {
  const url = getDatabaseUrl();
  const cacheKey = `${url ?? "memory"}|${policy.reviewLimit}|${policy.reviewWindowSecs}`;
  if (cachedGate?.key === cacheKey) return cachedGate.gate;

  const memory = createMemoryStore(policy);
  let gate: RateLimitGate;

  if (url) {
    gate = withFallback(createPgStore(policy), memory);
  } else {
    gate = memory;
    if (!warnedMemoryOnly) {
      warnedMemoryOnly = true;
      console.warn(
        "[rate-limit] 没有配置 DATABASE_URL，限流退化为**单实例内存**实现。" +
          "本地开发无所谓；线上没配的话这道限制在多实例下会漏。",
      );
    }
  }

  // 清理包在最外层，为的是**没有 DATABASE_URL** 那条分支：那时 gate 就是内存
  // 实现，除了这里没人会去扫它。配了 DATABASE_URL 时，那个内存 Map 是
  // withFallback 的 fallback，由 withFallback.sweep() 负责扫。
  // 两层各管各的，不重不漏——曾经这里被读成"外层扫一次就覆盖了两种情况"，
  // 结果 fallback 的 Map 谁也没扫（见 withFallback.sweep 的注释）。
  gate = withPeriodicSweep(gate);

  cachedGate = { key: cacheKey, gate };
  return gate;
}

/**
 * 当前**实际**用的是哪种实现。给 GET /api/review 用（必须是函数，见 db.ts 的注释）。
 *
 * 两种原因都报 `"memory"`，而且必须都报：
 *
 * 1. 没配 `DATABASE_URL` —— 从一开始就是内存实现。
 * 2. **配了，但刚刚还在报错** —— 运行期挂掉了，实际跑的是降级实现。
 *
 * 只判 1 是不够的：那样"库挂了"这件事只存在于服务端日志里，而这个站点的日志
 * 平时没人看。限流悄悄变漏却看不出来，比限流没配更危险——前者给人一种"有墙"的错觉。
 * 最近一次故障在 `LOG_INTERVAL_MS` 之内就算还病着；故障恢复流量之后自然变回
 * `"postgres"`，不需要额外的探活。
 */
export function persistenceMode(): "postgres" | "memory" {
  if (!hasDatabase()) return "memory";
  if (Date.now() - lastDbProblemAtMs < LOG_INTERVAL_MS) return "memory";
  return "postgres";
}
