# 四级作文批改

一个 CET-4 作文批改网站。给档次、给分数、给证据溯源、给升档建议，最后能下载一份自包含的 HTML 批改报告。
批改是流式的：报告在输入页上边生成边填出来，分数作为收尾出现，一出现就是终值。

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
# 编辑 .env.local，填入 DEEPSEEK_API_KEY 和 REVIEW_ACCESS_CODE
npm run dev
```

打开 http://localhost:3000。没配 key 的话页面顶部会直接提示，不会让你写完作文才报错。

想先看看效果，输入页有三个内置示例作文（低/中/高三档），点一下就能填进去。

### 其他命令

```bash
npm run selftest    # 离线自测，282 项，不需要 API key、不联网
npm run typecheck   # 类型检查
npm run build       # 生产构建
```

`npm run selftest` 覆盖了证据定位、档次查表、分数折算、高亮切分、HTML 转义（XSS）、
模型输出的防御性解析、请求体大小上限、限流与口令锁定、客户端断开时中止上游调用、
SSE 分帧（含帧被切在两块 chunk 之间）、增量 JSON 扫描的前缀单调性、
流式与非流式对同一份模型输出的完全一致，以及一条 mock 掉模型调用的端到端流程。
改完代码先跑它。

## 访问口令

`POST /api/review` 烧的是站长自己的模型额度，所以加了一道共享口令：请求必须带上与服务端
`REVIEW_ACCESS_CODE` 一致的口令才能批改。

**没配 `REVIEW_ACCESS_CODE` 时，服务端拒绝一切批改请求**，不会静默放行。这是刻意的——
公开站点上「忘了配所以裸奔」的代价太大，宁可让它坏得明显。输入页会在这种情况下提前提示，
而不是让你写完作文才报错。

口令在输入页输入一次后记在浏览器 localStorage 里，之后免输。只有口令**正确**时才会被记住，
输错不会被持久化，免得下次预填一个错的值。

轮换口令：改环境变量（线上改 Vercel 的环境变量）然后重启 / 重新部署，不需要改代码。
口令请用长随机串——下面那些限流只是辅助，真正的防线是口令本身有足够的熵。

校验在路由层（`app/api/review/route.ts`），核心逻辑是 `lib/access.ts` 里的纯函数，
比对用 `timingSafeEqual`（先各自 SHA-256 摘要再比，避免长度不等时抛错，也不泄露口令长度）。

## 限流的真实边界

`lib/rate-limit.ts` 里有两道限制，参数都走环境变量（见 `.env.local.example`）：

| 限制 | 默认值 | 作用 |
| --- | --- | --- |
| 口令连续失败 | 5 次 → 锁 15 分钟 | 挡口令爆破 |
| 批改请求频率 | 15 次/小时/IP | 挡拿着正确口令刷额度、以及拿接口当靶子 |
| 失败延迟 | 400ms | 拖慢串行爆破 |

**但必须先说清楚：这是减速带，不是墙。**

Vercel 是无服务器架构——每个实例有独立的进程内存，实例随时回收、也会横向扩容。
上面的计数只在**同一个实例内**有效。并发打过来，请求会分散到不同实例，各自的计数
互不可见，实际允许的次数按实例数成倍放大。它拦得住脚本小子和手滑连点，拦不住有准备的
攻击者。跨实例的真正限流需要 Redis / Vercel KV / Upstash 这类外部存储。

第二个前提：调用方标识取自 `x-forwarded-for` / `x-real-ip`。这些头**只有在可信代理
后面才可信**。Vercel 会覆写它们，所以线上没问题；但要是把服务直接暴露在公网（不经过
代理），攻击者可以随便伪造这个头，给每个请求换一个"新 IP"，限流就形同虚设了。

所以：**如果你打算长期公开这个站点，请把口令设成足够长的随机串，并考虑接一个
外部存储做真正的限流。**

## 请求体大小上限

`lib/request-body.ts` 把请求体硬性限制在 128 KB。这不是可选项：Next 的 App Router
route handler **没有**默认 body 上限（Pages API 那个 1MB 限制不适用于它），不设限的话
任何匿名请求都能让服务端先把任意大的 JSON 读进内存、解析完，之后才轮到口令校验——
闸门拦不住这一步。

限制是**流式计数**实现的，不只看 `Content-Length`：恶意客户端可以不带这个头、改用
分块编码。超限会立刻中断读取，不把剩下的读完。超过上限返回 413 `PAYLOAD_TOO_LARGE`。

## 页面与接口

| 路径 | 说明 |
| --- | --- |
| `/` | 作文输入页：题目、正文、目标档次、实时字数、示例填充 |
| `/result` | 结果展示页：档次、分数、总评、维度诊断、升档建议、证据溯源、原文批注 |
| `POST /api/review` | 批改接口。入参 `{ essay, topic?, targetBandLevel?, accessCode? }`，返回 SSE 事件流（`REVIEW_STREAM=0` 时退化成一次性 JSON） |
| `GET /api/review` | 探活。返回 `{ ready, gated, model }`，输入页据此提前提示缺 key / 缺口令 |

输入上限：`essay` 20–8000 字符，`topic` 最多 1000 字符。定义在 `lib/types.ts`，
输入页和服务端用同一组数字。

批改接口的错误码与状态码：

| 状态 | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | 入参不合法（空/过短/超长/题目超长），或请求体不是 JSON |
| 401 | `INVALID_ACCESS_CODE` | 口令不对 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 128 KB |
| 429 | `RATE_LIMITED` | 请求太频繁，或口令连续输错被锁定（带 `Retry-After`） |
| 499 | `CLIENT_ABORTED` | 客户端主动断开，服务端一并中止了上游调用。这个码只出现在服务端日志里——断开的那一方已经不在了 |
| 500 | `MISSING_API_KEY` / `MISSING_ACCESS_CODE` | 服务端没配好，不是调用方的问题 |
| 502 | `UPSTREAM_ERROR` / `BAD_MODEL_OUTPUT` | 模型服务出错或输出不可解析 |
| 504 | `TIMEOUT` | 批改超时（总预算用尽，或长时间没有新内容） |

上面的状态码只覆盖**开流之前**就失败的情况。接口是流式的（见下一节），一旦开始返回
内容，状态码就固定成 200 了，后来的失败只能走带内 `error` 帧。

单次批改的总预算默认 100 秒（`REVIEW_TIMEOUT_MS` 可调）。这个默认值**刻意**比路由的
`maxDuration = 120` 少 20 秒：模型返回后还要解析输出、在原文里逐条定位证据、组织响应，
两者相等的话，模型掐着点返回时平台会先把函数掐掉，用户只看到一个平台级报错，
而额度已经花掉了。

流式之后这个计时器**覆盖整个生成阶段**（不再像以前那样在响应头到达时就被清掉，
否则生成期就没有上限了）。另外多了一道 `REVIEW_STALL_MS`（默认 30 秒）：上游连续
这么久没有吐出任何新字节就主动中止。用户真正会遇到的失败几乎都是这一种，所以它
单独有一个能说明白发生了什么的提示语，而不是一个光秃秃的秒数。

用户关掉标签页或刷新时，服务端会一并中止上游的模型调用，不再为一个没人接收的响应
继续计费（路由把 `request.signal` 透传到了 `chatJSON` / `openChatStream`）。

结果页的数据来自 `sessionStorage`，不落库。关掉标签页就没了，作文不会留在服务器上。
代价是不能跨标签页分享结果——真要做分享，得改成服务端存储 + 短 id。

## 批改是流式的

`POST /api/review` 返回的是 SSE（`Content-Type: text/event-stream`），不是一次性 JSON。
报告在输入页上边生成边填出来，分数作为收尾出现——**一出现就是终值**。

事件白名单（定义在 `lib/types.ts` 的 `ReviewStreamEvent`）：

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `meta` | `{ stats, model, topic, startedAt }` | 上游一打开就发。成功时第一个事件一定是它 |
| `summary` | 总评文本 | 模型把这个字段写完整之后 |
| `strengths` | 优点数组 | 同上 |
| `dimensionScores` | 维度诊断分（可能分几帧到） | 同上 |
| `evidence` | 一条引文，`{ pending: true, ... }`，**没有坐标** | 一条一帧 |
| `progress` | `{ chars }` | 2 秒定时，无条件发 |
| `result` | 完整 `ReviewResult` | 最后。到这一帧为止的渐进内容全部作废 |
| `error` | `{ error, code }` | 开流之后的任何失败 |

三条硬规矩：

- **帧里没有 `score15`，也没有 `warnings`。** 分数要过服务端的上限校正（依据模型自己
  标的 major 条数与维度分），提前露出模型的原始分会几秒后当场跳一次（13 → 12）；
  `warnings` 里那条「分数已由系统校正：模型给出 N 分」会把同一个数泄露出去。
  过滤在服务端做，不靠客户端自觉。
- **不回显 `essay`。** 客户端本来就有（渐进视图也不渲染原文批注），回传最多 8000 字符是浪费。
- **没有百分比。** 模型还要写多少字是未知的，画一个按时间爬的进度条是骗人。
  `progress` 报的是「已经收到多少字符」，不涨就是诚实的「上游确实没有新动静」。

**哪些失败是真状态码、哪些走带内**，取决于失败发生在开流之前还是之后：

- **开流之前**（闸门、缺 key、上游 401/403/5xx、空内容）→ 照旧是真状态码，就是上面的
  错误码表。做法是**先打开上游、拿到响应头，再返回流**，所以这些错误还来得及变成
  `500` / `502`。代价是首字节要多等约 1 秒（上游的 TTFB），紧接着发出的 `meta` 帧让
  用户感觉不到。
- **开流之后**（生成中途上游挂了、总预算或停滞超时用尽、上游输出被截断）→ 只能走带内
  `error` 帧，此时 HTTP 状态码已经固定成 200。客户端把**已经收到的部分留在界面上**并给
  重试按钮——把已经花钱生成的 90% 扔掉是最差的选择。

客户端**按 `content-type` 分支**：不是 `text/event-stream` 就按一次性 JSON 处理。所以
`REVIEW_STREAM=0` 是一个运维逃生口——整个退回「一次请求一次返回」，客户端一行都不用改。
换到不支持流式的上游时也用它。

增量解析（`lib/json-stream.ts`）是**纯函数式全量重扫**：每收到一段 delta 就从零重扫整个缓冲，
而不是维护增量状态机。缓冲只增长，纯重扫天然幂等，也绕开了「chunk 边界正好切断 `\"`、
`A` 或代理对」这类经典失配。这里有一条要在代码里记住的安全性质：**最终结果永远是
`extractJson(累积全文)` 解出来的，不是扫描器的输出**——所以扫描器的 bug 最多让渐进视图
稀疏（少报），永远污染不了报告。

SSE 的响应头里 **`Cache-Control: no-transform` 是承重墙**，不是装饰：Next 15 默认给每个
请求套一层 compression，而它内置的 compressible 把 `text/event-stream` 判成可压缩，
阈值检查也不救场（流式响应没有 `Content-Length`）。加上 `no-transform` 让 `shouldTransform()`
直接返回 false，把压缩整个从链路上摘掉，不再依赖「Next 每次 `res.write` 后会调 `res.flush()`」
这个实现细节。

## 三个设计决定

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
  ReviewProgress.tsx       流式等待界面：报告边生成边填到页面上
  ReportView.tsx           报告主体编排
  BandCard.tsx             分数板 + 维度诊断
  DiagnosisCard.tsx        总评 / 优点 / 维度诊断（最终视图与渐进视图共用）
  UpgradePlan.tsx          升档建议
  EvidenceList.tsx         证据列表
  HighlightedEssay.tsx     原文批注（点高亮跳证据）
  ResultActions.tsx        下载报告 / 打印 / 再批一篇
lib/
  types.ts                 数据契约 + 输入长度上限 + SSE 事件白名单
  rubric.ts                四级评分标准：档次表、查表、折算、档间差距
  prompt.ts                ★ 批改提示词 —— 要换标准就改这里
  deepseek.ts              DeepSeek 客户端（原生 fetch，无 SDK 依赖；流式与非流式两条路）
  sse.ts                   SSE 编解码 + 流式响应头（同构，可离线自测）
  json-stream.ts           增量 JSON 扫描（只喂渐进显示，不承担正确性）
  access.ts                访问口令：读取配置 + timingSafeEqual 校验
  rate-limit.ts            限流与口令锁定（内存实现，见「限流的真实边界」）
  request-body.ts          请求体读取，带 128 KB 硬上限
  review.ts                编排层：模型输出 → 可靠结果（流式与非流式共用同一份后处理）
  evidence.ts              证据定位（逐字/归一化/分段/模糊）
  highlight.ts             高亮切分（网页与报告共用，保证两边一致）
  labels.ts                面向用户的文案（网页与报告共用）
  report-html.ts           自包含 HTML 报告生成
  text-stats.ts            字数/句数/段数（客户端服务端共用）
  samples.ts               示例作文
  store.ts                 sessionStorage 读写 + 报告下载
  use-review-stream.ts     客户端：请求、SSE 分帧、归约成渐进状态（"use client"）
scripts/selftest.ts        离线自测
scripts/eval/              批改质量评测（真实调用 DeepSeek 并计费，见 run.ts 头部注释）
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

前提是对方兼容 `/chat/completions` 和 `response_format: { type: "json_object" }`，
以及 `stream: true` 的 SSE 输出（不用给 `stream_options`）。不兼容的话，模型可能返回带
Markdown 代码块的 JSON——`extractJson()` 有三层兜底，但如果对方连字段都不按
`JSON_CONTRACT` 来，就得改 `lib/review.ts` 的解析。

如果对方根本不支持流式，把 `REVIEW_STREAM=0` 设上——接口退回一次性 JSON，
等待界面仍然可用，只是报告在最后一次性出现。

## 已知限制

- **限流是内存里的，不是真正的墙**。见上面「限流的真实边界」——无服务器环境下
  每个实例各记各的，跨实例限流需要外部存储。
- **等待界面上没有分数，也没有百分比**。这是刻意的，不是没做完：总量未知，画一个按
  时间爬的进度条是骗人；分数要等上限校正算完，提前露出会当场跳变。见上面「批改是流式的」。
- **渐进视图没有原文批注**。某条引文的高亮坐标取决于整批引文（`lib/evidence.ts` 按长度
  排序并互斥占位），证据没到齐之前那个坐标根本不存在，硬画只会画出会移动的下划线。
  所以高亮只在 `/result` 出现。定位本身是毫秒级的 CPU 活，不拖慢收尾。
- **中途失败时已经生成的那部分不落盘、也不进导出报告**。它只在界面上留着供你看一眼，
  点重试就是重新批一次——上游的额度已经花掉了。
- **结果不跨标签页**。见上面「页面与接口」。
- **`quote` 依赖模型抄得准**。抄错了虽然会被标成「未能定位」而不会静默出错，
  但那条证据就废了。`buildReviewPrompt` 里用了一大段硬性要求在压这个风险。
- **分数仅供参考**。整体评分法本身有主观性，不同模型给的分数会有差异，
  不代表真实考试成绩。报告页脚也写了这句。
