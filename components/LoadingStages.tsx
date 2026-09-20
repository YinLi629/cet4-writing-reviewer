"use client";

import { useEffect, useState } from "react";

/**
 * 批改等待界面。
 *
 * 刻意**不做进度条**：批改是一次请求、一次返回，中途拿不到任何真实进度，
 * 画一个按时间爬的进度条等于骗人。这里只如实给出已用时间和服务端在做的事。
 */

const PIPELINE: Array<{ title: string; detail: string }> = [
  {
    title: "通读全文并定档",
    detail: "按四级整体评分法给出 15 分制印象分，再由程序查表得到档次（不让模型自报档次）",
  },
  {
    title: "摘取原文证据",
    detail: "要求模型逐字引用原文，再由程序在原文中重新定位，算出字符坐标",
  },
  {
    title: "校验引用是否可定位",
    detail: "定位不到的引用会被标记出来，不会假装精确",
  },
  {
    title: "生成升档建议与 106.5 分折算",
    detail: "对照官方档次描述的差距给出可执行动作，并折算到作文满分",
  },
];

export function LoadingStages({ modelName }: { modelName?: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const slow = elapsed >= 60;

  return (
    <div className="card">
      <div className="row-between">
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span className="spinner" />
          <strong style={{ fontSize: 16 }}>正在批改…</strong>
        </div>
        <span className="elapsed">已用 {elapsed} 秒</span>
      </div>

      <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
        {modelName ? `模型：${modelName}。` : ""}
        批改一次只发一个请求，需要模型读完全文再生成完整报告，中途无法获取进度，
        所以这里不显示进度条。
      </p>

      <ul className="stage-list">
        {PIPELINE.map((step) => (
          <li key={step.title} className="done">
            <span className="stage-dot" />
            <span>
              <strong style={{ color: "var(--ink)", fontWeight: 600 }}>{step.title}</strong>
              <br />
              <span className="small">{step.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {slow && (
        <div className="alert alert-warn" style={{ marginTop: 16, marginBottom: 0 }}>
          <strong>比平时慢</strong>
          长作文和网络抖动都可能拖到 1–2 分钟。请不要关掉页面，请求仍在进行中。
        </div>
      )}
    </div>
  );
}
