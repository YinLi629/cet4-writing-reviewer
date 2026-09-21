import { EssayForm } from "@/components/EssayForm";

/**
 * 批改页（输入页）。
 *
 * hero 是纯静态 markup（服务端组件，零 JS），三段用 CSS 关键帧错开进场，
 * 所以首屏不需要等水合就有动效。
 *
 * 三个特性胶囊不是营销词，每个都对应 README 里一条真实的设计决定——hover 有解释。
 */
const FEATURES = [
  {
    label: "整体评分",
    hint: "四级是整体评分法：分数只有一个来源，维度分只显示强弱、不参与求和",
  },
  {
    label: "证据溯源",
    hint: "每条判断都要从你的原文里逐字抄一句，坐标由服务端在原文里重新定位",
  },
  {
    label: "不存你的作文",
    hint: "结果只留在当前标签页里，服务端不留作文，关掉就没了",
  },
];

export default function ReviewPage() {
  return (
    <div className="container container-narrow">
      <div className="hero">
        <h1>四级作文批改</h1>
        <p>
          给出档次、分数、逐条证据溯源和升档建议。每条评语都要指出它对上的是原文哪一句，
          定位不到的一律标出来，不假装精确。
        </p>
        <div className="hero-chips">
          {FEATURES.map((f) => (
            <span className="hero-chip" key={f.label} title={f.hint}>
              {f.label}
            </span>
          ))}
        </div>
      </div>

      <EssayForm />
    </div>
  );
}
