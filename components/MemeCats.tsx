/**
 * 首页背景墙上的猫贴纸。
 *
 * **这是自己画的，不是网上下的表情包。** 造型照着"圆头耄耋"那个梗的辨识点来——
 * 炸开的飞机耳、瞪着的怒眼、张嘴哈气——但一笔一笔都是原创的。
 * 这么做的原因有两条，都不是洁癖：
 *
 * 1. 那个梗的原始素材在公开讨论里被判为**疑似虐猫**（猫被关着、被激怒摆姿势、
 *    被拖把戳），九阳豆浆、《1999》外服、王者荣耀国际服都因为用这个梗被炎上过。
 *    这个站是要挂到公网上的，门面上不该放一个会被一部分人直接读成虐猫的东西。
 *    **所以这里只有猫，没有笼子、没有拖把、没有戳它的那根棍子**——那些道具才是
 *    真正的问题所在，不是猫本身。
 * 2. 网图是位图，颜色是死的，尺寸一放大就糊；这里的猫是矢量的，颜色跟着主题走。
 *
 * 组件是服务端组件（没有 "use client"）：整页零 JS，首屏不会先白一下。
 * 300 个格子共用这里的 6 个 <symbol>，靠 <use> 引用——所以 HTML 里只存一份路径。
 *
 * 颜色不在这个文件里写死，全在 app/globals.css 的 .meme-defs 那几条规则上：
 * .cat-body 走 currentColor（由 .meme 的 :nth-child 决定这一格是什么颜色），
 * .cat-hole 挖成 var(--bg)——挖空不能用白色，深色主题下会变成一嘴白牙。
 * 注意 fill="var(--bg)" 这种写法在这里是无效的：presentation attribute 不认 var()，
 * 必须走 CSS 声明。
 *
 * ---------------------------------------------------------------------------
 * 画这几只猫的三个约束（改坐标前先看这里，不然很容易画崩）：
 *
 * - **耳朵必须有一角扎进脑袋里。** 脑袋是后画的，会盖住耳朵，所以只要耳朵的底角
 *   落在圆内，接缝就自动干净了。反过来，如果整个三角形都在圆外，耳朵和脑袋之间
 *   会留一条一像素到七像素的缝，整墙的猫看起来都是"耳朵浮着"。
 *   脑袋统一是 (50,53) 或 (50,54)、半径 29，坐标都照这个算。
 * - **胡须必须从脑袋外缘起笔，而且得是猫的颜色。** 它是画在脑袋之后的，
 *   起点若在圆内就会在脸上留一道横线；用挖空色则整根看不见（背景色涂在背景上）。
 *   圆外缘：y=55 时 x≈21 与 79，y=62 时 x≈22 与 78。
 * - **五官全部要落在圆内**，并且后画的（嘴）不能盖住先画的（鼻子）。
 * ---------------------------------------------------------------------------
 */

/** 贴纸池。顺序写死，不随机——随机数会让服务端和客户端渲染出两套 DOM。 */
export const MEME_IDS = ["hiss", "flat", "side", "yell", "smug", "paw"];

export function MemeCats() {
  return (
    <defs>
      {/* 哈气：最"耄耋"的那一只，飞机耳 + 怒眉 + 张嘴露牙 */}
      <symbol id="meme-hiss" viewBox="0 0 100 100">
        <path className="cat-body" d="M38 44 L3 28 L28 14 Z" />
        <path className="cat-body" d="M62 44 L97 28 L72 14 Z" />
        <circle className="cat-body" cx="50" cy="53" r="29" />
        <path className="cat-whisker" d="M21 55 L5 51M22 62 L6 63M79 55 L95 51M78 62 L94 63" />
        <path className="cat-brow" d="M30 40 L45 45M70 40 L55 45" />
        <ellipse className="cat-hole" cx="37" cy="51" rx="6.2" ry="4.4" transform="rotate(16 37 51)" />
        <ellipse className="cat-hole" cx="63" cy="51" rx="6.2" ry="4.4" transform="rotate(-16 63 51)" />
        <path className="cat-hole" d="M46 61h8l-4 5z" />
        <path className="cat-hole" d="M39 70q11-5 22 0-11 15-22 0z" />
        <path className="cat-body" d="M45 69l3 6 3-6zM53 69l3 6 3-6z" />
      </symbol>

      {/* 死鱼眼：耳朵全平，眼睛眯成两条缝，嘴抿成一条线 */}
      <symbol id="meme-flat" viewBox="0 0 100 100">
        <path className="cat-body" d="M38 44 L3 28 L28 14 Z" />
        <path className="cat-body" d="M62 44 L97 28 L72 14 Z" />
        <circle className="cat-body" cx="50" cy="53" r="29" />
        <path className="cat-whisker" d="M21 55 L5 51M22 62 L6 63M79 55 L95 51M78 62 L94 63" />
        <path className="cat-brow" d="M30 50h14M56 50h14" />
        <path className="cat-hole" d="M46 61h8l-4 5z" />
        <path className="cat-mouth" d="M43 71h14" />
      </symbol>

      {/* 侧目：一只眼瞪圆、一只半眯，嘴撇着 */}
      <symbol id="meme-side" viewBox="0 0 100 100">
        <path className="cat-body" d="M38 45 L3 34 L30 16 Z" />
        <path className="cat-body" d="M62 42 L97 24 L70 12 Z" />
        <circle className="cat-body" cx="50" cy="54" r="29" />
        <path className="cat-whisker" d="M21 56 L5 52M22 63 L6 64M79 56 L95 52M78 63 L94 64" />
        <circle className="cat-hole" cx="37" cy="51" r="6" />
        <path className="cat-brow" d="M56 51h15" />
        <path className="cat-hole" d="M46 61h8l-4 5z" />
        <path className="cat-mouth" d="M41 72q9 4 18-3" />
      </symbol>

      {/* 嗷：耳朵立着，嘴张成 O 型 */}
      <symbol id="meme-yell" viewBox="0 0 100 100">
        <path className="cat-body" d="M36 40 L12 10 L46 16 Z" />
        <path className="cat-body" d="M64 40 L88 10 L54 16 Z" />
        <circle className="cat-body" cx="50" cy="54" r="29" />
        <path className="cat-whisker" d="M21 56 L5 52M22 63 L6 64M79 56 L95 52M78 63 L94 64" />
        <path className="cat-brow" d="M30 42 L45 46M70 42 L55 46" />
        <ellipse className="cat-hole" cx="37" cy="52" rx="6" ry="4.6" transform="rotate(16 37 52)" />
        <ellipse className="cat-hole" cx="63" cy="52" rx="6" ry="4.6" transform="rotate(-16 63 52)" />
        <path className="cat-hole" d="M46 62h8l-4 5z" />
        <ellipse className="cat-hole" cx="50" cy="74" rx="9" ry="8" />
        <path className="cat-body" d="M45 69l3 5 3-5zM53 69l3 5 3-5z" />
      </symbol>

      {/* 装没事：闭着笑眼，一副"我刚没哈气"的样子 */}
      <symbol id="meme-smug" viewBox="0 0 100 100">
        <path className="cat-body" d="M38 44 L3 28 L28 14 Z" />
        <path className="cat-body" d="M62 44 L97 28 L72 14 Z" />
        <circle className="cat-body" cx="50" cy="53" r="29" />
        <path className="cat-whisker" d="M21 55 L5 51M22 62 L6 63M79 55 L95 51M78 62 L94 63" />
        <path className="cat-brow" d="M31 53q6-8 12 0M57 53q6-8 12 0" />
        <path className="cat-hole" d="M46 61h8l-4 5z" />
        <path className="cat-mouth" d="M42 71q4 5 8 0 4 5 8 0" />
      </symbol>

      {/* 爪印：不含脸的填充格，让整墙的密度匀一点。趾垫和掌垫之间留缝是对的，
          真实的爪印就是这样，不是没接上 */}
      <symbol id="meme-paw" viewBox="0 0 100 100">
        <ellipse className="cat-body" cx="50" cy="66" rx="24" ry="20" />
        <ellipse className="cat-body" cx="24" cy="40" rx="10" ry="12" transform="rotate(-18 24 40)" />
        <ellipse className="cat-body" cx="42" cy="28" rx="10" ry="12.5" transform="rotate(-6 42 28)" />
        <ellipse className="cat-body" cx="60" cy="28" rx="10" ry="12.5" transform="rotate(6 60 28)" />
        <ellipse className="cat-body" cx="78" cy="40" rx="10" ry="12" transform="rotate(18 78 40)" />
      </symbol>
    </defs>
  );
}
