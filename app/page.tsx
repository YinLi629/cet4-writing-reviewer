import { EssayForm } from "@/components/EssayForm";

export default function HomePage() {
  return (
    <div className="container container-narrow">
      <div className="hero">
        <h1>四级作文批改</h1>
        <p>
          给出档次、分数、逐条证据溯源和升档建议。每条评语都要指出它对上的是原文哪一句，
          定位不到的一律标出来，不假装精确。
        </p>
      </div>

      <EssayForm />
    </div>
  );
}
