/**
 * 路由级端到端走查。`npm run db:walkthrough`
 *
 * ⚠️ **需要 `npm run dev` 已经在 :3000 跑着，会往 rate_limits 里写东西。永不进 `npm run selftest`。**
 *
 * ## 为什么还需要它
 *
 * 三层测试各管一段，谁也不能替谁：
 *
 * - `npm run selftest`  —— 纯策略函数 + SQL **文本**（离线）
 * - `npm run db:smoke`  —— 真实库上的 SQL 行为（只碰 store，不碰 HTTP）
 * - `npm run db:walkthrough` —— **这一层**：路由怎么把 store 的结果翻译成
 *   401 / 429 / `Retry-After`，以及只有打真实 HTTP 才看得见的几条规则
 *
 * 具体是这几条（都属于"改了别的地方会静默坏掉、而前两层测不到"的）：
 *
 * 1. **失败刚好把人锁上时返回 429 而不是 401** —— 文案换成"已锁定，请 X 后再试"。
 *    所以不能只看状态码断言"错口令是 401"。
 * 2. **锁定期内的请求在读 body 之前就被拒**，于是**不计数**——被拒的爆破尝试
 *    不会把计数推上去。
 * 3. **硬锁**：口令正确也穿不透锁定。
 * 4. **锁过期不清零**，计数从 7 继续涨到 8。
 * 5. **第 100 次放行、第 101 次 429**（`isOverLimit` 用的是 `>` 不是 `>=`）。
 * 6. **400 也消耗配额**——这条是已知副作用，写进 README 了，这里钉着。
 * 7. **口令页（`/api/access`）和批改走的是同一条防爆破路径**：错口令一样记失败、
 *    一样按档位上锁（所以它不是绕过锁定的旁路），但**不占**那 100 次批改额度、
 *    也不清零失败计数（所以它也不是绕过配额的旁路）。这三条只能打真实 HTTP 才看得见。
 *
 * ## 怎么做到"不真调模型"
 *
 * 配额那几段用**短作文**穿过闸门：口令对 + 作文不足 MIN_ESSAY_CHARS(20) 字符 →
 * `normalizeInput` 抛 INVALID_INPUT → 400。但配额**已经计过了**（route.ts 的 ④
 * 在派发之前），所以既验到了要验的东西，又一分钱不花。
 *
 * ## 为什么是本机专用
 *
 * 它靠 `client_key = "::1"`（Next dev 把回环请求的 x-forwarded-for 填成这个）
 * 去核对库里的行。跑在 Vercel 上那个 key 会是你的真实出口 IP，这些断言全部落空——
 * 线上验证请用 README「部署后验证」里那几条 curl + Neon 控制台查询。
 */

import {
  configFromEnv,
  FAIL_TIER1_COUNT,
  FAIL_TIER1_LOCK_SECS,
  FAIL_TIER2_COUNT,
  FAIL_TIER2_LOCK_SECS,
} from "../../lib/rate-limit";
import { dbQuery } from "../../lib/db";

import { loadDotEnvLocal } from "./env";

// ⚠️ 必须排在最前面：口令是从 .env.local 读的，而下面几个模块级常量会用到它
loadDotEnvLocal();

const BASE = process.env.WALKTHROUGH_BASE ?? "http://localhost:3000/api/review";

/**
 * 口令页那条路由。[8] 用它验"口令页不是绕过锁定/配额的旁路"。
 * 从 BASE 推出来是为了让 `WALKTHROUGH_BASE` 一改就跟着走；只有 BASE 不以
 * `/review` 结尾时它才退化成 BASE 本身（那时这几条断言会红，正好提醒改这里）。
 */
const ACCESS_BASE = BASE.replace(/\/review$/, "/access");

/** 本机回环的 client_key。见文件头"为什么是本机专用" */
const KEY = "::1";

const CODE = process.env.REVIEW_ACCESS_CODE;
const SHORT_ESSAY = "x"; // < MIN_ESSAY_CHARS(20)，必然 400，不会调模型

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

interface Reply {
  status: number;
  retryAfter: string | null;
  body: { error?: string; code?: string } | null;
}

async function postTo(url: string, payload: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: Reply["body"] = null;
  try {
    body = (await res.json()) as Reply["body"];
  } catch {
    // 非 JSON 就别管了，断言看状态码
  }
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
}

const post = (payload: Record<string, unknown>) => postTo(BASE, payload);

/**
 * 口令页的 POST。**没有 essay 字段**——这条路由根本不看作文，这正是它能
 * "免费验口令"的原因，也是[8]要钉住的东西。
 */
const postAccess = (accessCode: string) => postTo(ACCESS_BASE, { accessCode });

/**
 * 口令。`?? ""` 是给类型检查看的：`main()` 里已经挡掉了"没配口令"的情况，
 * 走不到这儿（真走到这儿，空口令也只会拿到 401，不会假装通过）。
 */
const THE_CODE = CODE ?? "";

const wrong = (n: number) => post({ accessCode: `deliberately-wrong-${n}`, essay: SHORT_ESSAY });
const right = () => post({ accessCode: CODE, essay: SHORT_ESSAY });

/**
 * ⚠️ 时间列回来的是 `Date` 对象，不是字符串（同 scripts/db/smoke.ts 的说明）。
 * 类型断言 `as Row` 会把谎话盖住，所以这里照实写。
 */
// 必须写成 type 别名而不是 interface：interface 没有隐式索引签名，于是
// `rows[0] as Row` 会因为"两个类型不重叠"被 TS 拒掉（TS2352）。smoke.ts 里
// 同样的断言能过，靠的正是这一点。
type Row = {
  fail_count: number;
  last_fail_at: Date | null;
  lock_started_at: Date | null;
  locked_until: Date | null;
  window_count: number;
};

async function row(): Promise<Row | undefined> {
  const rows = await dbQuery(`SELECT * FROM rate_limits WHERE client_key = $1`, [KEY]);
  return rows[0] as Row | undefined;
}

async function clean(): Promise<void> {
  await dbQuery(`DELETE FROM rate_limits WHERE client_key = $1`, [KEY]);
}

/**
 * 直接改库来跳过没意义的等待（比如"再错两次"），只盯要验的那一步。
 * `last_fail_at = now()` 是必须的：否则衰减会把计数当成"新的一串"重置掉。
 */
async function seedCounts(failCount: number, windowCount: number): Promise<void> {
  await dbQuery(
    `UPDATE rate_limits
        SET fail_count = $2::int,
            last_fail_at = now(),
            locked_until = now() - make_interval(secs => 1),
            window_count = $3::int,
            window_start = now()
      WHERE client_key = $1`,
    [KEY, failCount, windowCount],
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry-After 头对不对（容 2 秒，网络和求值都有抖动） */
function nearSecs(retryAfter: string | null, expected: number): boolean {
  return retryAfter !== null && Math.abs(Number(retryAfter) - expected) <= 2;
}

async function run(): Promise<void> {
  console.log(`路由走查 → ${BASE}\n`);
  await clean();

  // ---- 1. 连错 6 次：还没到档，不该锁 -----------------------------------
  console.log(`[1] 连错 ${FAIL_TIER1_COUNT - 1} 次`);
  for (let i = 1; i <= FAIL_TIER1_COUNT - 1; i += 1) {
    const r = await wrong(i);
    if (i === FAIL_TIER1_COUNT - 1) {
      check(
        `第 ${FAIL_TIER1_COUNT - 1} 次仍是 401 INVALID_ACCESS_CODE（还没到档，不锁）`,
        r.status === 401 && r.body?.code === "INVALID_ACCESS_CODE" && r.retryAfter === null,
        { status: r.status, code: r.body?.code, retryAfter: r.retryAfter },
      );
    }
  }
  let cur = await row();
  check(
    `失败计数到 ${FAIL_TIER1_COUNT - 1}，未上锁`,
    cur?.fail_count === FAIL_TIER1_COUNT - 1 && cur?.locked_until === null,
    { fail_count: cur?.fail_count, locked_until: cur?.locked_until },
  );
  check(
    "连错这些次**没有**占用批改额度（window_count 仍为 0）",
    cur?.window_count === 0,
    { window_count: cur?.window_count },
  );

  // ---- 2. 第 7 次：锁 1 分钟 --------------------------------------------
  console.log(`\n[2] 第 ${FAIL_TIER1_COUNT} 次失败`);
  // 记下发起这一刻的时间。下面那条"到期时间约在 N 秒后"必须拿它当基准，
  // 而不是断言时的 Date.now()——后者把"这次请求 + 一次 row() 查询 + 断言之间
  // 耗掉的时间"也算进去了，本机第一次连库偏慢时会假红（实测过一次：
  // 26 项里唯一的一条红，重跑就绿）。基准取发请求前，误差就只剩请求本身
  const atSeventhFailure = Date.now();
  const seventh = await wrong(FAIL_TIER1_COUNT);
  // "这一次失败刚好把人锁上"时路由返回 429 而不是 401（route.ts 的注释：否则用户
  // 只看到"口令不正确"，再试一次才被告知被锁）。文案因此和配额的 429 不同。
  check(
    `第 ${FAIL_TIER1_COUNT} 次：429（这一次刚好锁上，所以不是 401）`,
    seventh.status === 429 && seventh.body?.code === "RATE_LIMITED",
    { status: seventh.status, code: seventh.body?.code },
  );
  check(
    `Retry-After 约 ${FAIL_TIER1_LOCK_SECS} 秒`,
    nearSecs(seventh.retryAfter, FAIL_TIER1_LOCK_SECS),
    { retryAfter: seventh.retryAfter },
  );
  check(
    "文案是「已锁定」+「1 分钟」，不是笼统的『口令不正确』",
    /已锁定/.test(seventh.body?.error ?? "") && /1 分钟/.test(seventh.body?.error ?? ""),
    { error: seventh.body?.error },
  );
  cur = await row();
  check("库里记下了起算点（封顶从这一刻算）", cur?.lock_started_at !== null, cur?.lock_started_at);
  // 基准是"发请求前那一刻"，所以这里的容差只需要覆盖这一次请求自己的耗时
  // （HTTP + 库里的 now() + 人工失败延迟），5 秒很宽松了。
  // 这条断言真正要抓的错是"锁写成了别的档位"（1 分钟 vs 5 分钟）或"没写"，
  // 都远不止 5 秒的偏差
  const lockRemainingMs = cur?.locked_until
    ? cur.locked_until.getTime() - atSeventhFailure
    : Number.NaN;
  check(
    `锁定到期时间约在 ${FAIL_TIER1_LOCK_SECS} 秒后`,
    Math.abs(lockRemainingMs - FAIL_TIER1_LOCK_SECS * 1000) < 5000,
    { locked_until: cur?.locked_until, 距发起: `${Math.round(lockRemainingMs / 1000)} 秒` },
  );

  // ---- 3. 锁定期内：硬锁，口令正确也进不去 ------------------------------
  console.log("\n[3] 锁定期内");
  const okDuringLock = await right();
  check(
    "【硬锁】口令**正确**也拿到 429，不能穿透锁定",
    okDuringLock.status === 429 && okDuringLock.body?.code === "RATE_LIMITED",
    { status: okDuringLock.status, code: okDuringLock.body?.code },
  );
  check(
    "锁定期内的 429 也带 Retry-After",
    nearSecs(okDuringLock.retryAfter, FAIL_TIER1_LOCK_SECS),
    { retryAfter: okDuringLock.retryAfter },
  );

  const wrongDuringLock = await wrong(FAIL_TIER1_COUNT + 1);
  check(
    "锁定期内再输错 → 429（早拒在读 body 之前，不计数）",
    wrongDuringLock.status === 429,
    { status: wrongDuringLock.status },
  );
  cur = await row();
  check(
    `失败计数**没有**因为被拒的请求而增长（仍是 ${FAIL_TIER1_COUNT}）`,
    cur?.fail_count === FAIL_TIER1_COUNT,
    { fail_count: cur?.fail_count },
  );

  // ---- 4. 真等一个锁周期：锁自然过期，且计数不清零 -----------------------
  const waitSecs = FAIL_TIER1_LOCK_SECS + 2;
  console.log(`\n[4] 真等 ${waitSecs} 秒，看锁自然过期`);
  process.stdout.write("  （等待中）");
  await sleep(waitSecs * 1000);
  console.log(" 到了");
  const afterExpiry = await wrong(FAIL_TIER1_COUNT + 2);
  cur = await row();
  // ⚠️ 这里**不能只看状态码**：早拒（还在锁里）和"受理了这次失败并重新上锁"都是 429。
  // 区分二者的唯一证据在库里——计数涨了，说明这次真的被受理并计上了。
  check(
    `锁确实自然过期了：这一次被受理并计上（计数 ${FAIL_TIER1_COUNT} → ${FAIL_TIER1_COUNT + 1}，不是回到 1）`,
    cur?.fail_count === FAIL_TIER1_COUNT + 1,
    { fail_count: cur?.fail_count },
  );
  check(
    `第 ${FAIL_TIER1_COUNT + 1} 次失败重新上锁：429 + Retry-After 约 ${FAIL_TIER1_LOCK_SECS} 秒（仍在低档）`,
    afterExpiry.status === 429 && nearSecs(afterExpiry.retryAfter, FAIL_TIER1_LOCK_SECS),
    { status: afterExpiry.status, retryAfter: afterExpiry.retryAfter },
  );

  // ---- 5. 第 10 次：升到 5 分钟档 ---------------------------------------
  console.log(
    `\n[5] 第 ${FAIL_TIER2_COUNT} 次失败（直接改库跳过中间那几次等待——档位本身已由 db:smoke 逐档验过）`,
  );
  await seedCounts(FAIL_TIER2_COUNT - 1, cur?.window_count ?? 0);
  const tenth = await wrong(FAIL_TIER2_COUNT);
  check(
    `第 ${FAIL_TIER2_COUNT} 次：429 + Retry-After 约 ${FAIL_TIER2_LOCK_SECS} 秒`,
    tenth.status === 429 && nearSecs(tenth.retryAfter, FAIL_TIER2_LOCK_SECS),
    { status: tenth.status, retryAfter: tenth.retryAfter },
  );
  check(
    "文案是「已锁定」+「5 分钟」（升到高档，不是还停在 1 分钟）",
    /已锁定/.test(tenth.body?.error ?? "") && /5 分钟/.test(tenth.body?.error ?? ""),
    { error: tenth.body?.error },
  );
  cur = await row();
  check(
    "升档了但起算点沿用（封顶没被推迟）",
    cur?.fail_count === FAIL_TIER2_COUNT && cur?.lock_started_at !== null,
    { fail_count: cur?.fail_count, lock_started_at: cur?.lock_started_at },
  );

  // ---- 6. 口令正确：清零失败 + 计一次批改 -------------------------------
  console.log("\n[6] 口令正确");
  await seedCounts(cur?.fail_count ?? 0, cur?.window_count ?? 0);
  const before = (await row())?.window_count ?? 0;
  const okReq = await right();
  check(
    "短作文 → 400 INVALID_INPUT（没调模型）",
    okReq.status === 400 && okReq.body?.code === "INVALID_INPUT",
    { status: okReq.status, code: okReq.body?.code },
  );
  cur = await row();
  check(
    "失败记录被整个清零（计数/时间/锁）",
    cur?.fail_count === 0 &&
      cur?.last_fail_at === null &&
      cur?.locked_until === null &&
      cur?.lock_started_at === null,
    cur,
  );
  check(
    "【已知副作用】这一次 400 已经计进配额了（window_count +1）",
    cur?.window_count === before + 1,
    { before, after: cur?.window_count },
  );

  // ---- 7. 配额边界：第 100 次放行，第 101 次 429 -------------------------
  const limit = configFromEnv().reviewLimit;
  console.log(`\n[7] 每小时 ${limit} 次的边界`);
  await seedCounts(0, limit - 1);
  const last = await right();
  check(
    `第 ${limit} 次照常处理（400，说明这条线本身是被允许的）`,
    last.status === 400,
    { status: last.status },
  );
  cur = await row();
  check(`计数走到 ${limit}`, cur?.window_count === limit, { window_count: cur?.window_count });

  const over = await right();
  check(
    `第 ${limit + 1} 次：429 + Retry-After`,
    over.status === 429 && over.retryAfter !== null,
    { status: over.status, retryAfter: over.retryAfter },
  );
  check(
    "文案说的是「太频繁」（和锁定的 429 不是同一条）",
    /太频繁/.test(over.body?.error ?? ""),
    { error: over.body?.error },
  );
  cur = await row();
  check(
    `被拒的那次没有把计数推上去（仍是 ${limit}）`,
    cur?.window_count === limit,
    { window_count: cur?.window_count },
  );

  // ---- 8. 口令页：同一条防爆破路径，但不占额度 ---------------------------
  // 这一段的每一条都是"走偏了就会让口令页变成旁路"的地方：
  // 不记失败 / 不清零失败 → 它成了绕过锁定的旁路；记了额度 → 它成了绕过配额的旁路。
  console.log("\n[8] 口令页的校验接口");
  await seedCounts(0, 0);
  const gateBefore = await row();

  const gateWrong = await postAccess("deliberately-wrong-gate");
  check(
    "错口令 → 401 INVALID_ACCESS_CODE（和批改页同一个码）",
    gateWrong.status === 401 && gateWrong.body?.code === "INVALID_ACCESS_CODE",
    { status: gateWrong.status, code: gateWrong.body?.code },
  );
  cur = await row();
  check(
    "失败是**记下来的**（口令页不是防爆破的缺口）",
    cur?.fail_count === 1,
    { fail_count: cur?.fail_count },
  );

  const gateOk = await postAccess(THE_CODE);
  check("口令正确 → 200", gateOk.status === 200, { status: gateOk.status });
  cur = await row();
  // 这条是本段的重点：它钉住 lib/access-gate.ts 头注释里那句"不做配额早拒"
  check(
    "**不占批改额度**：window_count 一动不动（验口令不该花站长的钱）",
    cur?.window_count === (gateBefore?.window_count ?? 0),
    { before: gateBefore?.window_count, after: cur?.window_count },
  );
  check(
    "也**不清零**失败计数（刻意的取舍，见那条路由的头注释）",
    cur?.fail_count === 1,
    { fail_count: cur?.fail_count },
  );

  // 锁定档位在口令页同样生效——否则爆破的人从这里进就绕开了 [2]/[3] 验过的锁
  await seedCounts(FAIL_TIER1_COUNT - 1, 0);
  const gateSeventh = await postAccess("deliberately-wrong-gate-7");
  check(
    `第 ${FAIL_TIER1_COUNT} 次错口令在口令页同样锁上（429，不是 401）`,
    gateSeventh.status === 429 && gateSeventh.body?.code === "RATE_LIMITED",
    { status: gateSeventh.status, code: gateSeventh.body?.code },
  );
  const gateLocked = await postAccess(THE_CODE);
  check(
    "【硬锁】锁定期内口令**正确**也进不去（同一条锁）",
    gateLocked.status === 429,
    { status: gateLocked.status },
  );
  check(
    "锁定时同样带 Retry-After",
    nearSecs(gateLocked.retryAfter, FAIL_TIER1_LOCK_SECS),
    { retryAfter: gateLocked.retryAfter },
  );

  // ---- 收尾 --------------------------------------------------------------
  await clean();
  const left = await dbQuery(`SELECT count(*)::int AS n FROM rate_limits`, []);
  check("走查产生的行已清干净", left[0]?.n === 0, { rows: left[0]?.n });

  console.log(`\n${"=".repeat(46)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log("=".repeat(46));
  if (failed > 0) process.exitCode = 1;
}

/**
 * 先把数据库焐热，再开始断言。
 *
 * ⚠️ 冷启动的 Neon 连接第一次用要建连，实测能越过 lib/db.ts 那个 4 秒超时。撞上的
 * 那一次请求会被判成"数据库不可用"而**降级到内存实现**——限流那一刻是真的漏了，
 * 而脚本这边看到的是一串莫名其妙的红：第 7 次失败没锁上、库里的计数停在 6、
 * 锁定期穿透失败……全都指向"策略坏了"，实际只是那一次查询慢了。踩过两次，
 * 两次都是**刚重启 dev server 之后的第一轮**。
 *
 * 只预热、不掩盖：真降级了照样会红——下面每一轮都读库核对，内存里记的账对不上。
 * 需要快速往返（而不是"能连上就行"），因为临界的是超时那条线：日志里第一次
 * POST 用了 3.7 秒，离 4 秒只差一点。
 */
async function warmUpDb(): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    const startedAt = Date.now();
    try {
      await dbQuery(`SELECT 1`, []);
      // 1 秒是个保守的门槛：真请求还要再读写一次，留出余量
      if (Date.now() - startedAt < 1000) {
        if (i > 0) console.log(`（数据库预热了 ${i + 1} 次才快起来）`);
        return;
      }
    } catch {
      // 连不上也继续试；真的连不上，下面每一轮都会红，不用在这儿报
    }
    await sleep(1000);
  }
  // 预热到这一步还是慢的，说明不是冷启动。继续跑，但先给一句解释，
  // 免得下面那些红看起来像策略坏了
  console.log("⚠️ 数据库预热 15 次都没有快到 1 秒内，下面可能出现假红（真降级也会这样）。\n");
}

async function main(): Promise<void> {
  if (!CODE) {
    console.error("没有 REVIEW_ACCESS_CODE（.env.local 里也没找到），无法走查。");
    process.exitCode = 1;
    return;
  }
  try {
    const probe = await fetch(BASE, { method: "GET" });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (err) {
    console.error(
      `连不上 ${BASE} —— 这个脚本需要一个**已经跑着的** dev server。\n` +
        `先开一个终端跑 npm run dev，或者用 WALKTHROUGH_BASE 指向别处。\n` +
        `（原因：${err instanceof Error ? err.message : String(err)}）`,
    );
    process.exitCode = 1;
    return;
  }
  await warmUpDb();
  await run();
}

main().catch((err) => {
  console.error("走查自己出错了：", err);
  process.exitCode = 1;
});
