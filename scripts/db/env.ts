/**
 * 给 scripts/db/ 下的脚本加载 .env.local。
 *
 * `npm run` 跑的是裸 node，**不会**读 .env.local（Next.js 只在 dev/build 时读它）。
 * 所以这两个脚本要自己来，否则用户明明配好了 DATABASE_URL，脚本却报"没有配置"。
 * 这类"配置明明在、工具说没有"的落差正是最容易让人去改错东西的那种误导。
 *
 * 不引 dotenv：需要的只有"按行读 KEY=VALUE"，多一个依赖就多一处供应链和版本问题。
 *
 * 刻意比 dotenv 保守：
 * - **已存在的环境变量优先**。`DATABASE_URL=... npm run db:smoke` 这种一次性覆盖
 *   必须能生效，否则连"拿另一个库试一下"都做不到。
 * - 不做变量插值、不认多行值。这个文件是我们自己写的，不需要那些。
 *
 * ⚠️ 只给手动跑的 db 脚本用。**scripts/selftest.ts 绝不能引它**——自测必须是离线的，
 * 一旦它开始读 .env.local，任何本机配了 DATABASE_URL 的人跑 `npm run selftest`
 * 都会开始打真实数据库。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV_PATH = join(process.cwd(), ".env.local");

/** 返回是否真的读到了文件（没读到不算错——可能是靠真实环境变量配的） */
export function loadDotEnvLocal(): boolean {
  let raw: string;
  try {
    raw = readFileSync(ENV_PATH, "utf8");
  } catch {
    return false;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const name = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    // 去掉成对的引号。只认成对的，避免把密码里单独一个引号吃掉
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (!(name in process.env)) process.env[name] = value;
  }

  return true;
}
