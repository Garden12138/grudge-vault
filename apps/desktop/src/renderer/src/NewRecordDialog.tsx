import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from "react";
import type { PendingReview } from "@grudge-vault/domain";
import { codePointLength, RECORD_TEXT_LIMIT } from "@grudge-vault/shared";
import { ModelSettings } from "./ModelSettings";
import { Disclosure, Icon } from "./ui-components";
import { useModalFocus } from "./use-modal-focus";
import { useReadOnlySnapshot } from "./use-read-only-snapshot";
import { useRecordIntake } from "./use-record-intake";
import { mediaProgressLabel } from "./use-media-progress";
import { displayError, unwrap } from "./ui-errors";

const readModel = async () => unwrap(await window.grudgeVault.llm.getSettings());
const subscribe = (listener: () => void) => window.grudgeVault.jobs.onChanged(listener);

export function NewRecordDialog({ onClose, onSaved, onPendingChanged, reprovidePendingId, reprovideItem, onRescreenSettled }: {
  onClose(): void; onSaved(id: string): void; onPendingChanged(): void;
  reprovidePendingId?: string; reprovideItem?: PendingReview | undefined; onRescreenSettled(): void;
}) {
  const dialogRef = useModalFocus<globalThis.HTMLElement>();
  const [text, setText] = useState(""), [files, setFiles] = useState<File[]>([]);
  const [setupRequested, setSetupRequested] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const model = useReadOnlySnapshot(readModel, subscribe);
  const fresh = Boolean(model.value && !model.loading && !model.error);
  const enabled = Boolean(!model.error && model.value?.activeProvider && model.value.providers[model.value.activeProvider]?.status === "ready");

  const intake = useRecordIntake({ ...(reprovidePendingId ? { initialPendingId: reprovidePendingId } : {}), onSaved, onPendingChanged, onRescreenSettled });
  const { busy, submitting, release } = intake;
  const setup = setupRequested || (!enabled && !busy);
  const textLength = codePointLength(text), tooLong = textLength > RECORD_TEXT_LIMIT;
  const appendFiles = (incoming: File[]) => {
    if (submitting.current || !incoming.length) return;
    if (files.length + incoming.length > 20) { setAttachmentError("一次最多选择 20 个附件；本次选择未添加。"); return; }
    if (incoming.some(({ size }) => size > 500 * 1024 * 1024)) { setAttachmentError("单个附件不能超过 500 MB；本次选择未添加。"); return; }
    setAttachmentError(""); setFiles(previous => [...previous, ...incoming]); intake.resetFeedback();
  };
  const drop = (event: DragEvent) => { event.preventDefault(); appendFiles(Array.from(event.dataTransfer.files)); };
  const close = useCallback(async () => {
    if ((text.trim() || files.length) && !window.confirm("完整输入尚未正式保存。关闭后文字和所选附件无法恢复；待确认只保留短摘录。确定放弃吗？")) return;
    await release(); onClose();
  }, [text, files.length, release, onClose]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void close(); } };
    globalThis.addEventListener("keydown", escape); return () => globalThis.removeEventListener("keydown", escape);
  }, [close]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (tooLong || !enabled || setup) return; void intake.submit(text, files); };
  const showSetup = () => { setSetupRequested(true); void model.reload(); };
  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} tabIndex={-1} className="modal intake-modal" role="dialog" aria-modal="true" aria-labelledby="new-record-title">
    <header><div><p className="eyebrow">留下与你有关的重要事件</p><h2 id="new-record-title">{reprovidePendingId ? "补充待确认内容" : "新建记录"}</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => void close()}><Icon name="close" /></button></header>
    {setup ? <div className="intake-setup">
      <h3>{model.error ? "模型状态暂时不可用" : model.loading && !model.value ? "检查模型状态" : setupRequested && enabled ? "调整模型连接" : "先连接模型，再开始记录"}</h3><p className="muted">收录前需要判断是否与你的冲突、权益或安全有关。连接后不会自动提交内容。</p>
      {(text || files.length > 0) && <p className="banner neutral" role="status">你的文字和附件仍保留在当前编辑器中。</p>}
      {model.loading && <p role="status">正在读取模型设置…</p>}
      {model.error && <div className="banner error" role="alert">暂时无法读取模型设置：{displayError(model.error)}<button type="button" onClick={() => void model.reload()}>重新读取模型设置</button></div>}
      {model.value && <ModelSettings settings={model.value} fresh={fresh} embedded onChanged={async () => { await model.reload(); }} onConnected={() => { setSetupRequested(false); intake.resetFeedback(); }} />}
      {enabled && <button type="button" onClick={() => setSetupRequested(false)}>返回记录</button>}
    </div> : <form id="record-intake-form" onSubmit={submit}>
      <button className="text-button" type="button" disabled={busy} onClick={showSetup}>模型连接</button><p className="intake-explanation">只收录与你的冲突、权益或安全有关的具体事件。提交后可能收录、跳过，或请你确认。</p>
      {reprovidePendingId && <section className="pending-context" aria-label="待核对内容"><h3>待核对点</h3><p>{reprovideItem?.reason ?? "请写清具体发生了什么、与你的关系，以及你希望留存的事实。"}</p>{reprovideItem?.excerpt && <Disclosure title="查看原始摘录"><blockquote>{reprovideItem.excerpt}</blockquote></Disclosure>}<p className="muted">请写清具体经过，并添加需要留存的附件。通过判断后保存本次补充；原始摘录仅供参考，未提供的原文和附件不会自动恢复。{reprovideItem?.origin === "migration" && "旧修订和来源映射不会复制到本次补充。"}</p></section>}
      <label className="field">{reprovidePendingId ? "补充需核对的内容" : "发生了什么？"}<textarea autoFocus disabled={busy} value={text} aria-invalid={tooLong || undefined} aria-describedby={tooLong ? "record-text-count record-text-limit" : "record-text-count"} onPaste={(event) => appendFiles(Array.from(event.clipboardData.files).filter(({ type }) => type.startsWith("image/")))} onChange={(event) => { if (!submitting.current) { setText(event.target.value); intake.resetFeedback(); } }} placeholder={reprovidePendingId ? "针对待核对点，写清人物、具体行为、时间，以及与你的关系…" : "写下具体经过、相关人物和你记得的细节…"} /><small id="record-text-count">{textLength.toLocaleString()} / 50,000 字</small></label>
      {tooLong && <p id="record-text-limit" className="inline-warning" role="alert">文字不能超过 50,000 字，请缩短后再提交。输入未被截断。</p>}
      <label className="file-drop" onDragOver={event => event.preventDefault()} onDrop={drop}><span className="file-drop-title"><Icon name="plus" />添加或拖入图片、音频或视频</span><input type="file" aria-label="添加图片、音频或视频" multiple disabled={busy} accept="image/jpeg,image/png,image/webp,image/heic,audio/mpeg,audio/mp4,audio/wav,video/mp4,video/quicktime" onChange={(event) => { const incoming = Array.from(event.target.files ?? []); event.target.value = ""; appendFiles(incoming); }} /><span>也可粘贴图片 · 最多 20 个附件</span></label>
      {attachmentError && <p className="inline-warning" role="alert">{attachmentError}</p>}
      <Disclosure title="支持格式与大小限制"><p>本地文件可选择 JPEG、PNG、WebP、HEIC、MP3、M4A、WAV、MP4、MOV。单个附件不超过 500 MB；粘贴图片单张不超过 20 MB、合计不超过 64 MB。选择上限不代表模型能完整分析，具体兼容性以实际处理为准。</p></Disclosure>
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}<small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>{/\.(jpe?g|png|webp|heic)$/i.test(file.name) && file.size > 20 * 1024 * 1024 && <small className="attachment-error">超过图片模型输入上限，请压缩后重新选择。</small>}</span><button type="button" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => { if (!submitting.current) { setFiles(current => current.filter((_, at) => at !== index)); intake.resetFeedback(); } }}>移除</button></li>)}</ul>}
      {files.some(file => /\.(mp3|m4a|wav|mp4|mov)$/i.test(file.name) && (file.size > 7_000_000 || /\.m4a$/i.test(file.name))) && <p className="inline-warning" role="status">这些音视频需要 Mac 本机分段，并通过百炼 Omni 逐段理解，可能增加耗时和 API 费用；超限或格式不支持会明确失败，不会只看开头。</p>}
      {files.some(file => /\.(m4a|heic)$/i.test(file.name)) && <p className="inline-warning" role="status">M4A／HEIC 将转换为私有处理副本，可能有编码差异；原件不变。真实 API 兼容性仍待验证。</p>}
      {intake.message && <div className={`banner ${intake.state === "failed" ? "error" : "neutral"}`} role={intake.state === "failed" ? "alert" : "status"}>{intake.message}{intake.configurationError && <button type="button" onClick={showSetup}>修复模型连接</button>}</div>}
      {intake.state === "review" && <section className="inline-review" aria-label="当前记录待确认"><h3>是否收录这件事？</h3><p>{intake.pendingItem?.reason ?? "正在核对待确认状态…"}</p>
        {intake.pendingReadError && <div className="banner error" role="alert">{intake.pendingReadError}<button type="button" disabled={busy} onClick={() => void intake.readPending()}>重新读取待确认</button></div>}
        {intake.pendingItem && !intake.pendingItem.sessionAvailable && <p className="inline-warning">完整处理会话已失效。请核对当前全文和附件后重新判断，短摘录不会直接入库。</p>}
        <div className="review-actions"><button type="button" disabled={busy || !intake.pendingItem} onClick={async () => { if (await intake.resolve("ignore")) { setText(""); setFiles([]); } }}>不收录并清空</button><button type="button" disabled={busy} onClick={() => { intake.resetFeedback(); dialogRef.current?.querySelector("textarea")?.focus(); }}>补充后重新判断</button><button type="button" className="primary" disabled={busy || !intake.pendingItem?.sessionAvailable || Boolean(intake.pendingReadError)} onClick={() => void intake.resolve("keep")}>确认收录</button></div>
      </section>}
      {busy && <div className="stage-progress" aria-live="polite"><i /><span>{intake.progress ? mediaProgressLabel(intake.progress) : intake.state === "preparing" ? "正在检查格式和模型能力…" : intake.state === "review" ? "正在处理你的选择…" : "正在判断是否收录…"}</span></div>}
    </form>}
    <footer className="intake-footer"><p>完整输入只在内存中。关闭、锁定或退出后无法恢复。</p><div><button type="button" onClick={() => void close()}>取消</button>{!setup && intake.state !== "review" && <button form="record-intake-form" className="primary" disabled={busy || tooLong || (!text.trim() && files.length === 0)}>判断并收录</button>}</div></footer>
  </section></div>;
}
