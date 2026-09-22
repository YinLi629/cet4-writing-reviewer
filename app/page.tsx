import Link from "next/link";

import { MEME_IDS, MemeCats } from "@/components/MemeCats";

/**
 * 首页（开播页）。
 *
 * 纯静态 markup、零 JS：表情包墙是 CSS grid 铺出来的，顺序写死在下面，
 * 所以这一页不需要水合，首屏也没有"先白一下"的窗口。
 *
 * 这页只有一个出口，就是那个按钮，落在 /access（口令页）而不是 /review：
 * 先进门再干活，两件事分开。口令验过了才会到批改页。
 */

/**
 * 贴纸池来自 components/MemeCats.tsx（手画的 SVG 猫，不是网图，理由在那个文件里）。
 *
 * **顺序是写死的，不是随机取的**：随机数会让服务端和客户端渲染出两套 DOM。
 * 想换成真的图片，见 README「换成自己的表情包」。
 */
const STICKERS = MEME_IDS;

/**
 * 贴纸数量也是写死的，不量视口——量了就得等客户端，首屏会先白一下。
 *
 * 300 这个数是按最宽的屏倒推的：格子最宽 240px（见 .meme-wall 的 minmax），
 * 5K（5120×2880）要 21 列 × 12 行 ≈ 252 格才盖满，300 留了余量。
 * 多出来的被 .meme-wall 的 overflow 裁掉，不占版面、也不撑出滚动条；
 * 1080p 上只会用到七十几个。每格在 HTML 里就是一行 <use>，整墙压完几 KB。
 */
const STICKER_COUNT = 300;

export default function LandingPage() {
  return (
    <div className="landing">
      {/* 6 只猫的路径在这里只存一份，下面 300 格全是 <use> 引用 */}
      <svg className="meme-defs" aria-hidden="true" focusable="false">
        <MemeCats />
      </svg>

      {/* 纯装饰：对屏幕阅读器隐藏，也不参与鼠标事件 */}
      <div className="meme-wall" aria-hidden="true">
        {Array.from({ length: STICKER_COUNT }, (_, i) => (
          <span className="meme" key={i}>
            <svg viewBox="0 0 100 100">
              <use href={`#meme-${STICKERS[i % STICKERS.length]}`} />
            </svg>
          </span>
        ))}
      </div>

      <div className="landing-inner">
        <span className="live-pill">
          <i className="live-dot" />
          Live
        </span>

        <h1 className="script-title">
          Kang Shen is live
          <span className="script-line-2">…for real?</span>
        </h1>

        {/* 花体字自己是没有收笔的，这笔薄荷的手绘弧线补上那点"写出来的"味道 */}
        <svg className="swash" viewBox="0 0 320 22" fill="none" aria-hidden="true">
          <path
            d="M5 15c58-9 122-12 182-7 34 3 76 6 128 1"
            stroke="currentColor"
            strokeWidth="3.4"
            strokeLinecap="round"
          />
        </svg>

        {/* 花体英文是标题，中文原话留在下面：字是给眼睛看的，话是给人懂的 */}
        <p className="landing-caption">康神开播了，真的假的？</p>

        {/* 出口指向口令页，不是批改页：先进门再干活，两件事分在两页（见 app/access/page.tsx） */}
        <Link href="/access" className="btn btn-primary btn-lg landing-cta">
          真开播了！
        </Link>

        <p className="landing-note">
          真的批改：档次、分数、逐条证据溯源和升档建议，大约 10 秒
        </p>
      </div>
    </div>
  );
}
