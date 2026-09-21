/**
 * 限流用的 SQL —— 只负责把语句文本和参数**组装**出来，不碰连接、不发请求。
 *
 * 单独一个模块是为了让 scripts/selftest.ts 能在完全离线的情况下断言这些语句：
 * 档位顺序、参数取值、"两个关注点互不触碰对方的列"这几条性质**只存在于 SQL 文本里**，
 * 用内存假实现去测是测不到的。真正打到数据库的验证在 scripts/db-smoke.ts（手动跑）。
 *
 * ## 为什么全是一条语句，而不是"先查再改"
 *
 * 并发爆破正是要防的场景。读-改-写在并发下会丢更新：N 个请求同时读到 count=6，
 * 各自写回 7，实际发生了 10 次失败却只记了 7 次。所以每个写操作都是一条
 * `INSERT ... ON CONFLICT DO UPDATE`，靠行锁 + EvalPlanQual 串行化：
 * 后到的语句会阻塞在行锁上，然后**针对最新的行版本重新求值整个 SET 子句**。
 *
 * 另一条依赖的性质：`ON CONFLICT DO UPDATE` 的所有 SET 右值读的都是**旧行**（别名 r），
 * 语句内的 `now()` 也固定不变。所以 `r.fail_count + 1` 在多处出现时取的是同一个值——
 * 没有 MySQL 那种"从左到右逐个赋值"的坑。`RETURNING` 读的则是更新后的值。
 *
 * ## 两个关注点共用一行
 *
 * 失败计数和批改窗口在同一张表的同一行上。好处是口令正确那条路能把"清零失败记录"
 * 和"计一次批改"压成**一条**语句（正常请求因此只花一次 SELECT + 一次写）。
 * 代价是正确性**靠"SET 子句里没写那些列"实现**——这是易碎品，所以自测里专门断言
 * 配额语句不触碰失败列、失败语句不触碰窗口列。
 */

import {
  FAIL_DECAY_SECS,
  FAIL_TIER1_COUNT,
  FAIL_TIER1_LOCK_SECS,
  FAIL_TIER2_COUNT,
  FAIL_TIER2_LOCK_SECS,
  LOCK_STREAK_CAP_SECS,
} from "./rate-limit";

export interface SqlStatement {
  text: string;
  params: unknown[];
}

/**
 * "这次失败开新一串"的判定，三个条件任一成立。
 *
 * 它在失败语句里被用了三次（fail_count / lock_started_at / locked_until 各一次），
 * 所以提成一个常量——三处手抄一遍是必然会漂开的写法。这里的拼接是**构建期常量**，
 * 不含任何调用方输入，不构成注入面（所有调用方数据都走 $n 占位符）。
 *
 * 中间那条的第二个括号是必须的：**正被锁着就不算衰减**。少了它，一旦衰减窗口被配得
 * 比锁的总时长还短，攻击者等够衰减时间再失败一次，就能把一把活着的锁顺手清掉。
 */
const RESET_PREDICATE = `(
      r.last_fail_at IS NULL
      OR (r.last_fail_at <= now() - make_interval(secs => $2::double precision)
          AND (r.locked_until IS NULL OR r.locked_until <= now()))
      OR (r.lock_started_at IS NOT NULL
          AND now() >= r.lock_started_at + make_interval(secs => $7::double precision))
    )`;

/**
 * 窗口是否已经过期。
 *
 * 成功语句和早拒语句**共用这一个字符串**（后者写成 `NOT (...)`），不是各抄一份
 * 取反的形式。手抄的话两边只有在边界上才看得出差别——窗口刚翻过去那一瞬间会把
 * 新窗口的第一个请求误杀，而受害者只是"上一分钟刚好用满过"的那一小部分人。
 *
 * 边界约定：`<=` 表示恰好等于窗口长度时**就算过期**。内存实现用的是 `>=`
 * （同一个意思），两边必须一起改，自测里钉着这条。
 *
 * 名字里的 `r` 是表的别名，用它就得把表叫 `r`。
 */
const WINDOW_EXPIRED = `r.window_start <= now() - make_interval(secs => $2::double precision)`;

/**
 * 记一次口令失败：自增失败计数，按新计数选档上锁，并受总时长封顶约束。
 *
 * ⚠️ **两个档位的先后顺序是不变式**：`>= FAIL_TIER2_COUNT`（5 分钟）必须排在
 * `>= FAIL_TIER1_COUNT`（1 分钟）前面。调换之后 `>= 10` 的计数会落进 1 分钟分支，
 * 而且是静默的——自测里有一条断言钉着这个顺序，别删。
 */
export function buildFailureUpsert(key: string): SqlStatement {
  const text = `
    INSERT INTO rate_limits AS r (
      client_key, fail_count, last_fail_at, lock_started_at, locked_until,
      window_start, window_count, updated_at
    )
    VALUES ($1, 1, now(), NULL, NULL, now(), 0, now())
    ON CONFLICT (client_key) DO UPDATE SET
      fail_count = CASE WHEN ${RESET_PREDICATE}
                        THEN 1 ELSE r.fail_count + 1 END,
      last_fail_at = now(),
      lock_started_at = CASE
        WHEN ${RESET_PREDICATE} THEN NULL
        -- ⚠️ 这个分支用**低**档的阈值（$5 = 7），不能用高档的（$3 = 10）。
        -- 起算点要在"这一串锁的第一次上锁"时就记下，也就是第 7 次；写成一档
        -- 才有意义的 >= 10 会让第 7~9 次失败时 lock_started_at 一直是 NULL，
        -- 封顶于是被推迟到第 10 次才开始算——攻击者白拿几分钟。
        -- 上层档（>= 10）是这一档的子集，所以判 >= 7 两档都覆盖得到。
        WHEN r.fail_count + 1 >= $5::int THEN COALESCE(r.lock_started_at, now())
        ELSE r.lock_started_at
      END,
      locked_until = CASE
        WHEN ${RESET_PREDICATE} THEN NULL
        WHEN r.fail_count + 1 >= $3::int
          THEN LEAST(
                 now() + make_interval(secs => $4::double precision),
                 COALESCE(r.lock_started_at, now()) + make_interval(secs => $7::double precision)
               )
        WHEN r.fail_count + 1 >= $5::int
          THEN LEAST(
                 now() + make_interval(secs => $6::double precision),
                 COALESCE(r.lock_started_at, now()) + make_interval(secs => $7::double precision)
               )
        ELSE r.locked_until
      END,
      updated_at = now()
    RETURNING
      fail_count,
      COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (locked_until - now()))), 0)::double precision
        AS retry_after_secs
  `;

  return {
    text,
    params: [
      key,
      FAIL_DECAY_SECS,
      FAIL_TIER2_COUNT,
      FAIL_TIER2_LOCK_SECS,
      FAIL_TIER1_COUNT,
      FAIL_TIER1_LOCK_SECS,
      LOCK_STREAK_CAP_SECS,
    ],
  };
}

/**
 * 口令正确：清零失败记录，同时计一次批改。
 *
 * 两件事共用一条语句，因为它们在同一行上——拆成两条不仅多一次往返，还会让
 * "口令对了但计数没跟上"这种中间态有个可观测的窗口。
 *
 * 不触碰 `window_*` 以外的失败列之外的任何东西；反过来说，它**必须**同时处理
 * 失败列和窗口列，这是设计的一部分。
 */
export function buildSuccessAndCount(key: string, windowSecs: number): SqlStatement {
  return {
    text: `
      INSERT INTO rate_limits AS r (
        client_key, fail_count, last_fail_at, lock_started_at, locked_until,
        window_start, window_count, updated_at
      )
      VALUES ($1, 0, NULL, NULL, NULL, now(), 1, now())
      ON CONFLICT (client_key) DO UPDATE SET
        fail_count = 0,
        last_fail_at = NULL,
        lock_started_at = NULL,
        locked_until = NULL,
        window_count = CASE WHEN ${WINDOW_EXPIRED} THEN 1 ELSE r.window_count + 1 END,
        window_start = CASE WHEN ${WINDOW_EXPIRED} THEN now() ELSE r.window_start END,
        updated_at = now()
      RETURNING
        window_count,
        COALESCE(
          GREATEST(0, EXTRACT(EPOCH FROM (
            window_start + make_interval(secs => $2::double precision) - now()
          ))),
          0
        )::double precision AS reset_after_secs
    `,
    params: [key, windowSecs],
  };
}

/**
 * 读锁定状态 + 当前窗口用量，用于读 body **之前**的廉价早拒。
 *
 * 这只是**建议性的**：权威判定永远是下面两条写语句的 RETURNING。这里多一次查询
 * 换的是"超配额的人连请求体都不用被解析"，正常请求本来就有这一次（以前只查锁）。
 *
 * 窗口翻滚的条件**字面上就是** buildSuccessAndCount 里那一条（写成 `NOT (...)`），
 * 共用同一个常量。各抄一份取反形式的话，两边只有在边界上才分得开——窗口刚翻过去
 * 那一瞬间会把新窗口的第一个请求误杀。
 */
export function buildPeek(key: string, windowSecs: number): SqlStatement {
  return {
    text: `
      SELECT
        COALESCE(GREATEST(0, EXTRACT(EPOCH FROM (r.locked_until - now()))), 0)::double precision
          AS lock_retry_after_secs,
        CASE WHEN NOT (${WINDOW_EXPIRED})
             THEN r.window_count ELSE 0 END AS window_count,
        CASE WHEN NOT (${WINDOW_EXPIRED})
             THEN COALESCE(
                    GREATEST(0, EXTRACT(EPOCH FROM (
                      r.window_start + make_interval(secs => $2::double precision) - now()
                    ))),
                    0
                  )
             ELSE 0 END::double precision AS window_reset_after_secs
      FROM rate_limits AS r
      WHERE r.client_key = $1
    `,
    params: [key, windowSecs],
  };
}

/**
 * 机会性清理。
 *
 * 不清的话每见过一个 IP 就永久留一行，IP 轮换（僵尸网络、IPv6）能把表撑爆；
 * 撑爆之后 Postgres 报错、代码 fail open、限流彻底消失——正是旧实现注释里
 * 点名要防的"限流器自己变成漏洞"。
 */
export function buildSweep(retentionSecs: number): SqlStatement {
  return {
    text: `
      DELETE FROM rate_limits
      WHERE updated_at < now() - make_interval(secs => $1::double precision)
    `,
    params: [retentionSecs],
  };
}
