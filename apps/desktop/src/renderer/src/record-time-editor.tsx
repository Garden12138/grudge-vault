import { useId, useState, type FormEvent } from "react";
import type { TemporalValue } from "@grudge-vault/domain";
import { timeEditorDraft, timeEditorValue, type TimeEditorDraft } from "./record-time-input";

export function RecordTimeEditor({ initialValue, busy = false, onSave, onCancel }: {
  initialValue?: TemporalValue;
  busy?: boolean;
  onSave(value: TemporalValue): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(() => timeEditorDraft(initialValue));
  const [edited, setEdited] = useState(false);
  const id = useId();
  const result = timeEditorValue(draft);
  const update = (patch: Partial<TimeEditorDraft>) => { setDraft((current) => ({ ...current, ...patch })); setEdited(true); };
  const submit = (event: FormEvent) => {
    event.preventDefault(); setEdited(true);
    if (!busy && result.value) void onSave(result.value);
  };
  const describedBy = `${id}-help${edited && result.error ? ` ${id}-error` : ""}`;
  return <form className="inline-editor time-editor" onSubmit={submit} aria-label="补充发生时间">
    <label>时间填写方式<select autoFocus aria-label="时间填写方式" disabled={busy} value={draft.kind}
      onChange={(event) => update({ kind: event.target.value as TemporalValue["kind"] })}>
      <option value="date">记得具体日期</option><option value="month">只记得月份</option>
      <option value="range">记得时间范围</option><option value="relative">大约／相对时间描述</option>
      <option value="instant">记得具体时刻（含时区）</option><option value="unknown">尚不确定／清除已填时间</option>
    </select></label>
    {(draft.kind === "date" || draft.kind === "month" || draft.kind === "instant") && <label>
      {draft.kind === "date" ? "发生日期" : draft.kind === "month" ? "发生月份" : "具体时刻（含时区）"}
      <input type={draft.kind === "date" ? "date" : draft.kind === "month" ? "month" : "text"}
        aria-label={draft.kind === "date" ? "发生日期" : draft.kind === "month" ? "发生月份" : "具体时刻（含时区）"}
        aria-describedby={describedBy} aria-invalid={edited && Boolean(result.error) || undefined}
        disabled={busy} value={draft.value} placeholder={draft.kind === "instant" ? "2026-10-02T15:30:00+08:00" : undefined}
        onChange={(event) => update({ value: event.target.value })} />
    </label>}
    {draft.kind === "range" && <div className="time-range-fields">
      <label>范围起点<input aria-label="范围起点" aria-describedby={describedBy} disabled={busy} value={draft.from}
        placeholder="例如 2026-09 或上周一；也可留空" onChange={(event) => update({ from: event.target.value })} /></label>
      <label>范围终点<input aria-label="范围终点" aria-describedby={describedBy} disabled={busy} value={draft.to}
        placeholder="例如 2026-10 或上周三；也可留空" onChange={(event) => update({ to: event.target.value })} /></label>
    </div>}
    {draft.kind === "relative" && <label>时间描述<input aria-label="时间描述" aria-describedby={describedBy}
      aria-invalid={edited && Boolean(result.error) || undefined} disabled={busy} value={draft.text}
      placeholder="例如：大约上周，具体日期记不清" onChange={(event) => update({ text: event.target.value })} /></label>}
    <small id={`${id}-help`}>{draft.kind === "unknown" ? "保存后保持待补充；重新分析不会用旧 AI 日期替代你的“不确定”。"
      : "只填写确实记得的精度。自然语言不自动推算日期；范围可留空一端，具体时刻的时区偏移会转换为同一 UTC 时刻。"}</small>
    {edited && result.error && <p className="time-editor-error" id={`${id}-error`} role="alert">{result.error}</p>}
    <div className="time-editor-actions"><button className="primary" disabled={busy || !result.value}>保存</button>
      <button type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}
