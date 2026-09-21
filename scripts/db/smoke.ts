/**
 * 限流 SQL 的冒烟测试。`npm run db:smoke`
 *
 * ⚠️ **需要真实的 DATABASE_URL，会往 rate_limits 表里写东西。永不进 `npm run selftest`。**
 *
 * ## 为什么必须有这个文件
 *
 * `npm run selftest` 是离线的，它能验的只有两件事：纯策略函数，和 SQL **文本**
 * （档位顺序、参数取值、两个关注点互不触碰对方的列）。而 CASE 分支实际走哪一条、
 * `LEAST` 有没有真的夹住、衰减谓词在真库上是什么行为——这些**只存在于数据库的求值
 * 结果里**，文本断言证明不了。没有这一步，等于凭信念上线全仓库最危险的一段 SQL。
 *
 * ## 时间怎么模拟
 *
 * 策略常量是写死的（衰减 1 小时、封顶 30 分钟），不可能真等。所以这里直接
 * `UPDATE ... SET 某列 = now() - make_interval(...)` 把行"做旧"，再跑一次真实的
 * 写语句看它的反应。测的是 SQL 的谓词，不是时钟。
 *
 * 每轮用一个随机 key，跑完删掉，不碰真实数据。
 */

import { randomUUID } from "node:crypto";

import { dbQuery, getDatabaseUrl } from "../../lib/db";
import {
  configFromEnv,
  FAIL_DECAY_SECS,
  FAIL_TIER1_COUNT,
  FAIL_TIER1_LOCK_SECS,
  FAIL_TIER2_COUNT,
  FAIL_TIER2_LOCK_SECS,
  LOCK_STREAK_CAP_SECS,
} from "../../lib/rate-limit";
import { createPgStore } from "../../lib/rate-limit-store";

import { loadDotEnvLocal } from "./env";

// ⚠️ 必须排在最前面，在下面那几个模块级常量之前：configFromEnv() 读的就是环境变量，
// 而 .env.local 里的 REVIEW_RATE_LIMIT_PER_HOUR 会直接改变窗口长度。
// （lib/db.ts 的连接串是调用时才读的，所以那边不受顺序影响。）
loadDotEnvLocal();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail !== undefined) console.log(`      实际: ${JSON.stringify(detail)}`);
  }
}

/** 锁的剩余时长应该约等于这个秒数（容 2 秒，网络和求值都有抖动） */
function nearMs(actual: number, expectedSecs: number): boolean {
  return Math.abs(actual - expectedSecs * 1000) <= 2000;
}

const KEY = `smoke-${randomUUID()}`;
const policy = configFromEnv();
const store = createPgStore(policy);

interface Seed {
  failCount?: number;
  lastFailAgoSecs?: number;
  lockStartedAgoSecs?: number;
  lockedAheadSecs?: number;
  windowCount?: number;
  windowStartAgoSecs?: number;
  updatedAgoSecs?: number;
}

/** 把这个 key 的行造成指定的样子。列名全是字面量，没有注入面 */
async function seed(opts: Seed = {}): Promise<void> {
  await dbQuery(`DELETE FROM rate_limits WHERE client_key = $1`, [KEY]);
  await dbQuery(
    `INSERT INTO rate_limits (
       client_key, fail_count, last_fail_at, lock_started_at, locked_until,
       window_start, window_count, updated_at
     )
     VALUES (
       $1, $2::int,
       CASE WHEN $3::double precision IS NULL THEN NULL
            ELSE now() - make_interval(secs => $3::double precision) END,
       CASE WHEN $4::double precision IS NULL THEN NULL
            ELSE now() - make_interval(secs => $4::double precision) END,
       CASE WHEN $5::double precision IS NULL THEN NULL
            ELSE now() + make_interval(secs => $5::double precision) END,
       now() - make_interval(secs => $6::double precision),
       $7::int,
       now() - make_interval(secs => $8::double precision)
     )`,
    [
      KEY,
      opts.failCount ?? 0,
      opts.lastFailAgoSecs ?? null,
      opts.lockStartedAgoSecs ?? null,
      opts.lockedAheadSecs ?? null,
      opts.windowStartAgoSecs ?? 0,
      opts.windowCount ?? 0,
      opts.updatedAgoSecs ?? 0,
    ],
  );
}

/**
 * ⚠️ 时间列回来的是 **`Date` 对象**，不是字符串。
 *
 * 这不是猜的：拿 `SELECT now()::timestamptz` 探过一遍（`[object Date]`）。
 * 这里原本标的是 `string`，而 `rows[0] as Row` 是个**类型断言**——它把谎话
 * 盖住了，typecheck 完全看不见。后果是一条断言假失败：两个 JSON 出来完全
 * 相同的时刻，`===` 返回 false（对象比的是引用），于是一段正确的 SQL 行为
 * 被报成 bug。日期列一律用下面的 sameInstant() 比，不要用 `===`。
 *
 * 生产代码不受这个影响：`RETURNING` 一律回秒数（`EXTRACT(EPOCH ...)::double
 * precision`），就是为了让路由永远不用碰时间对象——见 lib/rate-limit-sql.ts。
 */
type Row = {
  fail_count: number;
  last_fail_at: Date | null;
  lock_started_at: Date | null;
  locked_until: Date | null;
  window_count: number;
  window_start: Date;
};

/** 两个时刻是不是同一个瞬间。时间列是 `Date`，`===` 比的是引用，不能用 */
function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
}

async function readRow(): Promise<Row | undefined> {
  const rows = await dbQuery(`SELECT * FROM rate_limits WHERE client_key = $1`, [KEY]);
  return rows[0] as Row | undefined;
}

async function run(): Promise<void> {
  console.log(`限流 SQL 冒烟测试，key = ${KEY}\n`);

  // ---- 1. 档位：7 次锁 1 分钟，10 次锁 5 分钟 -----------------------------
  console.log("[1] 口令失败的档位");
  await seed();

  let last = { failCount: 0, lockRetryAfterMs: 0 };
  for (let i = 1; i <= FAIL_TIER1_COUNT; i += 1) {
    last = await store.recordFailure(KEY);
  }
  check(
    `第 ${FAIL_TIER1_COUNT} 次失败：计数到 ${FAIL_TIER1_COUNT}，锁 ${FAIL_TIER1_LOCK_SECS} 秒`,
    last.failCount === FAIL_TIER1_COUNT && nearMs(last.lockRetryAfterMs, FAIL_TIER1_LOCK_SECS),
    last,
  );

  // ⚠️ 这一条必须读**原始行**才验得到，RETURNING 里没有 lock_started_at。
  // 照 RETURNING 写断言的话正好漏掉它——这里曾经真的错过一次：起算点被写成
  // 只在 >= 10 时才记，于是第 7~9 次失败期间它一直是 NULL，封顶被推迟到第 10 次
  // 才开始算，攻击者白拿几分钟。
  const startedAfter7 = (await readRow())?.lock_started_at ?? null;
  check("第 7 次失败：记下了这把锁的起算点（封顶从这一刻算）", startedAfter7 !== null, startedAfter7);

  last = await store.recordFailure(KEY); // 第 8 次
  check(
    `第 ${FAIL_TIER1_COUNT + 1} 次失败：还在 1 分钟档`,
    last.failCount === FAIL_TIER1_COUNT + 1 && nearMs(last.lockRetryAfterMs, FAIL_TIER1_LOCK_SECS),
    last,
  );

  last = await store.recordFailure(KEY); // 第 9 次
  check(`第 ${FAIL_TIER2_COUNT - 1} 次失败：仍在 1 分钟档`, nearMs(last.lockRetryAfterMs, FAIL_TIER1_LOCK_SECS), last);

  last = await store.recordFailure(KEY); // 第 10 次
  check(
    `第 ${FAIL_TIER2_COUNT} 次失败：升到 ${FAIL_TIER2_LOCK_SECS} 秒档`,
    last.failCount === FAIL_TIER2_COUNT && nearMs(last.lockRetryAfterMs, FAIL_TIER2_LOCK_SECS),
    last,
  );
  const startedAfter10 = (await readRow())?.lock_started_at ?? null;
  check(
    "第 10 次失败：起算点沿用而不是重置（重置的话封顶会被无限推迟）",
    sameInstant(startedAfter10, startedAfter7),
    { after7: startedAfter7, after10: startedAfter10 },
  );

  last = await store.recordFailure(KEY); // 第 11 次
  check(
    `第 ${FAIL_TIER2_COUNT + 1} 次失败：仍是 ${FAIL_TIER2_LOCK_SECS} 秒档（不是回落到 1 分钟）`,
    nearMs(last.lockRetryAfterMs, FAIL_TIER2_LOCK_SECS),
    last,
  );

  // ---- 2. 口令正确：清零失败记录，且计一次批改 ----------------------------
  console.log("\n[2] 口令正确");
  await seed({ failCount: 9, lockedAheadSecs: 300, lockStartedAgoSecs: 10, windowCount: 3 });

  const ok = await store.recordSuccess(KEY);
  const afterSuccess = await readRow();
  check(
    "失败记录被清零（计数、时间、锁都清掉）",
    afterSuccess?.fail_count === 0 &&
      afterSuccess?.last_fail_at === null &&
      afterSuccess?.locked_until === null,
    afterSuccess,
  );
  check("同一次调用里批改次数加了一（3 → 4）", ok.windowCount === 4, ok);

  // ---- 3. 两个关注点互不干扰 ---------------------------------------------
  console.log("\n[3] 失败与窗口互不触碰对方的列");
  await store.recordFailure(KEY);
  const afterFailure = await readRow();
  check(
    "记一次失败**不会**改动窗口计数",
    afterFailure?.window_count === 4,
    { window_count: afterFailure?.window_count },
  );

  // 权威判定用的是写语句返回的值，不是 peek 的旧值
  const overLimit = await store.recordSuccess(KEY);
  check("窗口计数继续单调递增（4 → 5）", overLimit.windowCount === 5, overLimit);

  // ---- 4. 窗口翻滚 --------------------------------------------------------
  console.log("\n[4] 固定窗口翻滚");
  await seed({ windowCount: 99, windowStartAgoSecs: policy.reviewWindowSecs + 5 });
  const rolled = await store.recordSuccess(KEY);
  check("窗口过期后从 1 重新计，而不是接着 99 往上走", rolled.windowCount === 1, rolled);

  await seed({ windowCount: 99, windowStartAgoSecs: policy.reviewWindowSecs + 5 });
  const peeked = await store.peek(KEY);
  check(
    "peek 也会按翻滚修正：过期窗口报 0，不误杀新窗口的第一个请求",
    peeked.windowCount === 0,
    peeked,
  );

  // ---- 5. 衰减 ------------------------------------------------------------
  console.log("\n[5] 失败计数的衰减");
  await seed({ failCount: 6, lastFailAgoSecs: FAIL_DECAY_SECS + 10 });
  last = await store.recordFailure(KEY);
  check(
    `距上次失败超过 ${FAIL_DECAY_SECS} 秒后，计数从 1 重来（不是 7）`,
    last.failCount === 1,
    last,
  );

  // 这条是"锁定期内不衰减"的守卫：衰减窗口再久也不能把一把活着的锁清掉
  await seed({
    failCount: 9,
    lastFailAgoSecs: FAIL_DECAY_SECS + 10,
    lockStartedAgoSecs: 5,
    lockedAheadSecs: 55,
  });
  last = await store.recordFailure(KEY);
  check(
    "锁定期内**不**衰减：计数继续涨到 10 并续上 5 分钟锁",
    last.failCount === FAIL_TIER2_COUNT && nearMs(last.lockRetryAfterMs, FAIL_TIER2_LOCK_SECS),
    last,
  );

  // ---- 6. 总锁时长封顶 ----------------------------------------------------
  console.log("\n[6] 锁的总时长封顶");
  await seed({
    failCount: 11,
    lastFailAgoSecs: 5,
    lockStartedAgoSecs: LOCK_STREAK_CAP_SECS + 10,
    lockedAheadSecs: 60,
  });
  last = await store.recordFailure(KEY);
  check(
    `封顶用满后自动解锁并清零（计数回到 1，不再锁）`,
    last.failCount === 1 && last.lockRetryAfterMs === 0,
    last,
  );

  // LEAST() 有没有真的夹住：剩下的封顶时间比这一档的锁还短
  await seed({
    failCount: 9,
    lastFailAgoSecs: 5,
    lockStartedAgoSecs: LOCK_STREAK_CAP_SECS - 20,
    lockedAheadSecs: 1000,
  });
  last = await store.recordFailure(KEY);
  check(
    "新锁被封顶夹短（约 20 秒，而不是整档 5 分钟）",
    last.lockRetryAfterMs > 0 && last.lockRetryAfterMs <= 21_000,
    { lockRetryAfterMs: last.lockRetryAfterMs },
  );

  // ---- 7. 清理 ------------------------------------------------------------
  console.log("\n[7] 陈旧行清理");
  await seed({ failCount: 0, updatedAgoSecs: policy.reviewWindowSecs * 24 + 60 });
  await store.sweep();
  check("超过保留期的行被删掉", (await readRow()) === undefined);

  // ---- 收尾 --------------------------------------------------------------
  await dbQuery(`DELETE FROM rate_limits WHERE client_key = $1`, [KEY]);

  console.log(`\n${"=".repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log("=".repeat(46));
  if (failed > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  if (!getDatabaseUrl()) {
    console.error(
      "没有可用的 DATABASE_URL（.env.local 里也没找到），无法跑冒烟测试。\n" +
        "这个脚本必须打真实数据库——它验的正是纯文本断言证明不了的那部分。",
    );
    process.exitCode = 1;
    return;
  }
  await run();
}

main().catch((err) => {
  console.error("冒烟测试自己出错了：", err);
  process.exitCode = 1;
});
