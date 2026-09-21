/**
 * 建表。`npm run db:init`
 *
 * 读 db/schema.sql，按分号拆开**逐条**执行——Neon 的 SQL-over-HTTP 端点一次请求
 * 只跑一条语句，把多条拼在一起发过去会失败。全部语句都是 IF NOT EXISTS，所以
 * 重复跑是安全的。
 *
 * 需要有 DATABASE_URL。第一次用之前请先读 README 的「限流的真实边界」。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dbQuery, getDatabaseUrl } from "../../lib/db";

import { loadDotEnvLocal } from "./env";

const SCHEMA_PATH = join(process.cwd(), "db", "schema.sql");

/**
 * 按分号拆语句。
 *
 * 这个拆法很朴素（不懂字符串字面量和 $$ 块），只够用在这个 schema 上——
 * 那里的注释刻意不写分号，也没有函数定义。**往 schema.sql 里加东西之前先看这条**：
 * 一旦引入 DO $$ ... $$ 或含分号的字符串，这里得换成真正的 SQL 解析。
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 把语句压成一行摘要，方便打印 */
function summarize(statement: string): string {
  const withoutComments = statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutComments.length > 72 ? `${withoutComments.slice(0, 72)}…` : withoutComments;
}

async function main(): Promise<void> {
  const loaded = loadDotEnvLocal();
  if (!getDatabaseUrl()) {
    console.error(
      loaded
        ? "已读 .env.local，但里面没有可用的 DATABASE_URL（空值、不是 postgres 协议、或还是示例占位串都算没配）。"
        : "没有 .env.local。请在里面配置 DATABASE_URL（形如 postgresql://…?sslmode=require）。",
    );
    process.exitCode = 1;
    return;
  }

  const statements = splitStatements(readFileSync(SCHEMA_PATH, "utf8"));
  console.log(`建表：db/schema.sql 共 ${statements.length} 条语句`);

  for (const statement of statements) {
    await dbQuery(statement);
    console.log(`  ✓ ${summarize(statement)}`);
  }

  console.log("完成。这张表现在是空的，第一次请求会自己建行。");
}

main().catch((err) => {
  console.error("建表失败：", err);
  process.exitCode = 1;
});
