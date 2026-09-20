/**
 * 定位项目根目录。
 *
 * 不能靠数 ".." 的层数：这些脚本先被 tsc 编译到 .eval-build/ 再运行，
 * 编译后的 __dirname 是 .eval-build/scripts/eval，层数和源码位置对不上。
 * 往上找 package.json 就没这个问题，以后改输出目录也不用跟着改。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`从 ${from} 往上找不到 package.json，无法定位项目根目录`);
}

export const ROOT = findRoot(__dirname);
export const EVAL_OUT_DIR = join(ROOT, ".eval-out");
export const ENV_FILE = join(ROOT, ".env.local");
