/**
 * 深浅主题：读、写、以及在首次绘制前定下来。
 *
 * 这里的函数都会碰 DOM，所以**只能在浏览器里调用**。模块顶层不做任何 DOM 访问，
 * 因此它仍然能被 Node 侧的脚本 import（自测那条链只编译 lib/*.ts，不跑浏览器代码）。
 *
 * 主题值本身就是 html 上 data-theme 属性的取值，也是 localStorage 里存的值——
 * 三者是同一个字符串，少一层映射就少一处能对不上的地方。
 */

export const THEME_KEY = "theme";

export type Theme = "light" | "dark";

/**
 * 移动端浏览器把地址栏/状态栏染成什么颜色。取值和 globals.css 里的
 * --bg 是同一个（改一个要改另一个）。
 */
export const THEME_COLORS: Record<Theme, string> = {
  light: "#faf7f4",
  dark: "#16151a",
};

/** 读用户上次手动选的主题。没选过（或存的值不认识）返回 null，表示"跟随系统" */
export function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    // 隐私模式/禁用存储时读会抛。当作没选过，不让页面因此挂掉
    return null;
  }
}

/**
 * 把主题写到 <html data-theme> 上。persist=true 时才记进 localStorage
 * （点一下开关才算数，首次跟随系统不应该被当成"用户选了"）。
 */
export function applyTheme(theme: Theme, persist: boolean): void {
  document.documentElement.dataset.theme = theme;

  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 存不了就算了，这次访问仍然是用户选的主题
    }
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLORS[theme]);
}

/**
 * 塞进 <head> 的那段内联脚本。
 *
 * 它必须**阻塞**执行、且在首次绘制之前跑完，否则用户会先看到一帧浅色再被翻成深色
 * （深色模式下的"白闪"，很刺眼）。所以它不能走 React 的水合，也不该被 defer。
 *
 * 顺带在这里写 data-reveal-ready：滚动进场的隐藏态挂在那个属性上（见 globals.css），
 * 由这段脚本在首帧前加上——无 JS 时它就不存在，页面照常显示，不会整页空白。
 *
 * 注意：如果以后给站点加了 CSP，这段内联脚本需要 hash 或 nonce，否则会被拦掉，
 * 表现是主题永远停在浅色且滚动进场失效。
 *
 * 结构上有一条讲究：**读 localStorage 的那次 try 只包住读**。
 * 早先的写法把"算主题 + 写 data-theme"整个关在 try 里，于是隐私模式下
 * `getItem` 一抛，data-theme 就一个都没写上——渲染结果虽然还是浅色（没有属性就落到
 * `:root` 的浅色令牌上，不会碎），但**系统是深色的人会莫名其妙拿到浅色**：
 * 存储被禁用的用户本质上就是"第一次访问"，该跟系统走。所以现在读失败只是读失败。
 */
export function buildThemeScript(): string {
  return [
    "(function(){",
    "var d=document.documentElement,t=null;",
    "try{",
    `var s=localStorage.getItem(${JSON.stringify(THEME_KEY)});`,
    'if(s==="light"||s==="dark")t=s;',
    "}catch(e){}",
    "if(!t){",
    't=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";',
    "}",
    "d.dataset.theme=t;",
    // reveal-ready 排在前面：它和 data-theme 一样是"首帧之前必须成立"的东西，
    // 后面那句 meta 更新只是给手机地址栏上色，不该排在它们前面。
    'd.dataset.revealReady="1";',
    'var m=document.querySelector(\'meta[name="theme-color"]\');',
    `if(m){m.setAttribute("content",t==="dark"?${JSON.stringify(THEME_COLORS.dark)}:${JSON.stringify(THEME_COLORS.light)});}`,
    "})();",
  ].join("");
}
