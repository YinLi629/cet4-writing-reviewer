import { AccessGateForm } from "@/components/AccessGateForm";

/**
 * 口令页：首页那个按钮的落脚点，批改页唯一的前门。
 *
 * 单独一页而不是把口令框摆在批改页上，是因为两件事的性质不同：口令是**进门**，
 * 写作文是**干活**。混在一页时，一个还没进门的人看到的是"输入口令 + 一堆作文选项 +
 * 开始批改"，他得先判断哪些能碰。
 *
 * 这一页是纯静态 markup + 一个客户端表单（和 /review 一样的分工），
 * 所以首屏不需要水合就能显示。
 */
export default function AccessPage() {
  return (
    <div className="container container-narrow">
      <div className="hero hero-compact">
        <h1>访问口令</h1>
        <p>
          批改烧的是站点主人的模型额度，所以有一道共享口令挡着。口令向站点主人索取，
          <strong>验证通过后才会进批改页</strong>——省得写完一整篇才发现口令不对，
          那一次额度也算白花了。
        </p>
      </div>

      <AccessGateForm />
    </div>
  );
}
