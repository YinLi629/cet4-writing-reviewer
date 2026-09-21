-- 限流状态表。
--
-- 一个客户端 IP 一行，口令失败计数和批改窗口共用同一行——这样"口令正确"那条路
-- 能把"清零失败记录"和"计一次批改"压成一条语句（见 lib/rate-limit-sql.ts）。
--
-- ⚠️ 列必须在第一次就定齐。CREATE TABLE IF NOT EXISTS 只跳过、不补列——
-- 以后再想加列得手写 ALTER。
--
-- 用法：把整个文件粘进 Neon 控制台的 SQL Editor 跑一次，或者本地跑 npm run db:init。
-- 注意 Neon 的 SQL-over-HTTP 端点一次请求只跑一条语句，所以 db:init 会按分号拆开逐条发。

CREATE TABLE IF NOT EXISTS rate_limits (
  -- 客户端 IP（见 lib/rate-limit.ts 的 clientKeyFrom）。取名 client_key 而不是 key：
  -- key 虽然也能用，但它是很多工具的保留词，加引号的地方容易踩坑
  client_key      text        PRIMARY KEY,

  -- 口令失败：连续失败次数、最后一次失败的时间（衰减用）、
  -- 当前这串锁的起算点（总时长封顶用）、锁到期时间
  fail_count      integer     NOT NULL DEFAULT 0,
  last_fail_at    timestamptz,
  lock_started_at timestamptz,
  locked_until    timestamptz,

  -- 批改窗口：固定窗口的起点和已用次数
  window_start    timestamptz NOT NULL DEFAULT now(),
  window_count    integer     NOT NULL DEFAULT 0,

  -- 机会性清理按它删陈旧行。没有这个索引，清理会全表扫
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_updated_at_idx ON rate_limits (updated_at);
