# 四级作文批改

一个 CET-4 作文批改网站。给档次、给分数、给证据溯源、给升档建议，最后能下载一份自包含的 HTML 批改报告。

## ⚠️ 先说一件事：这个项目没有用上你提到的 Skill

你要求用 `english-exam-writing-reviewer` Skill 来实现批改逻辑。**本机不存在这个 Skill**，所以那部分是我按公开的四级评分标准自己实现的。当时的检查结果：

- `C:\Users\24511\.claude\` 下没有 `skills\` 目录
- 全盘搜索 `*writing-reviewer*` 目录 → 无结果
- 搜索所有 `SKILL.md` 文件 → 无结果
- `.claude\plugins\marketplaces` 是空的

所以批改标准不是从那个 Skill 里读出来的。如果你手上有它，替换方法见下面「[换成你自己的批改标准](#换成你自己的批改标准)」——只需要改一个文件。

## 快速开始

```bash
npm install
cp .env.local.example .env.local   # Windows: copy .env.local.example .env.local
# 编辑 .env.local，填入 DEEPSEEK_API_KEY
npm run dev
```

打开 http://localhost:3000。没配 key 的话页面顶部会直接提示，不会让你写完作文才报错。

想先看看效果，输入页有三个内置示例作文（低/中/高三档），点一下就能填进去。

### 其他命令

```bash
npm run selftest    # 离线自测，92 项，不需要 API key、不联网
npm run typecheck   # 类型检查
npm run build       # 生产构建
```

`npm run selftest` 覆盖了证据定位、档次查表、分数折算、高亮切分、HTML 转义（XSS）、
模型输出的防御性解析，以及一条 mock 掉模型调用的端到端流程。改完代码先跑它。

## 页面与接口

| 路径 | 说明 |
| --- | --- |
| `/` | 作文输入页：题目、正文、目标档次、实时字数、示例填充 |
| `/result` | 结果展示页：档次、分数、总评、维度诊断、升档建议、证据溯源、原文批注 |
| `POST /api/review` | 批改接口。入参 `{ essay, topic?, targetBandLevel? }` |
| `GET /api/review` | 探活。返回 `{ ready, model }`，输入页据此提前提示缺 key |

结果页的数据来自 `sessionStorage`，不落库。关掉标签页就没了，作文不会留在服务器上。
代价是不能跨标签页分享结果——真要做分享，得改成服务端存储 + 短 id。

## 两个设计决定

### 1. 分数由模型给，档次由代码查表

学生看到的档次不是模型自己报的。模型只输出一个 0–15 的整数分，档次由
`lib/rubric.ts` 的 `bandForScore()` 按官方区间查出来。这样模型没法自创档位边界，
分数和档次永远自洽。折算到 106.5 分制也是纯算术。

### 2. 四级是整体评分，所以维度分不计入总分

四级作文采用**整体评分法**：阅卷员看完全文凭整体印象给一个档次，而不是把几个维度
加起来。所以这个项目里 `score15` 是唯一的计分来源，内容/语言/结构三个维度分
**只用于显示强弱分布**，不参与总分。任何「内容 4 分 + 语言 3 分 + 结构 4 分 = 11 分」
的算法都是错的。报告里也写明了这一点。

### 3. 证据坐标不来自模型

「证据溯源」是这样做的：模型被要求从原文**逐字抄一段**，坐标由服务端在原文里
重新定位算出来（`lib/evidence.ts`）。

这么做是因为模型数不清第几个字符，但它抄得对原文。而且——

- 抄错了会被抓到：定位失败就是 `verified: false`，报告里明确标出「未能在原文中定位」，
  而不是画一个看起来精确、实际错位的下划线。
- 定位方式会一并返回：逐字命中 / 忽略大小写后命中 / 分段命中（引文含省略号）/
  模糊命中 / 未能定位。用户知道每条引用有多可信。
- 同一句话被两条证据引用时，后一条会自动找下一处出现位置，不会两个高亮叠在一起。

## 目录结构

```
app/
  page.tsx                 作文输入页
  result/page.tsx          结果展示页（从 sessionStorage 读数据）
  api/review/route.ts      批改接口
  globals.css              设计令牌 + 共享组件类（全站唯一一份样式）
components/
  EssayForm.tsx            输入表单（客户端）
  LoadingStages.tsx        等待界面
  ReportView.tsx           报告主体编排
  BandCard.tsx             分数板 + 维度诊断
  UpgradePlan.tsx          升档建议
  EvidenceList.tsx         证据列表
  HighlightedEssay.tsx     原文批注（点高亮跳证据）
  ResultActions.tsx        下载报告 / 打印 / 再批一篇
lib/
  types.ts                 数据契约
  rubric.ts                四级评分标准：档次表、查表、折算、档间差距
  prompt.ts                ★ 批改提示词 —— 要换标准就改这里
  deepseek.ts              DeepSeek 客户端（原生 fetch，无 SDK 依赖）
  review.ts                编排层：模型输出 → 可靠结果
  evidence.ts              证据定位（逐字/归一化/分段/模糊）
  highlight.ts             高亮切分（网页与报告共用，保证两边一致）
  labels.ts                面向用户的文案（网页与报告共用）
  report-html.ts           自包含 HTML 报告生成
  text-stats.ts            字数/句数/段数（客户端服务端共用）
  samples.ts               示例作文
  store.ts                 sessionStorage 读写 + 报告下载
scripts/selftest.ts        离线自测
```

## 换成你自己的批改标准

如果你拿到了真正的 `english-exam-writing-reviewer` Skill，只需要改 **`lib/prompt.ts`**
里的 `buildReviewPrompt()`——把 SKILL.md 的规则搬进去，让它继续返回 `{ system, user }`
两个字符串即可，其余代码一行都不用动。

前提是模型输出的 JSON 结构保持不变（结构定义在 `lib/prompt.ts` 的 `JSON_CONTRACT`，
解析与校验在 `lib/review.ts`）。如果你的 Skill 要求的输出字段不一样，改这两处：

1. `lib/types.ts` — 调数据类型定义
2. `lib/review.ts` 里的 `parseEvidence` / `parseDimensionScores` / `parseUpgradePlan` — 对应的解析

档次表和折算规则在 `lib/rubric.ts`，改完记得把 `RUBRIC_VERSION` 往上加一位，
报告页脚会显示这个版本号。

## 换成别的模型

`lib/deepseek.ts` 用的是原生 `fetch` 打 OpenAI 兼容接口，没有引 SDK。改 `.env.local`：

```bash
DEEPSEEK_BASE_URL=https://api.moonshot.cn/v1   # 或通义、智谱、本地 Ollama
DEEPSEEK_MODEL=moonshot-v1-8k
DEEPSEEK_API_KEY=...
```

前提是对方兼容 `/chat/completions` 和 `response_format: { type: "json_object" }`。
不兼容的话，模型可能返回带 Markdown 代码块的 JSON——`extractJson()` 有三层兜底，
但如果对方连字段都不按 `JSON_CONTRACT` 来，就得改 `lib/review.ts` 的解析。

## 已知限制

- **不流式**。批改是一次请求一次返回，中途拿不到进度，所以等待界面没有进度条
  （画一个按时间爬的进度条是骗人）。长作文可能要 1–2 分钟。
  真要做流式，得改成 SSE + 增量 JSON 解析。
- **结果不跨标签页**。见上面「页面与接口」。
- **`quote` 依赖模型抄得准**。抄错了虽然会被标成「未能定位」而不会静默出错，
  但那条证据就废了。`buildReviewPrompt` 里用了一大段硬性要求在压这个风险。
- **分数仅供参考**。整体评分法本身有主观性，不同模型给的分数会有差异，
  不代表真实考试成绩。报告页脚也写了这句。
