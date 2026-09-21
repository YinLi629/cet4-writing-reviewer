"use client";

import { useEffect, useState } from "react";

import { applyTheme, readStoredTheme, type Theme } from "@/lib/theme";

/**
 * 深浅主题开关。
 *
 * 关键约束：**这里不按当前主题渲染不同的东西。** 两个图标永远都在 DOM 里，
 * 显示哪一个由 `:root[data-theme="dark"]` 上的 CSS 决定；aria-label 也只写
 * 「切换深色/浅色主题」，不写「切换到深色」。
 *
 * 原因是 <html> 上的 data-theme 是 layout 里那段内联脚本在水合**之前**写上的，
 * 服务端渲染时根本不知道它是什么。按状态渲染就必然水合不一致。
 */
export function ThemeToggle() {
  // null 表示"还没读到真实值"。这个值不参与渲染，所以不影响水合
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = readStoredTheme();
    if (stored) {
      setTheme(stored);
      return;
    }
    // 没手动选过：当前生效的就是系统给的那个，问一下 DOM
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next, true);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label="切换深色 / 浅色主题"
      title="切换深色 / 浅色主题"
    >
      <span className="icon-moon" aria-hidden="true" />
      <span className="icon-sun" aria-hidden="true" />
    </button>
  );
}
