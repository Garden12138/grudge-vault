import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Disclosure } from "./ui-components";
import { displayError, unwrap } from "./ui-errors";

export function WorkspacePasswordSettings() {
  const [configured, setConfigured] = useState<boolean>(), [current, setCurrent] = useState(""), [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState("");
  const [recovery, setRecovery] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const alive = useRef(true), running = useRef(false);
  const load = useCallback(async () => { try { const result = unwrap(await window.grudgeVault.workspace.passwordStatus()); if (alive.current) { setConfigured(result.configured); setError(""); } } catch (cause) { if (alive.current) setError(displayError(cause)); } }, []);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (running.current || configured === undefined) return;
    if (password !== confirmation) { setError("两次输入的新密码不同，请核对后再试。"); return; }
    const input = { ...(configured ? { currentPassword: current } : {}), newPassword: password };
    running.current = true; setBusy(true); setError(""); setMessage(""); setCurrent(""); setPassword(""); setConfirmation("");
    try { unwrap(await window.grudgeVault.workspace.setPassword(input)); if (alive.current) { setConfigured(true); setMessage("密码已保存。下次锁定或重新打开应用时，需要输入这个密码。"); } }
    catch (cause) { if (alive.current) setError(displayError(cause)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const exportRecovery = async () => {
    if (running.current) return;
    const passphrase = recovery; running.current = true; setBusy(true); setRecovery(""); setError(""); setMessage("");
    try { const result = unwrap(await window.grudgeVault.workspace.exportRecovery({ passphrase })); if (result && alive.current) setMessage("恢复包已保存，请和恢复口令一起妥善保管。"); }
    catch (cause) { if (alive.current) setError(displayError(cause)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="settings-card password-settings"><div className="settings-card-header"><div><h2>账本密码</h2><p>{configured === undefined ? "正在读取密码设置…" : configured ? "已设置密码，锁定后只有输入密码才能继续查看。" : "为记录加一把锁，离开电脑时更安心。"}</p></div></div><div className="settings-form">
    {error && <div className="banner error" role="alert">{error}</div>}{message && <div className="banner notice" role="status">{message}</div>}
    {configured === undefined ? <button onClick={() => void load()}>重新读取密码设置</button> : <form onSubmit={event => void save(event)}>
      {configured && <label className="field">当前密码<input type="password" autoComplete="current-password" maxLength={128} required disabled={busy} value={current} onChange={event => setCurrent(event.target.value)} /></label>}
      <div className="form-row"><label className="field">新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位" /></label><label className="field">确认新密码<input type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></div>
      <button className="primary" disabled={busy}>{busy ? "正在保存…" : configured ? "修改账本密码" : "设置账本密码"}</button>
    </form>}
    <Disclosure title="保留一种恢复方式"><p>请记住密码。如果担心忘记，可以导出恢复包。恢复口令应与账本密码不同，至少 12 位；恢复后需要重新设置账本密码。</p><label className="field">恢复口令<input type="password" autoComplete="new-password" value={recovery} maxLength={10000} disabled={busy} onChange={event => setRecovery(event.target.value)} /></label><button disabled={busy || recovery.length < 12} onClick={() => void exportRecovery()}>导出恢复包</button></Disclosure>
  </div></section>;
}
