import { useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkspaceLockState } from "@grudge-vault/domain";
import type { IpcResult } from "@grudge-vault/shared";
import { Disclosure, Icon } from "./ui-components";
import { displayError, unwrap, UiError } from "./ui-errors";

export function WorkspaceLanding({ status, onChanged }: { status: WorkspaceLockState; onChanged(): Promise<void> }) {
  const [name, setName] = useState("我的事件账本"), [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [recovery, setRecovery] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), running = useRef(false);
  const scope = status.status === "locked" ? status.workspaceId : "closed";
  const currentScope = useRef(scope);
  useEffect(() => {
    if (currentScope.current !== "closed" && currentScope.current !== scope) setError("");
    currentScope.current = scope; setPassword(""); setConfirmation(""); setRecovery("");
  }, [scope]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const locked = status.status === "locked", configured = locked && status.passwordConfigured;
  const run = async (action: () => Promise<IpcResult<unknown>>) => {
    if (running.current) return;
    const ownedScope = currentScope.current;
    running.current = true; setBusy(true); setError(""); setPassword(""); setConfirmation(""); setRecovery("");
    try { unwrap(await action()); if (alive.current && currentScope.current === ownedScope) await onChanged(); }
    catch (cause) {
      if (!alive.current || currentScope.current !== ownedScope) return;
      // Password-required is an instruction to show this screen, rather than a broken opening.
      if (!(cause instanceof UiError && cause.code === "WORKSPACE_PASSWORD_REQUIRED")) setError(displayError(cause));
      await onChanged().catch(() => {});
    } finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const unlock = (event: FormEvent) => {
    event.preventDefault();
    if (!configured && password !== confirmation) { setError("两次输入的密码不同，请核对后再试。"); return; }
    const input = configured ? { password } : { newPassword: password };
    void run(() => window.grudgeVault.workspace.unlock(input));
  };
  return <main className="landing">
    <section className={`landing-card${locked ? " locked-landing" : ""}`}>
      <div className="landing-emblem"><Icon name={locked ? "lock" : "record"} /></div>
      <p className="eyebrow">GRUDGE VAULT</p>
      <h1>{locked ? configured ? "欢迎回来" : "给账本加一把锁" : "把重要的事，留下依据"}</h1>
      <p className="lede">{locked ? configured ? "输入密码，继续查看你的记录。" : "设置一个你记得住的密码，以后回来就用它打开账本。" : "记下让你在意的冲突、权益和安全问题，整理经过，也留好凭据。"}</p>
      {locked ? <>
        <div className="workspace-summary"><strong>{status.workspaceName}</strong><span>你的记录已收好</span></div>
        <form className="unlock-form" onSubmit={unlock}>
          <label className="field">{configured ? "账本密码" : "设置账本密码"}<input type="password" autoComplete={configured ? "current-password" : "new-password"} required minLength={configured ? 1 : 8} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} placeholder={configured ? "输入你的密码" : "至少 8 位"} autoFocus /></label>
          {!configured && <label className="field">再输入一次密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="确认你记得这个密码" /></label>}
          {error && <div className="banner error" role="alert">{error}</div>}
          <button className="primary wide" disabled={busy}>{busy ? "正在打开…" : configured ? "打开账本" : "设置密码并打开账本"}</button>
        </form>
        {!configured && <button className="text-button skip-password" disabled={busy} onClick={() => void run(() => window.grudgeVault.workspace.unlock())}>暂时打开账本</button>}
        {configured && <Disclosure title="忘记密码？"><p>如果你保留了恢复包，可以用它打开账本，再设置新密码。没有恢复包时，应用无法找回原密码。</p><label className="field">恢复口令<input type="password" autoComplete="off" value={recovery} maxLength={10000} disabled={busy} onChange={event => setRecovery(event.target.value)} /></label><button disabled={busy || recovery.length < 12} onClick={() => { const passphrase = recovery; void run(() => window.grudgeVault.workspace.recover({ passphrase })); }}>选择恢复包并打开</button></Disclosure>}
      </> : <>
        {error && <div className="banner error" role="alert">{error}</div>}
        <label className="field">账本名称<input value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <div className="landing-actions"><button className="primary" disabled={busy || !name.trim()} onClick={() => void run(() => window.grudgeVault.workspace.create(name.trim()))}>创建账本</button><button disabled={busy} onClick={() => void run(() => window.grudgeVault.workspace.open())}>打开已有账本</button></div>
      </>}
      <Disclosure title="记录如何保护？" className="landing-privacy"><p>附件加密保存在这台电脑，正文和报告也留在本机。账本密码限制在应用中打开记录，不会将正文整库加密。使用模型功能时，相关内容会按你的设置发给模型服务商。</p></Disclosure>
    </section>
  </main>;
}
