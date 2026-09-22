"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { clearAccessCode, loadAccessCode, saveAccessCode } from "@/lib/store";

/**
 * 口令页的表单。
 *
 * ## 为什么校验要发一次请求，而不是"记下来就放行"
 *
 * 前端没法自己判断口令对不对（服务端的口令是环境变量，浏览器里没有它的副本，
 * 也不该有）。所以这里必须问一次服务端——`POST /api/access`。这一问不调模型、
 * 不占批改配额，但**走的是同一套防爆破路径**（错口令记失败、按档位上锁、人为拖慢），
 * 细节在那个路由的头注释里。
 *
 * ## 失败时为什么要把记住的口令删掉
 *
 * 记住的口令只可能是**验过之后**才写进去的（见下面 verify）。所以一条验不过的
 * 口令只有两种来源：站长轮换了口令，或者存储被人手改过。两种情况下留着它都是纯坏处——
 * 下次进这一页会自动拿它去验证，白等一轮，还平白多记一次失败。
 */
export function AccessGateForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  /** 正在自动验证这个浏览器上记住的口令（那一小会儿不摆表单，免得闪一下） */
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 自动验证只跑一次。effect 在 React 严格模式下会跑两遍，不挡住就会发两次请求，
  // 平白多记一次失败计数
  const autoTried = useRef(false);

  const verify = async (value: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessCode: value }),
      });

      if (res.ok) {
        // **只有验过了才记住**。反过来（先存后验）会让一个错的值在下次访问时
        // 被自动送上去验，而且还顺带记一次失败
        saveAccessCode(value);
        // replace 而不是 push：口令页再按退格回到这一页没有意义，
        // 那时它只会自动验证一次然后把人送回去
        router.replace("/review");
        return;
      }

      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      clearAccessCode();
      setError(data?.error ?? `验证没有通过（HTTP ${res.status}）。`);
    } catch {
      // 网络层的失败**不能**当成"口令不对"：这两件事用户要做的事完全不同
      setError("连不上服务器。检查一下网络，或者确认服务端还在跑，然后再试。");
    } finally {
      setBusy(false);
      setChecking(false);
    }
  };

  useEffect(() => {
    if (autoTried.current) return;
    autoTried.current = true;
    const saved = loadAccessCode();
    if (!saved) return;
    setCode(saved);
    setChecking(true);
    void verify(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次，理由见上面的 autoTried
  }, []);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    void verify(code.trim());
  };

  if (checking) {
    return (
      <div className="card">
        <p className="muted">正在验证这个浏览器上记住的口令…</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="card">
      {error && (
        <div className="alert alert-error">
          <strong>进不去</strong>
          {error}
        </div>
      )}

      <div className="field">
        <label htmlFor="gate-code">
          访问口令
          <span className="hint">向站点主人索取。验过之后会记在这个浏览器上，下次不用再输</span>
        </label>
        <input
          id="gate-code"
          className="input"
          type="password"
          autoComplete="off"
          autoFocus
          placeholder="输入口令"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="form-footer">
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !code.trim()}>
          {busy ? "验证中…" : "进去批改"}
        </button>
        <span className="muted small form-note">
          口令只是为了拦住随手扫到站点的人，别当成账号
        </span>
      </div>
    </form>
  );
}
