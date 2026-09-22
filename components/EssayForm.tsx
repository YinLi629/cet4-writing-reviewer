"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { BANDS } from "@/lib/rubric";
import { SAMPLE_ESSAYS } from "@/lib/samples";
import {
  clearDraft,
  type EssayDraft,
  loadAccessCode,
  loadDraft,
  loadResult,
  saveDraft,
} from "@/lib/store";
import { countEnglishWords } from "@/lib/text-stats";
import {
  MAX_TOPIC_CHARS,
  MIN_ESSAY_CHARS,
  type ReviewRequest,
} from "@/lib/types";
import { useReviewStream } from "@/lib/use-review-stream";

import { ReviewProgress } from "./ReviewProgress";

/** CET-4 作文的字数要求是「不少于 120 词」，超过 180 词通常也不再加分 */
const TARGET_MIN = 120;
const TARGET_MAX = 180;

/**
 * 草稿的落盘防抖间隔。
 *
 * 500ms 是「打字时几乎不写盘」和「意外发生时最多丢半秒」之间的折中：
 * 学生写 120 词至少要几分钟，敲键几百次，逐键写盘纯属浪费配额；
 * 而真要出事（F5、后台回收标签页）时，半秒内的输入本来也少得可以忽略。
 */
const DRAFT_DEBOUNCE_MS = 500;

/**
 * 草稿的摘要，40 字以内。存在的理由只有一个：**让用户一眼认出这是不是自己写的**。
 * 共用电脑上那份草稿可能是上一个人的，光说"有一份草稿"他没法判断，给一句原文就够了。
 *
 * 正文是空的（只存了题目）时退回题目——那份草稿仍然是用户的输入，值得被认出来，
 * 而一对空引号只会让人以为界面出错了。两者都空的情况到不了这里：
 * loadDraft() 用 isDraftEmpty 挡掉了。
 */
function draftExcerpt(draft: EssayDraft): string {
  const text = (draft.essay.trim() || draft.topic.trim()).replace(/\s+/g, " ");
  return text.length > 40 ? `「${text.slice(0, 40)}…」` : `「${text}」`;
}

export function EssayForm() {
  const [essay, setEssay] = useState("");
  const [topic, setTopic] = useState("");
  const [targetBandLevel, setTargetBandLevel] = useState<string>("");
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [gated, setGated] = useState<boolean | null>(null);
  const [persistence, setPersistence] = useState<"postgres" | "memory" | null>(null);
  const [accessCode, setAccessCode] = useState("");
  // 草稿是从 localStorage 异步读回来的，而「写草稿」的 effect 首帧就会跑一次。
  // 没有这个开关的话，首帧那次的空状态会先把已存的草稿覆盖掉，再回填——白写一轮，
  // 一旦中间出岔子（配额满、组件提前卸载）就直接把用户的作文弄丢了。
  const [draftLoaded, setDraftLoaded] = useState(false);
  // 上次没提交完的草稿：**读进来，但先不往输入框里放**，等用户点「恢复」。
  // 理由和"为什么不做成自动回填"见下面那个 effect 的注释。
  const [pendingDraft, setPendingDraft] = useState<EssayDraft | null>(null);
  /**
   * 这个浏览器上一份报告的生成时间；没有报告就是 null。
   *
   * 为什么表单页要关心这个：报告搬到 localStorage 之后，它的生命周期不再和任何
   * 页面绑定，而全站**只有批改成功那一瞬间的自动跳转**能到达 /result。也就是说，
   * 一个误关标签页、或者被系统回收了标签页的学生，报告是留下来了，却没有路回去——
   * 那这次批改照样是白花的。所以这里必须给一个入口。
   *
   * 存时间而不是布尔值，是为了把它印出来：共用电脑上，"上次的报告"完全可能是
   * 别人的。带上时间，看到的人自己就能判断。
   */
  const [lastReportAt, setLastReportAt] = useState<string | null>(null);

  // 一次批改的完整生命周期（请求、流式增量、终止态、跳转）都在这个 hook 里，
  // 表单只管收集输入和渲染
  const { phase, progress, error, start, cancel, reset } = useReviewStream();

  // pending 覆盖 running 和 finished 两段：后者是"结果已到手、正在跳转"，
  // 这时松开禁用会让用户看到表单闪一下
  const pending = phase === "running" || phase === "finished";

  // 口令是记住的，下次访问直接预填，不用重输
  useEffect(() => {
    setAccessCode(loadAccessCode() ?? "");
  }, []);

  /**
   * 把上次没提交完的草稿读进来，**但不回填**——只记在 pendingDraft 里等用户点。
   *
   * 为什么不做成自动回填（以前是自动的）：
   *   · 教室机房、宿舍共用的电脑上，上一个人没提交完的作文会**原样出现在下一个人的
   *     输入框里**。提示一句挡不住：他完全可能以为这是站点给的范文，顺手就提交了。
   *     要点一下才会进输入框，误认的机会就没了。
   *   · 更根本的是，自动回填是**改写用户正在编辑的东西**。同一个人回来时，
   *     输入框该是他自己的，不是我们替他决定放进去的一份旧文本。
   *
   * 为什么必须放在 effect 里而不是 useState 的初始值里：初始值会在 SSR 阶段
   * 也算一遍，服务端拿不到 localStorage，渲染出的是空表单，客户端却是有内容的，
   * 水合(hydration)对不上，React 会直接报错。所以首帧一律是空的，挂载后再读。
   *
   * 顺序有讲究：这个 effect 必须排在下面「写草稿」那个前面。effect 按声明顺序执行，
   * 这里同步调用的 setDraftLoaded 到下面那个 effect 运行时还是 false，
   * 于是首帧那次写入被跳过——正好是我们要的。
   */
  useEffect(() => {
    setPendingDraft(loadDraft());
    setDraftLoaded(true);
  }, []);

  // 上一份报告还在不在。读的是时间戳而不是一个布尔值，理由见 lastReportAt 的声明
  useEffect(() => {
    const stored = loadResult();
    setLastReportAt(stored ? stored.meta.createdAt : null);
  }, []);

  /** 恢复草稿：这一次才真的往输入框里放 */
  const restoreDraft = (): void => {
    if (!pendingDraft) return;
    setEssay(pendingDraft.essay);
    setTopic(pendingDraft.topic);
    setTargetBandLevel(pendingDraft.targetBandLevel);
    setPendingDraft(null);
  };

  /**
   * 丢弃草稿。
   *
   * 只动存储和 pendingDraft，**不动输入框**——草稿还没被放进去过，这时它是空的。
   * 以前这里要连带清三个字段，是因为那时草稿是自动回填的。
   */
  const discardDraft = (): void => {
    clearDraft();
    setPendingDraft(null);
  };

  /**
   * 用户自己动手改了输入框 —— 那份没认领的旧草稿就此作废。
   *
   * 为什么非要有这一步：草稿没被认领时，下面那个写草稿的 effect 是**停摆**的
   * （不这样，首帧的空表单会立刻把旧草稿覆盖掉）。这时如果用户无视提示直接开始写
   * 新的，而不在这里把 pendingDraft 摘掉，他新写的内容会一句都存不下——他按 F5 回来，
   * 提示的还是那份**旧的**，等于这个保险对"我就是要重写"的人失效了。
   *
   * 代价是旧草稿会被新内容覆盖（在 500ms 防抖之后）。这是可接受的：他是在看到
   * 提示的情况下选择重写的。**改了会怎样**：去掉这一句，新写的作文就不会被保存。
   */
  const claimTyping = (): void => {
    if (pendingDraft) setPendingDraft(null);
  };

  // 防抖写入。cleanup 里 clearTimeout 保证「只在停下来之后写一次」，
  // 而不是每敲一个字就写一遍
  useEffect(() => {
    if (!draftLoaded) return;
    // 已经批改成功就不该再落草稿了。少了这一句，下面 clearDraft 之后，
    // 提交前刚敲下的那半秒输入还会被这个定时器写回去，草稿就复活了。
    // 靠的是 effect 的声明顺序：它在 clearDraft 那个 effect 之前跑，
    // 于是「先撤掉待触发的定时器，再删草稿」，中间没有窗口。
    if (phase === "finished") return;
    // 有一份还没认领的旧草稿时**停摆**：这一刻输入框是空的（草稿还没放进去），
    // 照常写下去就等于把那篇旧作文删了——提示还挂着，内容已经没了。
    // 用户一动手（claimTyping）它就被摘掉，这里随之恢复
    if (pendingDraft) return;
    const timer = setTimeout(() => {
      // 三个字段全空时 saveDraft 内部会转成删除，不需要在这里特判
      saveDraft({ essay, topic, targetBandLevel });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [essay, topic, targetBandLevel, draftLoaded, phase, pendingDraft]);

  /**
   * 提交成功后把草稿删掉。
   *
   * 时机选 finished 而不是提交那一刻：这次批改要是失败了，作文还得留着让人重试。
   * 而 finished 是「结果已经落盘、正在跳转」——这时草稿的使命已经完成，
   * 再留着的话，用户从结果页回来会看到上一篇作文莫名其妙地躺在输入框里。
   */
  useEffect(() => {
    if (phase === "finished") clearDraft();
  }, [phase]);

  // 提前问一下服务端有没有配 key 和口令，别让用户写完作文才发现跑不起来
  useEffect(() => {
    let cancelled = false;
    fetch("/api/review")
      .then((r) => r.json())
      .then((d: { ready?: boolean; gated?: boolean; persistence?: string }) => {
        if (cancelled) return;
        setApiReady(Boolean(d.ready));
        setGated(Boolean(d.gated));
        // 只认这两个明确的值。字段缺失（比如前端是新的、后端还是旧的）时不显示
        // 提示——宁可少提示，也不能凭一个 undefined 就说"限流没生效"吓人
        const mode = d.persistence;
        setPersistence(mode === "postgres" || mode === "memory" ? mode : null);
      })
      .catch(() => {
        if (!cancelled) setApiReady(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const wordCount = useMemo(() => countEnglishWords(essay), [essay]);
  const tooShort =
    essay.trim().length > 0 && essay.trim().length < MIN_ESSAY_CHARS;
  // 没有 tooLong：作文不限字数。唯一还能拦住超长输入的是服务端的 128 KB
  // 请求体上限，那是异常情况，不值得在表单里提前吓唬人。

  const buildRequest = (): ReviewRequest => ({
    essay,
    topic: topic.trim() || undefined,
    targetBandLevel: targetBandLevel ? Number(targetBandLevel) : undefined,
    accessCode: accessCode.trim() || undefined,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    start(buildRequest());
  };

  // running 时是无条件切换（连第一帧都还没到也要给个等待界面，那段是上游的首字节延迟）；
  // failed 时只在已经拿到了内容的情况下留在进度视图里——否则连半成品都没有，
  // 该做的是回到表单、把错误摆在输入框上方
  if (pending || (phase === "failed" && progress)) {
    return (
      <ReviewProgress
        progress={progress}
        running={pending}
        error={error}
        onCancel={cancel}
        onRetry={() => start(buildRequest())}
        onBack={reset}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/* 上一份报告的入口。放得低调是有意的：它是「顺带告诉你一声」，
          不是这条流程的主线，不该跟下面那些报错抢注意力。
          但必须得有——全站只有批改成功那一瞬间的自动跳转能到 /result，
          少了这个链接，报告留下了也够不着 */}
      {lastReportAt && (
        <p className="last-report">
          这个浏览器上还有一份{" "}
          {new Date(lastReportAt).toLocaleString("zh-CN", { hour12: false })}
          生成的批改报告。
          <Link href="/result" className="last-report-link">
            打开它
          </Link>
        </p>
      )}

      {apiReady === false && (
        <div className="alert alert-error">
          <strong>服务端还没有配置 API Key</strong>
          把项目根目录的 <code>.env.local.example</code> 复制成{" "}
          <code>.env.local</code>，填入 <code>DEEPSEEK_API_KEY=sk-...</code>
          ，然后重启开发服务器。现在提交会直接报错。
        </div>
      )}

      {gated === false && (
        <div className="alert alert-error">
          <strong>服务端还没有配置访问口令</strong>
          在环境变量里设置 <code>REVIEW_ACCESS_CODE</code>
          ——本地写进 <code>.env.local</code>，线上写进 Vercel 的环境变量，然后重启或重新部署。
          出于安全考虑，没配口令时服务端会拒绝一切批改请求。
        </div>
      )}

      {/* 用 warn 而不是 error：站点照常能用，退化的只是限流的强度。
          两种原因都走这里：没配 DATABASE_URL，或者配了但数据库连不上 */}
      {persistence === "memory" && (
        <div className="alert alert-warn">
          <strong>限流的持久化存储没有生效</strong>
          服务端现在把限流状态存在单个实例的内存里，要么是没配{" "}
          <code>DATABASE_URL</code>
          ，要么是数据库连不上（后一种情况服务端日志里有一条告警）。本地开发无所谓，
          线上这样部署会让这道限制漏掉。在 Vercel 的环境变量里配好{" "}
          <code>DATABASE_URL</code> 后重新部署。
        </div>
      )}

      {/* 用 warn 而不是 error：这是「提醒你留意一下」，不是出错。
          摆的是**按钮**而不是自动回填，理由见 pendingDraft 的声明 */}
      {pendingDraft && (
        <div className="alert alert-warn">
          <strong>这个浏览器上还留着一份草稿</strong>
          <span className="draft-excerpt">{draftExcerpt(pendingDraft)}</span>
          可能是上次没提交完的（刷新、或者手机把标签页回收了），也可能是你刚从报告页
          「返回输入界面」带回来的。如果这不是你写的内容，点「丢弃」。
          <div className="btn-row alert-actions">
            <button type="button" className="btn" onClick={restoreDraft}>
              恢复它
            </button>
            <button type="button" className="btn btn-ghost" onClick={discardDraft}>
              丢弃
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="alert alert-error">
          <strong>批改失败</strong>
          {error.message}
          {error.code === "INVALID_ACCESS_CODE" && (
            <div className="alert-detail">
              检查一下上面的「访问口令」是否与服务端配置的{" "}
              <code>REVIEW_ACCESS_CODE</code> 一致。
            </div>
          )}
          {error.code === "TIMEOUT" && (
            <div className="alert-detail">
              作文字数越多耗时越长，可以调大 <code>.env.local</code> 里的{" "}
              <code>REVIEW_TIMEOUT_MS</code>。
            </div>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="accessCode">
          访问口令
          <span className="hint">
            站点的批改额度有限，需要口令才能用。输入一次后会记在这个浏览器上
          </span>
        </label>
        <input
          id="accessCode"
          className="input field-narrow"
          type="password"
          autoComplete="off"
          placeholder="向站点主人索取"
          value={accessCode}
          onChange={(e) => setAccessCode(e.target.value)}
          disabled={pending}
        />
      </div>

      <div className="field">
        <label htmlFor="topic">
          题目 / 要求
          <span className="hint">
            选填，但填了才能判断是否切题。只写题干，上限 {MAX_TOPIC_CHARS} 字符
          </span>
        </label>
        <textarea
          id="topic"
          className="textarea textarea-short"
          placeholder="例如：Suppose you are a student who wants to join a volunteer program. Write a letter to the program organizer to apply for it. You should write at least 120 words."
          value={topic}
          onChange={(e) => {
            claimTyping();
            setTopic(e.target.value);
          }}
          maxLength={MAX_TOPIC_CHARS}
          disabled={pending}
        />
      </div>

      <div className="field">
        <label htmlFor="essay">
          作文正文
          <span className="hint">直接粘贴或手写，保留原始拼写和标点，批改会更准</span>
        </label>
        <textarea
          id="essay"
          className="textarea textarea-essay"
          placeholder="Paste your essay here..."
          value={essay}
          onChange={(e) => {
            claimTyping();
            setEssay(e.target.value);
          }}
          disabled={pending}
          spellCheck={false}
        />
      </div>

      <div className="field">
        <label htmlFor="target">
          目标档次
          <span className="hint">选填。选了之后升档建议会对着这个目标写</span>
        </label>
        <select
          id="target"
          className="select field-narrow"
          value={targetBandLevel}
          onChange={(e) => {
            claimTyping();
            setTargetBandLevel(e.target.value);
          }}
          disabled={pending}
        >
          <option value="">不指定，按上一档给建议</option>
          {[...BANDS]
            .filter((b) => b.level > 0)
            .reverse()
            .map((b) => (
              <option key={b.level} value={b.level}>
                {b.label}（{b.range[0]}–{b.range[1]} 分）
              </option>
            ))}
        </select>
      </div>

      <div className="sample-row">
        <span className="small muted sample-label">
          没有现成作文？试试：
        </span>
        {SAMPLE_ESSAYS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="btn"
            onClick={() => {
              // 点示例也算"动手"：用户已经明确要写别的了，旧草稿不再提供
              claimTyping();
              setEssay(s.text);
              setTopic(s.topic);
            }}
          >
            {s.label}
            <span className="muted sample-hint">
              {s.hint}
            </span>
          </button>
        ))}
      </div>

      <div className="form-footer">
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={pending || tooShort || !essay.trim()}
        >
          开始批改
        </button>

        <span className={`counter${essay && (wordCount < TARGET_MIN || wordCount > TARGET_MAX) ? " counter-warn" : ""}`}>
          {wordCount} 词
          {essay && wordCount < TARGET_MIN ? `（还差 ${TARGET_MIN - wordCount} 词）` : ""}
          {essay && wordCount > TARGET_MAX ? `（超过建议的 ${TARGET_MAX} 词）` : ""}
        </span>

        {essay && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setEssay("");
              reset();
            }}
          >
            清空
          </button>
        )}

        <span className="muted small form-note">
          通常 10 秒左右，长作文会更久
        </span>
      </div>
    </form>
  );
}
