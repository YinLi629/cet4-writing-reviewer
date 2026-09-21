"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * 滚动进场：这块第一次进入视口时加 `.is-in`，动一次就退订。
 *
 * 隐藏态只在 `html[data-reveal-ready]` 成立时才生效（见 globals.css），
 * 那个属性由 layout 里的内联脚本在首帧之前写上。所以：
 *   · 脚本没跑（无 JS、被扩展拦掉）→ 内容照常显示，不会整页空白；
 *   · 脚本跑了 → 不会先亮一下再藏。
 *
 * **不要用它包流式视图（ReviewProgress）里的东西**：那里每个 SSE 帧都会换掉
 * 子节点，进场动画会被反复触发，看起来像页面在抽搐。它只服务于 /result 和首页。
 */
export function Reveal({
  children,
  delayMs = 0,
  className,
}: {
  children: ReactNode;
  /** 同屏几块一起进场时的错开量，毫秒 */
  delayMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 没有 IntersectionObserver 就直接显示。宁可不动，也不能把内容藏起来
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          // 只动一次。不退订的话每次滚动进出都会重新加减类，动画会反复重放
          io.unobserve(entry.target);
        }
      },
      // 下边界收一点：别让块刚冒出个边就开始动
      { rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className ? `reveal ${className}` : "reveal"}
      style={delayMs ? ({ "--reveal-delay": `${delayMs}ms` } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}
