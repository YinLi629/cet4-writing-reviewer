"use client";

import { useEffect, useState } from "react";

/**
 * 回到顶部。
 *
 * 为什么需要：批改页会变得很长——等待界面是边生成边长出来的，长作文能长到好几屏。
 * 而顶部恰恰放着用户此刻可能想按的东西（取消、重试），手机上要回去只能一路划。
 *
 * 用滚动监听切换显隐，不用 CSS 的 `position: sticky`：sticky 做不了"滚过一屏才出现"，
 * 而一个常驻的悬浮按钮在短页面上纯属噪音。
 */
const SHOW_AFTER_PX = 480;

export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setVisible(window.scrollY > SHOW_AFTER_PX);
    // 先跑一次：刷新后浏览器会恢复上次的滚动位置，那种情况下首帧就该是"已滚下去"
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toTop = (): void => {
    // 系统开了「减少动态效果」就不要平滑滚动：难受的是那段位移，不是这个动作
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      className="back-to-top"
      data-visible={visible ? "1" : "0"}
      onClick={toTop}
      /*
       * 没显示时把它从可访问性树和 Tab 顺序里摘掉。只靠 CSS 的 opacity: 0 是不够的：
       * 那样朗读器仍然会念出一个看不见的"回到顶部"，Tab 也会停在一个空的按钮上。
       */
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      aria-label="回到顶部"
      title="回到顶部"
    >
      ↑
    </button>
  );
}
