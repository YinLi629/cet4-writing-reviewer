/**
 * Neon Postgres 连接（HTTP 驱动）。
 *
 * 用 `@neondatabase/serverless` 而不是 `pg`：无服务器环境里每个实例都建一条 TCP
 * 连接，连接数会随实例数膨胀，把 Postgres 的连接槽占满。HTTP 驱动每次查询就是一个
 * HTTP 请求，没有连接池这回事。
 *
 * ## 三条驱动约束（1.0.0 之后）
 *
 * 1. 入口是 `neon()`，不是 `createClient()`。
 * 2. **参数化查询必须走 `sql.query(text, params)`**。1.0.0 起 `sql` 只能当模板标签
 *    调用，`sql("... $1", [v])` 是**运行时错误**（官方为堵注入刻意收窄）。本仓库的
 *    SQL 全是 `$n` 占位符，所以一律走 `sql.query`。
 * 3. 超时只能通过 `fetchOptions.signal` 传，没有 `timeout: 3000` 这种数字选项。
 *
 * ## 为什么超时是 4 秒而不是 1 秒
 *
 * Neon 免费档闲置约 5 分钟后会挂起，唤醒要 0.5–2 秒。这个站点的流量正好是
 * "一阵一阵"的，所以**冷启动是常态而不是异常**。按"健康数据库"的延迟去调超时，
 * 会让相当大一部分正常请求被误判成故障、悄悄走 fail open，日志里只剩一片超时。
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/** 单次查询的超时。见文件头"为什么是 4 秒" */
export const DB_TIMEOUT_MS = 4000;

/**
 * `.env.local.example` 里的占位连接串。
 *
 * 它非空、长得也像连接串，会被"配了数据库"的检查放过——于是站点显示"持久化已启用"，
 * 实际指向一个不存在的库，然后每个请求都 fail open。和 lib/access.ts 里
 * `change-me-please` 那个坑是同一类：占位值必须被当成"没配"。
 */
const PLACEHOLDER_URL = /^postgres(?:ql)?:\/\/(?:user|username)(?::[^@]*)?@(?:host|example\.com)\b/i;

/**
 * 取数据库连接串。空值、不是 postgres 协议、或占位值一律视为"没配"。
 *
 * ⚠️ 必须是函数（每次调用时读 env），不能提成模块级常量：自测要在同一个进程里
 * 反复切换"配了 / 没配"两种状态，常量会让它在第一次读取时就定死。
 */
export function getDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return undefined;
  if (!/^postgres(?:ql)?:\/\//i.test(url)) return undefined;
  if (PLACEHOLDER_URL.test(url)) return undefined;
  return url;
}

export function hasDatabase(): boolean {
  return getDatabaseUrl() !== undefined;
}

export type DbClient = NeonQueryFunction<false, false>;

let cached: { url: string; client: DbClient } | null = null;

/** 惰性建客户端。连接串变了就重建——自测靠这个在同一个进程里换库 */
export function getDb(): DbClient | null {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (cached?.url !== url) {
    cached = { url, client: neon(url) };
  }
  return cached.client;
}

/** 数据库不可用。区分超时和其他错误——排查时这是两条完全不同的线索 */
export class DbUnavailableError extends Error {
  readonly kind: "timeout" | "error";
  readonly original: unknown;

  constructor(kind: "timeout" | "error", message: string, original: unknown) {
    super(message);
    this.name = "DbUnavailableError";
    this.kind = kind;
    this.original = original;
  }
}

export type DbRow = Record<string, unknown>;

/**
 * 跑一条查询。
 *
 * 超时用 `AbortController + setTimeout` 而不是 `Promise.race`：后者一个字节都不取消，
 * 到 Neon 的 HTTP 请求会继续跑完、socket 继续占着，只是调用方不等了——那叫假装超时。
 * 也不要用 `AbortSignal.timeout`，这里的形态和 lib/deepseek.ts 的房规保持一致
 * （那边有注释解释为什么不用 `AbortSignal.any`），而且只有这个形态能显式 clearTimeout。
 *
 * `clearTimeout` 必须在 finally 里：漏了的话每个请求都会在暖实例里留下一个活着的定时器。
 */
export async function dbQuery(text: string, params: unknown[] = []): Promise<DbRow[]> {
  const sql = getDb();
  if (!sql) {
    throw new DbUnavailableError("error", "DATABASE_URL 没有配置", null);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);

  try {
    const rows = await sql.query(text, params, {
      fetchOptions: { signal: controller.signal },
    });
    return rows as DbRow[];
  } catch (err) {
    const aborted = controller.signal.aborted;
    const message = aborted
      ? `数据库查询超时（超过 ${DB_TIMEOUT_MS} ms）`
      : describeDbError(err);
    throw new DbUnavailableError(aborted ? "timeout" : "error", message, err);
  } finally {
    clearTimeout(timer);
  }
}

function describeDbError(err: unknown): string {
  if (err instanceof Error) {
    // Neon 的驱动把 Postgres 错误码放在 err.code（NeonDbError），带上它才有得查
    const code = (err as { code?: unknown }).code;
    return code ? `${err.name}: ${err.message}（code=${String(code)}）` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * 把一个数值结果从行里取出来。
 *
 * 驱动的返回值类型是 `any`，而 `EXTRACT(EPOCH ...)::double precision` 在 Postgres 里
 * 回来的是 JS number、`window_count` 回来的是 number，但都可能是字符串（取决于
 * 类型推断路径）。这里统一成数字，并给出一个**明确的兜底**而不是让 NaN 漏下去——
 * NaN 会让 `count >= limit` 恒为 false，也就是"限流静默失效"。
 */
export function rowNumber(row: DbRow | undefined, column: string, fallback: number): number {
  if (!row) return fallback;
  const value = Number(row[column]);
  return Number.isFinite(value) ? value : fallback;
}
