import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { EventRecordDetail, RecordSupplementMessage, RecordSupplementReply, ReportClarification } from "@grudge-vault/domain";
import { Icon } from "./ui-components";
import { useModalFocus } from "./use-modal-focus";
import { occurrenceTimeLabel } from "./record-time";
import { displayError, unwrap } from "./ui-errors";

export function RecordSupplementDialog({ detail: initialDetail, onClose, onSaved }: {
  detail: EventRecordDetail; onClose(): void; onSaved(detail: EventRecordDetail): Promise<void>;
}) {
  const [detail] = useState(initialDetail);
  const dialogRef = useModalFocus<globalThis.HTMLElement>();
  const endRef = useRef<globalThis.HTMLDivElement>(null);
  const alive = useRef(true), inFlight = useRef(false);
  const [conversationId] = useState(() => globalThis.crypto.randomUUID());
  const [messages, setMessages] = useState<RecordSupplementMessage[]>([]);
  const [patch, setPatch] = useState<RecordSupplementReply["patch"]>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [retryMessages, setRetryMessages] = useState<RecordSupplementMessage[]>([]);
  const [savedDetail, setSavedDetail] = useState<EventRecordDetail>();
  const ask = useCallback(async (history: RecordSupplementMessage[]) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setRetryMessages(history);
    try {
      const reply = unwrap(await window.grudgeVault.records.supplement({ recordId: detail.record.id,
        expectedRevision: detail.record.revision, messages: history }));
      if (!alive.current) return;
      setMessages([...history, { role: "assistant", content: reply.message }]);
      // Each reply considers the whole conversation, including any corrections.
      setPatch(reply.patch);
    } catch (cause) {
      if (alive.current) {
        setError(displayError(cause)); setPatch({});
        if (history.length) setMessages([...history, { role: "assistant", content: "暂时没能继续追问。你可以接着说记得的细节，也可以先保存已有补充。" }]);
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }, [detail.record.id, detail.record.revision]);
  useEffect(() => { alive.current = true; void ask([]); return () => { alive.current = false; }; }, [ask]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "nearest" }); }, [messages, busy]);
  const answers = messages.filter(({ role }) => role === "user");
  const close = useCallback(() => {
    if (!savedDetail && (draft.trim() || answers.length) && !window.confirm("这次对话补充还没保存，确定放弃吗？")) return;
    onClose();
  }, [answers.length, draft, onClose, savedDetail]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); if (!saving) close(); }
    };
    globalThis.addEventListener("keydown", escape);
    return () => globalThis.removeEventListener("keydown", escape);
  }, [close, saving]);
  const previousValue = detail.overrides.find(({ fieldKey }) => fieldKey === "clarifications")?.value;
  const previous: ReportClarification[] = Array.isArray(previousValue) ? previousValue : [];
  const supplements = (history: RecordSupplementMessage[]): ReportClarification[] => history.flatMap((message, index) => message.role !== "user" ? [] : [{
    kind: "unknown", topic: `对话补充 ${conversationId} · ${index}: ${history[index - 1]?.content ?? "补充经过"}`.slice(0, 1_000), response: message.content
  }]);
  const proposedHistory: RecordSupplementMessage[] = [...(messages.length ? messages : [{ role: "assistant" as const, content: `关于“${detail.record.title}”，你想补充当天的哪一段经过？` }]),
    { role: "user", content: draft.trim() }];
  const proposed = [...previous, ...supplements(proposedHistory)];
  const capacityExceeded = proposed.length > 100 || proposed.reduce((total, { topic, response }) => total + topic.length + response.length, 0) > 50_000;
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (busy || saving || inFlight.current || !draft.trim() || draft.length > 2_000 || answers.length >= 20 || savedDetail || capacityExceeded) return;
    setMessages(proposedHistory); setDraft(""); dialogRef.current?.querySelector("textarea")?.focus(); void ask(proposedHistory);
  };
  const save = async () => {
    if (saving || busy || !answers.length || draft.trim()) return;
    setSaving(true); setError("");
    try {
      let updated = savedDetail;
      if (!updated) {
        const clarifications = [...previous, ...supplements(messages)];
        updated = unwrap(await window.grudgeVault.records.patchFields({ recordId: detail.record.id,
          expectedRevision: detail.record.revision, patch: { ...patch, clarifications } }));
        if (!alive.current) return;
        setSavedDetail(updated);
      }
      unwrap(await window.grudgeVault.records.reanalyze(updated.record.id, updated.record.revision));
      if (alive.current) await onSaved(updated);
    } catch (cause) { if (alive.current) setError(displayError(cause)); }
    finally { if (alive.current) setSaving(false); }
  };
  const changes = [patch.title && `标题：${patch.title}`, patch.occurredAt && `时间：${occurrenceTimeLabel({ occurredAt: patch.occurredAt, recordedAt: detail.record.recordedAt })}`,
    patch.location && `地点：${patch.location}`, patch.jurisdiction && `法律地域：${patch.jurisdiction}`].filter(Boolean);
  return <div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className="modal supplement-dialog" role="dialog" aria-modal="true" aria-labelledby="supplement-title">
    <header><div><p className="eyebrow">聊一聊，把当天的事情补清楚</p><h2 id="supplement-title">对话补充</h2><p className="supplement-record-title">{detail.record.title}</p></div><button className="icon-button" aria-label="关闭补充对话" disabled={saving} onClick={close}><Icon name="close" /></button></header>
    <div className="supplement-messages" role="log" aria-label="补充对话" aria-live="polite">
      {messages.map((message, index) => <article className={`supplement-message ${message.role}`} key={index}><span>{message.role === "assistant" ? "记录助手" : "你"}</span><p>{message.content}</p></article>)}
      {busy && <p role="status" className="muted">{messages.length ? "正在结合你的回答想一想…" : "正在回看当天的记录，准备具体问题…"}</p>}
      {!messages.length && !busy && <p>关于“{detail.record.title}”，你想补充当天的哪一段经过？可以直接在下面说。</p>}
      <div ref={endRef} />
    </div>
    {error && <div className="banner error" role="alert">{savedDetail ? "补充已保存，报告更新尚未启动。" : "你的输入仍保留在当前对话中。"} {error}{!savedDetail && !busy && <button disabled={saving} onClick={() => void ask(retryMessages)}>重新提问</button>}</div>}
    {changes.length > 0 && <p className="supplement-changes">保存时同步更新：{changes.join("；")}</p>}
    {savedDetail ? <p className="supplement-hint" role="status">补充已保存，可重试更新报告或关闭对话。</p> : <form className="supplement-composer" onSubmit={send}>
      <label htmlFor="supplement-answer">你的补充</label><textarea id="supplement-answer" autoFocus value={draft} disabled={saving} aria-invalid={draft.length > 2_000 || undefined}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
        onChange={(event) => setDraft(event.target.value)} placeholder="像聊天一样回答，也可以说记不清、跳过，或直接纠正记录中的内容。" />
      <div><small>{draft.length > 2_000 ? "每次最多 2,000 字，请分几次说。" : capacityExceeded ? "这条记录的补充空间不足，请缩短本次回答；已有对话仍可保存。" : answers.length >= 20 ? "这次先保存，再继续补充。" : "不必全部回答，记得多少说多少。"}</small><button className="primary" disabled={busy || saving || !draft.trim() || draft.length > 2_000 || answers.length >= 20 || capacityExceeded}>发送</button></div>
    </form>}
    <footer className="supplement-footer"><p>{draft.trim() ? "先发送这段话，再保存补充。" : "保存后会保留你的原话，并更新事件报告。"}</p><button className="primary" disabled={busy || saving || !answers.length || Boolean(draft.trim())} onClick={() => void save()}>{saving ? "正在保存并更新…" : savedDetail ? "重试更新报告" : "保存补充并更新报告"}</button></footer>
  </section></div>;
}
