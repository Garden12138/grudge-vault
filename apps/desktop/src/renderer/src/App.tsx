import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Asset, EventCategory, EventRecord, EventRecordDetail, PendingReview,
  RecordOrigin, RecordSearchHit, RecordSearchPage, RecordSearchQuery, ReportClarification, SourceAnchor, TimelineFilter,
  WorkspaceSecuritySettings, TemporalValue
} from "@grudge-vault/domain";
import { codePointLength, RECORD_QUERY_TEXT_LIMIT } from "@grudge-vault/shared";
import { mediaAnchorSeek } from "./media-anchor";
import { ModelSettings } from "./ModelSettings";
import { NewRecordDialog } from "./NewRecordDialog";
import { Disclosure, Icon } from "./ui-components";
import { unwrap, displayError, UiError } from "./ui-errors";
import { useRecordSelection, type RecordDetailAccess } from "./use-record-selection";
import { mediaProgressLabel, useMediaProgress, type MediaProgressSubscription } from "./use-media-progress";
import { useAttachmentPreview } from "./use-attachment-preview";
import { useModalFocus } from "./use-modal-focus";
import { useSearchIndexCheckRefresh } from "./use-search-index-check";
import { useWorkspaceSession, type WorkspaceSessionAccess } from "./use-workspace-session";
import { useTimelineRecords, type TimelineAccess } from "./use-timeline-records";
import { useReadOnlySnapshot } from "./use-read-only-snapshot";
import { dayOneImportActive, dayOneImportPhaseLabel, dayOneImportProgressLabel, dayOneImportSummaryLabel, dayOneImportUsageLabel, useDayOneImportProgress } from "./use-dayone-import-progress";
import { dayOneImportEndTimeLabel, dayOneImportReceiptLabel, useDayOneImportReceipt } from "./use-dayone-import-receipt";
import { ReportField, ReportPeopleField, ReportTimeField } from "./report-fields";
import { CitationCard } from "./legal-citation";
import { occurrenceTimeLabel, recordTimeSourceLabel, temporalLabel } from "./record-time";
import { searchCoverageMessage, searchIndexIncomplete } from "./search-coverage";
import { RecordTimeEditor } from "./record-time-editor";
import { WorkspaceLanding } from "./WorkspaceLanding";
import { WorkspacePasswordSettings } from "./WorkspacePasswordSettings";
import { TimelineRail, RecordStatus } from "./TimelineRail";

type MainView = "timeline" | "search" | "settings";
type SettingsGroup = "model" | "import" | "privacy";
const READ_DAYONE_RECEIPT = async () => unwrap(await window.grudgeVault.intake.lastDayOneImportReceipt());
const READ_SEARCH_INDEX_STATUS = async () => unwrap(await window.grudgeVault.records.searchIndexStatus());
const READ_TIMELINE_PRESENCE = async () => unwrap(await window.grudgeVault.records.timeline({ limit: 1 }));
const READ_MODEL_SETTINGS = async () => unwrap(await window.grudgeVault.llm.getSettings());
const READ_DEFAULT_JURISDICTION = async () => unwrap(await window.grudgeVault.legal.getDefaultJurisdiction());
const SUBSCRIBE_JOB_READS = (listener: () => void) => window.grudgeVault.jobs.onChanged(listener);
const NO_STATUS_PUBLICATION = () => {};

const CATEGORY_LABEL: Record<EventCategory, string> = { grudge: "冲突", rights: "权益", danger: "危险" };
const ORIGIN_LABEL: Record<RecordOrigin, string> = { manual: "手动记录", dayone: "Day One", zip: "ZIP 导入", migration: "旧数据迁移" };
const RECORD_DETAIL_ACCESS: RecordDetailAccess = {
  read: async (id) => unwrap(await window.grudgeVault.records.get(id)),
  subscribe: (listener) => window.grudgeVault.jobs.onChanged(listener)
};
const TIMELINE_ACCESS: TimelineAccess = {
  read: async (filter) => unwrap(await window.grudgeVault.records.timeline(filter)),
  subscribe: (listener) => window.grudgeVault.jobs.onChanged(listener)
};
const SEARCH_PROGRESS: MediaProgressSubscription = (listener) => window.grudgeVault.records.onSearchMediaProgress(listener);
const READ_DAYONE_PROGRESS = async () => unwrap(await window.grudgeVault.intake.dayOneImportProgress());
const WORKSPACE_SESSION_ACCESS: WorkspaceSessionAccess = {
  status: async () => unwrap(await window.grudgeVault.workspace.status()),
  pending: async () => unwrap(await window.grudgeVault.pending.list()),
  onLocked: (listener) => window.grudgeVault.workspace.onLocked(listener)
};

function searchIndexFailureMessage(code: string): string {
  if (code === "MODALITY_UNAVAILABLE") return "索引中有当前向量模型无法处理或超过大小限制的附件；请检查后重建。";
  if (code === "MODEL_NOT_CONFIGURED" || code === "LLM_AUTHENTICATION_FAILED" || code === "LLM_REGION_MISMATCH") {
    return "索引构建失败：请检查百炼连接、密钥和地域后重试。";
  }
  if (code === "JOB_STATE_CONFLICT") return "索引构建已暂停；恢复后可以重新建立。";
  return "索引构建失败。请检查模型连接与正式附件后重试；持续失败时可暂时使用关键词搜索。";
}

function RecordCard({ record, selected, onOpen, timeZone }: { record: EventRecord; selected: boolean; onOpen(): void; timeZone?: string | undefined }) {
  return <button className={`record-card${selected ? " selected" : ""}`} onClick={onOpen}>
    <div className="record-card-top"><span>{temporalLabel(record, timeZone)}{recordTimeSourceLabel(record) &&
      <small className="record-time-source" title="时间来源不等于事实已核实">{recordTimeSourceLabel(record)}</small>}</span><RecordStatus record={record} /></div>
    <strong>{record.title}</strong><p>{record.summary || "报告正在生成"}</p>
    <div className="chips">
      {record.categories.map((category) => <span className={`chip chip-${category}`} key={category}>{CATEGORY_LABEL[category]}</span>)}
      <span className="chip subtle">{ORIGIN_LABEL[record.origin]}</span>
      {record.attachmentCount > 0 && <span className="chip subtle">{record.attachmentCount} 个媒体</span>}
    </div>
  </button>;
}

function EmptyTimeline({ onNew, onSettings }: { onNew(): void; onSettings(): void }) {
  return <section className="empty-state">
    <div className="empty-icon"><Icon name="record" /></div><h2>还没有正式记录</h2>
    <p>新建一条记录，或导入 Day One 的 JSON 导出包。只有通过筛选的事件会出现在这里。</p>
    <div><button className="primary" onClick={onNew}>新建记录</button><button onClick={onSettings}>导入 Day One</button></div>
  </section>;
}

function reportClarifications(value: unknown): ReportClarification[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ReportClarification => Boolean(item) && typeof item === "object" &&
    (item.kind === "unknown" || item.kind === "dispute" || item.kind === "speculation") && typeof item.topic === "string" &&
    typeof item.response === "string");
}

function AnchoredSource({ text, anchor }: { text: string; anchor?: SourceAnchor }) {
  if (!anchor?.textRange) return <pre>{text}</pre>;
  const points = Array.from(text);
  const [start, end] = anchor.textRange;
  return <pre>{points.slice(0, start).join("")}<mark>{points.slice(start, end).join("")}</mark>{points.slice(end).join("")}</pre>;
}

export function AttachmentItem({ asset, anchor }: { asset: Asset; anchor?: SourceAnchor }) {
  const { url: previewUrl, busy, error, converted: convertedPreview, toggle: togglePreview, setError, setBusy, pendingMedia } =
    useAttachmentPreview(asset.id, asset.mimeType, unwrap, displayError);
  const [anchorWarning, setAnchorWarning] = useState("");
  const mediaElement = useRef<globalThis.HTMLMediaElement>(null);
  const autoOpenedAnchor = useRef("");
  const preview = useCallback(async () => {
    setAnchorWarning("");
    if (previewUrl && mediaElement.current) { mediaElement.current.pause(); mediaElement.current.removeAttribute("src"); mediaElement.current.load(); }
    await togglePreview();
  }, [previewUrl, togglePreview]);
  const exportCopy = async () => {
    setBusy(true); setError("");
    try { unwrap(await window.grudgeVault.assets.exportCopy(asset.id)); }
    catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const highlighted = anchor?.assetId === asset.id;
  const seekToAnchor = useCallback((element: globalThis.HTMLMediaElement) => {
    if (!highlighted || !anchor) { setAnchorWarning(""); return; }
    const position = mediaAnchorSeek(anchor, element.duration);
    setAnchorWarning(position.invalid ? "模型建议定位超出原件时长或区间无效，已回到原件起点；请核对原件。" : "");
    if (position.positionSeconds === undefined) return;
    try { element.currentTime = position.positionSeconds; }
    catch { setAnchorWarning("无法跳转到模型建议位置；请手动播放并核对原件。"); }
  }, [anchor, highlighted]);
  useEffect(() => {
    if (!highlighted || !/^(audio|video)\//.test(asset.mimeType) || previewUrl || busy) return;
    const key = `${asset.id}:${anchor.intervalMs?.join("-") ?? anchor.frameTimeMs ?? "start"}`;
    if (autoOpenedAnchor.current === key) return;
    autoOpenedAnchor.current = key;
    void preview();
  }, [anchor, asset.id, asset.mimeType, busy, highlighted, preview, previewUrl]);
  useEffect(() => {
    if (previewUrl && mediaElement.current?.readyState) seekToAnchor(mediaElement.current);
  }, [previewUrl, seekToAnchor]);
  return <li className={highlighted ? "anchored-asset" : ""}>
    <div className="attachment-row"><div><strong>{asset.originalFileName}</strong><span>{asset.mimeType} · {(asset.byteSize / 1024 / 1024).toFixed(1)} MB{highlighted && anchor?.intervalMs ? ` · 模型建议位置 ${(anchor.intervalMs[0] / 1000).toFixed(1)}–${(anchor.intervalMs[1] / 1000).toFixed(1)} 秒，请核对原件` : ""}</span></div><div className="attachment-actions"><button disabled={busy && !pendingMedia} onClick={() => void preview()}>{pendingMedia ? "取消预览" : previewUrl ? "关闭预览" : "预览"}</button><button disabled={busy} onClick={() => void exportCopy()}>保存副本</button></div></div>
    {pendingMedia && <p role="status">正在认证私有原件预览副本…</p>}
    {error && <p className="attachment-error" role="alert">{error}</p>}
    {anchorWarning && <p className="verification-pending" role="status">{anchorWarning}</p>}
    {previewUrl && <div className="attachment-preview">
      {convertedPreview && <p className="verification-pending" role="status">HEIC 转换预览：保留完整尺寸并应用照片方向；转换副本可能有编码差异。“保存副本”仍导出原始 HEIC。</p>}
      {asset.mimeType.startsWith("image/") && <img src={previewUrl} alt={`${asset.originalFileName} ${convertedPreview ? "转换预览" : "原件预览"}`} onError={() => setError("当前环境无法显示这个图片原件；可保存副本后查看。")} />}
      {asset.mimeType.startsWith("audio/") && <audio ref={(element) => { mediaElement.current = element; }} controls preload="metadata" src={previewUrl} onLoadedMetadata={(event) => seekToAnchor(event.currentTarget)} onError={() => setError("当前环境无法播放这个音频原件；可保存副本后用系统播放器核对。")}>当前环境无法播放这个音频。</audio>}
      {asset.mimeType.startsWith("video/") && <video ref={(element) => { mediaElement.current = element; }} controls preload="metadata" src={previewUrl} onLoadedMetadata={(event) => seekToAnchor(event.currentTarget)} onError={() => setError("当前环境无法播放这个视频原件；可保存副本后用系统播放器核对。")}>当前环境无法播放这个视频。</video>}
    </div>}
  </li>;
}

function recordAnchorTab(anchor: SourceAnchor | undefined): "report" | "source" {
  return anchor && ["record", "report", "user"].includes(anchor.surface ?? "") ? "report" : "source";
}

export function RecordDetail({ detail, onBack, onReload, sourceAnchor, refreshError, timeZone, backLabel = "返回时间线" }: {
  detail: EventRecordDetail;
  onBack(): void;
  onReload(detail?: EventRecordDetail): Promise<void>;
  sourceAnchor?: SourceAnchor;
  refreshError?: string;
  backLabel?: string;
  timeZone?: string | undefined;
}) {
  const [tab, setTab] = useState<"report" | "source">(sourceAnchor ? recordAnchorTab(sourceAnchor) : "report");
  const [activeAnchor, setActiveAnchor] = useState<SourceAnchor | undefined>(sourceAnchor);
  const [editField, setEditField] = useState<"title" | "occurredAt" | "location" | "jurisdiction" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [defaultJurisdiction, setDefaultJurisdiction] = useState("中国大陆");
  const [activeAnalysisJobId, setActiveAnalysisJobId] = useState<string>();
  const [analysisProgress, setAnalysisProgress] = useState<number>();
  const [clarificationEditor, setClarificationEditor] = useState<{ kind: ReportClarification["kind"]; topic: string }>();
  const [clarificationValue, setClarificationValue] = useState("");
  const { record, report } = detail;
  const reportMatchesCurrentRevision = report?.recordRevision === record.revision;
  useEffect(() => {
    if (sourceAnchor) { setActiveAnchor(sourceAnchor); setTab(recordAnchorTab(sourceAnchor)); }
  }, [sourceAnchor]);
  useEffect(() => { void window.grudgeVault.legal.getDefaultJurisdiction().then((result) => {
    if (result.ok) setDefaultJurisdiction(result.data);
  }); }, []);
  useEffect(() => {
    if (record.reportState !== "queued" && record.reportState !== "running") {
      setActiveAnalysisJobId(undefined);
      setAnalysisProgress(undefined);
      return;
    }
    let disposed = false;
    let latestRequest = 0;
    const refresh = async () => {
      const request = ++latestRequest;
      const result = await window.grudgeVault.jobs.list();
      if (disposed || request !== latestRequest) return;
      const current = result.ok ? result.data.find((job) => job.type === "record.analyze" &&
        (job.state === "queued" || job.state === "running") &&
        (job.payload as { recordId?: string; recordRevision?: number }).recordId === record.id &&
        (job.payload as { recordRevision?: number }).recordRevision === record.revision) : undefined;
      setActiveAnalysisJobId(current?.id); setAnalysisProgress(current?.progress);
    };
    void refresh();
    const unsubscribe = window.grudgeVault.jobs.onChanged(() => { void refresh(); });
    return () => { disposed = true; unsubscribe(); };
  }, [record.id, record.revision, record.reportState]);
  const locationOverride = detail.overrides.find(({ fieldKey }) => fieldKey === "location");
  const jurisdictionOverride = detail.overrides.find(({ fieldKey }) => fieldKey === "jurisdiction");
  const occurredAtOverride = detail.overrides.find(({ fieldKey }) => fieldKey === "occurredAt");
  const clarifications = reportClarifications(detail.overrides.find(({ fieldKey }) => fieldKey === "clarifications")?.value);
  const visibleClarificationKeys = new Set([
    ...(report?.content.unknowns ?? []).map((topic) => `unknown\0${topic}`),
    ...(report?.content.disputes ?? []).map((topic) => `dispute\0${topic}`),
    ...(report?.content.speculations ?? []).map((topic) => `speculation\0${topic}`)
  ]);
  const unmatchedClarifications = clarifications.filter(({ kind, topic }) => !visibleClarificationKeys.has(`${kind}\0${topic}`));
  const beginEdit = (field: NonNullable<typeof editField>, value = "") => { setEditField(field); setEditValue(value); };
  const saveField = async () => {
    if (!editField || editField === "occurredAt" || !editValue.trim()) return;
    setBusy(true); setError("");
    try {
      const value = editValue.trim();
      const updated = unwrap(await window.grudgeVault.records.patchFields({
        recordId: record.id, expectedRevision: record.revision, patch: { [editField]: value }
      }));
      setEditField(null); setEditValue(""); await onReload(updated);
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const saveTime = async (value: TemporalValue) => {
    setBusy(true); setError("");
    try {
      const updated = unwrap(await window.grudgeVault.records.patchFields({ recordId: record.id,
        expectedRevision: record.revision, patch: { occurredAt: value } }));
      setEditField(null); await onReload(updated);
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const reanalyze = async () => {
    setBusy(true); setError("");
    try { unwrap(await window.grudgeVault.records.reanalyze(record.id, record.revision)); await onReload(); }
    catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const cancelAnalysis = async () => {
    if (!activeAnalysisJobId) return;
    setBusy(true); setError("");
    try {
      unwrap(await window.grudgeVault.jobs.cancel(activeAnalysisJobId));
      setActiveAnalysisJobId(undefined);
      await onReload();
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const saveClarification = async () => {
    if (!clarificationEditor || !clarificationValue.trim()) return;
    setBusy(true); setError("");
    try {
      const { kind, topic } = clarificationEditor;
      const next: ReportClarification[] = clarifications.filter((item) => item.kind !== kind || item.topic !== topic);
      next.push({ kind, topic, response: clarificationValue.trim() });
      const updated = unwrap(await window.grudgeVault.records.patchFields({
        recordId: record.id, expectedRevision: record.revision, patch: { clarifications: next }
      }));
      setClarificationEditor(undefined); setClarificationValue("");
      await onReload(updated);
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  const editClarification = (kind: ReportClarification["kind"], topic: string) => {
    setClarificationEditor({ kind, topic });
    setClarificationValue(clarifications.find((item) => item.kind === kind && item.topic === topic)?.response ?? "");
  };
  const issueItems = (kind: ReportClarification["kind"], topics: string[]) => topics.map((topic, index) => {
    const response = clarifications.find((item) => item.kind === kind && item.topic === topic)?.response;
    return <li key={`${kind}-${index}`}><span>{topic}</span>
      {response && <p className="clarification-response">你已补充（用户陈述，待核对）：{response}</p>}
      <button className="text-button" disabled={busy} onClick={() => editClarification(kind, topic)}>{response ? "修改此项补充" : "补充此项"}</button>
    </li>;
  });
  const openCitation = async (url: string) => {
    setError("");
    try { unwrap(await window.grudgeVault.external.open(url)); }
    catch (cause) { setError(displayError(cause)); }
  };
  const fieldEditor = (field: NonNullable<typeof editField>) => editField !== field ? null : <div className="inline-editor supplement">
    {field === "occurredAt" ? <RecordTimeEditor initialValue={record.occurredAt} busy={busy} onSave={saveTime} onCancel={() => setEditField(null)} /> : <><input aria-label={field === "title" ? "编辑标题" : field === "location" ? "编辑地点" : "编辑法域"} autoFocus type="text" value={editValue} placeholder={field === "title" ? "输入标题" : field === "location" ? "输入明确地点" : "输入适用法域"} onChange={(event) => setEditValue(event.target.value)} /><button className="primary" disabled={busy || !editValue.trim()} onClick={() => void saveField()}>保存</button><button disabled={busy} onClick={() => setEditField(null)}>取消</button></>}
  </div>;
  const clarificationForm = clarificationEditor && <div className="inline-editor clarification-editor"><label>针对“{clarificationEditor.topic}”的补充说明<textarea autoFocus maxLength={2_000} value={clarificationValue} onChange={(event) => setClarificationValue(event.target.value)} /></label><button className="primary" disabled={busy || !clarificationValue.trim()} onClick={() => void saveClarification()}>保存补充</button><button disabled={busy} onClick={() => setClarificationEditor(undefined)}>取消</button></div>;
  return <section className="detail-panel">
    <header className="detail-header">
      <button className="text-button" onClick={onBack}>← {backLabel}</button>
      <div><div className="chips">{record.categories.map((category) => <span className={`chip chip-${category}`} key={category}>{CATEGORY_LABEL[category]}</span>)}</div><h2>{record.title}</h2><p>{temporalLabel(record, timeZone)} · {ORIGIN_LABEL[record.origin]}{recordTimeSourceLabel(record) &&
        <small className="record-time-source" title="时间来源不等于事实已核实">{recordTimeSourceLabel(record)}</small>}</p><button className="text-button" disabled={busy} onClick={() => beginEdit("title", record.title)}>编辑标题</button>{fieldEditor("title")}</div>
      <RecordStatus record={record} />
    </header>
    {error && <div className="banner error" role="alert">{error}</div>}
    {refreshError && <div className="banner error" role="alert">无法载入最新记录状态：{refreshError} 当前保留上次成功读取的内容。<button disabled={busy} onClick={() => void onReload()}>重新载入</button></div>}
    {record.sourceReviewRequired && <div className="banner neutral" role="status">导入来源出现尚未收录的新版本，请核对。当前原文和报告仍对应已收录的旧版本；重新分析旧版本不会消除这项提醒。</div>}
    {activeAnalysisJobId && analysisProgress !== undefined && <p className="muted" role="status">报告任务进度 {Math.round(analysisProgress * 100)}%（处理进度，不代表全部媒体已检查）。</p>}
    <div className="segmented" role="tablist"><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>事件报告</button><button className={tab === "source" ? "active" : ""} onClick={() => setTab("source")}>原始内容</button></div>
    {tab === "source" ? <div className="source-view">
      <h3>原始文字</h3><AnchoredSource text={detail.source.text || "这条记录只有媒体原件。"} {...(activeAnchor ? { anchor: activeAnchor } : {})} />
      <h3>原件</h3>{detail.attachments.length ? <ul>{detail.attachments.map((asset) => <AttachmentItem asset={asset} {...(activeAnchor ? { anchor: activeAnchor } : {})} key={asset.id} />)}</ul> : <p className="muted">没有附件</p>}
    </div> : <div className="report-view">
      {activeAnchor?.surface && activeAnchor.surface !== "source" && <div className="banner neutral">搜索命中{activeAnchor.surface === "report" ? "事件报告" : activeAnchor.surface === "user" ? `用户补充${activeAnchor.fieldKey ? `（${activeAnchor.fieldKey}）` : ""}` : "记录标题或摘要"}。</div>}
        {record.reportState === "stale" && !record.sourceReviewRequired && <div className="banner notice">补充已保存，报告待更新。<button disabled={busy} onClick={() => void reanalyze()}>更新报告</button></div>}
      {!report && <div className="report-placeholder"><h3>{record.sourceReviewRequired ? "来源待核对" : record.reportState === "failed" ? "分析未完成" : "已保存，正在分析"}</h3><p>正式记录已经安全保存。分析失败不会丢失原文或原件。</p>{record.reportState === "failed" && <button className="primary" disabled={busy} onClick={() => void reanalyze()}>重试分析</button>}{activeAnalysisJobId && <button disabled={busy} onClick={() => void cancelAnalysis()}>取消分析</button>}</div>}
      {report && <section className="report-section"><h3>事件摘要</h3><p className="report-summary">{report.content.summary}</p></section>}
        <section className="report-section field-grid">
          <div className="report-field-cell"><ReportTimeField field={report?.content.time ?? { value: { value: "", precision: "unknown" }, source: "ai" }} userSupplied={Boolean(occurredAtOverride)} userKind={record.occurredAt.kind} {...(occurredAtOverride && record.occurredAt.kind !== "unknown" ? { userValue: occurrenceTimeLabel(record, timeZone) } : {})} /><button className="text-button" disabled={busy} onClick={() => beginEdit("occurredAt")}>补充时间</button>{fieldEditor("occurredAt")}</div>
          <div className="report-field-cell"><ReportField label="地点" value={String(locationOverride?.value ?? report?.content.location.value ?? "")} prompt={report?.content.location.prompt ?? "待补充：事情发生在哪里？"} source={locationOverride ? "user" : report?.content.location.source ?? "ai"} /><button className="text-button" disabled={busy} onClick={() => beginEdit("location", String(locationOverride?.value ?? report?.content.location.value ?? ""))}>补充地点</button>{fieldEditor("location")}</div>
          <div className="report-field-cell"><ReportPeopleField people={report?.content.people ?? []} disabled={busy} onSupplement={() => editClarification("unknown", "有哪些相关人物及角色？")} />{clarificationEditor?.topic === "有哪些相关人物及角色？" && clarificationForm}</div>
        </section>
      {report && <>
        {(record.reportState === "queued" || record.reportState === "running") && <div className="banner notice">当前展示上一版报告，新报告完成后会自动切换。{activeAnalysisJobId && <button disabled={busy} onClick={() => void cancelAnalysis()}>取消分析</button>}</div>}
        {record.reportState === "failed" && <div className="banner error" role="alert">新报告分析失败，当前仍展示上一版成功报告。<button disabled={busy} onClick={() => void reanalyze()}>重试分析</button></div>}
        {record.reportState === "partial" && <div className="banner notice">部分内容尚未完成处理；已完成的报告仍可查看。<button disabled={busy} onClick={() => void reanalyze()}>重试未完成分析</button></div>}
        <section className="report-section next-steps"><h3>下一步</h3>{report.content.suggestions.length ? <><ol>{report.content.suggestions.slice(0, 2).map((item, index) => <li key={index}>{item}</li>)}</ol>{report.content.suggestions.length > 2 && <Disclosure title="更多建议"><ol start={3}>{report.content.suggestions.slice(2).map((item, index) => <li key={index}>{item}</li>)}</ol></Disclosure>}</> : <p className="muted">先补充尚不明确的事实，再核对原始材料。</p>}</section>
        <Disclosure title="事件经过" className="report-section" forceOpen={activeAnchor?.surface === "report"}><h3>事件经过</h3>{report.content.chronology.length ? <ol className="chronology">{report.content.chronology.map((step) => <li key={step.id}>{step.anchor ? <button className="anchor-link" onClick={() => { setActiveAnchor(step.anchor); setTab("source"); }}>{step.text}<span>查看对应原始内容</span></button> : step.text}</li>)}</ol> : <p className="muted">尚未整理出明确经过。</p>}</Disclosure>
        {(report.content.mediaSegments?.length ?? 0) > 0 && <Disclosure title="媒体片段" className="report-section" forceOpen={Boolean(activeAnchor?.surface === "report" && activeAnchor.assetId)}><h3>媒体片段</h3><p className="muted">模型生成的描述与建议定位，请对照原件核实。</p><ol className="chronology">{report.content.mediaSegments!.map((segment) => <li key={segment.id}><button className="anchor-link" onClick={() => { setActiveAnchor(segment.anchor); setTab("source"); }}>{segment.description}<span>查看对应原始内容</span></button></li>)}</ol></Disclosure>}
        <section className="report-section split-sections"><div><h3>缺失与争议</h3>
          {report.content.unknowns.length > 0 && <><h4>待补充</h4><ul>{issueItems("unknown", report.content.unknowns)}</ul></>}
          {report.content.disputes.length > 0 && <><h4>存在争议</h4><ul>{issueItems("dispute", report.content.disputes)}</ul></>}
          {(report.content.speculations?.length ?? 0) > 0 && <><h4>待核对推测</h4><ul>{issueItems("speculation", report.content.speculations ?? [])}</ul></>}
          {report.content.unknowns.length === 0 && report.content.disputes.length === 0 &&
            (report.content.speculations?.length ?? 0) === 0 && <p className="muted">当前报告没有列出缺失、争议或推测。</p>}
          {unmatchedClarifications.length > 0 && <div className="prior-clarifications"><h4>此前补充的问题</h4><ul>{unmatchedClarifications.map(({ kind, topic, response }) => <li key={`${kind}-${topic}`}><span>{topic}</span><p className="clarification-response">你已补充（用户陈述，待核对）：{response}</p><button className="text-button" disabled={busy} onClick={() => editClarification(kind, topic)}>修改此项补充</button></li>)}</ul></div>}
          {clarificationEditor?.topic !== "有哪些相关人物及角色？" && clarificationForm}
        </div></section>
        {record.categories.includes("rights") && <Disclosure title="法律视角 · 依据待核验" className="report-section legal" forceOpen={editField === "jurisdiction" || activeAnchor?.surface === "user" && activeAnchor.fieldKey === "jurisdiction"}><h3>法律视角</h3><button className="text-button" disabled={busy} onClick={() => beginEdit("jurisdiction", String(jurisdictionOverride?.value ?? defaultJurisdiction))}>修改法域</button>{fieldEditor("jurisdiction")}{reportMatchesCurrentRevision ? <><p className="muted">法域：{String(jurisdictionOverride?.value ?? defaultJurisdiction)} · 下列内容是待核验问题，不是确定法律结论。</p><ul>{report.content.legalIssues.map((item, index) => <li key={index}>{item}</li>)}</ul>{report.content.citations.length === 0 ? <span className="verification-pending">依据待核验</span> : <ul className="citation-list">{report.content.citations.map((citation) => <CitationCard citation={citation} issues={report.content.legalIssues} onOpen={openCitation} key={citation.id} />)}</ul>}</> : <p className="verification-pending" role="status">记录已有新的补充或来源版本；旧报告的法律问题与依据暂不展示。请重新分析后核对当前法域、事实和事发时间。</p>}</Disclosure>}
        {report.content.coverageNotes.length > 0 && <section className="report-section warning"><h3>覆盖限制</h3><ul>{report.content.coverageNotes.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      </>}
      <section className="report-section report-tools"><button disabled={busy} onClick={() => void reanalyze()}>重新分析</button><Disclosure title="报告详情">{report && <ReportField label="报告版本" value={`记录修订 ${report.recordRevision}`} source="ai" />}<p className="capability-help">来源标记表示信息来自哪里，不代表事实已核实。重新分析会发送当前材料给已启用的模型，可能产生费用。</p></Disclosure></section>
    </div>}
  </section>;
}

function TimelineImportStatus({ hasZipRecords, onSettings, state }: { hasZipRecords: boolean; onSettings(): void; state: ReturnType<typeof useDayOneImportReceipt> }) {
  const { receipt, loading, unavailable, reload } = state;
  if (loading || !hasZipRecords && !receipt) return null;
  return <section className="timeline-import-status" aria-label="ZIP 导入状态">
    {unavailable ? <p role="status">暂时无法读取导入结果。<button onClick={() => void reload()}>重新读取导入结果</button></p>
      : receipt ? <><p>{receipt.outcome === "completed" ? "上次 ZIP 已完成检查" : "上次 ZIP 尚未完成检查"}：已处理 {receipt.included + receipt.skipped + receipt.review + receipt.failed} 条{receipt.totalEntries !== null && `／包内共 ${receipt.totalEntries} 条`}，收录 {receipt.included}，待确认 {receipt.review}。<button onClick={onSettings}>查看导入</button></p><Disclosure title="导入范围与结果"><p>{dayOneImportReceiptLabel(receipt)}</p></Disclosure></>
      : <p role="status">旧导入没有完整批次摘要，暂不能确认是否检查了整个 ZIP。<button onClick={onSettings}>查看导入</button></p>}
  </section>;
}

export function TimelineView({ onNew, onSettings, pendingCount, onPending, openRecordId, onRecordOpened }: {
  onNew(): void;
  onSettings(): void;
  pendingCount: number;
  onPending(): void;
  openRecordId?: string;
  onRecordOpened(): void;
}) {
  const { selected, error: selectionError, open: openSelection, close: closeSelection, reload: reloadSelection } = useRecordSelection(RECORD_DETAIL_ACCESS);
  const selectionMessage = selectionError ? displayError(selectionError) : "";
  const [filter, setFilter] = useState<TimelineFilter>({ limit: 60 });
  const presence = useReadOnlySnapshot(READ_TIMELINE_PRESENCE, SUBSCRIBE_JOB_READS);
  const presenceEmpty = Boolean(presence.value && !presence.loading && !presence.error && presence.value.records.length === 0);
  const filtered = Boolean(filter.category || filter.origin || filter.from || filter.to);
  const listScrollPosition = useRef(0);
  const { records, nextCursor, timeZone: resultTimeZone, loading, refreshing, loadingMore, error: readError,
    reload: load, loadMore } = useTimelineRecords(TIMELINE_ACCESS, filter);
  // Keep the summary loaded while viewing details so the list retains its height on return.
  const importReceipt = useDayOneImportReceipt(READ_DAYONE_RECEIPT);
  const emptyVault = presenceEmpty && records.length === 0;
  const error = readError ? displayError(readError) : "";
  const selectedId = selected?.record.id;
  useEffect(() => { if (selectedId) globalThis.scrollTo({ top: 0 }); }, [selectedId]);
  const open = useCallback(async (id: string) => {
    listScrollPosition.current = globalThis.scrollY;
    await openSelection(id);
  }, [openSelection]);
  useEffect(() => {
    if (!openRecordId) return;
    void open(openRecordId).finally(onRecordOpened);
  }, [onRecordOpened, open, openRecordId]);
  if (selected) return <RecordDetail key={selected.record.id} detail={selected} timeZone={resultTimeZone} {...(selectionMessage ? { refreshError: selectionMessage } : {})} onBack={() => {
    closeSelection();
    globalThis.requestAnimationFrame(() => globalThis.scrollTo({ top: listScrollPosition.current }));
  }} onReload={async (value) => { await reloadSelection(value); await load(); }} />;
  return <div className="page timeline-page"><div className="timeline-background" aria-hidden="true"><i /><i /><i /></div>
    <header className="page-header"><div><p className="eyebrow">事件账本</p><h1>时间线</h1><p>沿着时间，回看值得留下的事。</p></div><div className="header-actions"><button onClick={onPending}>待确认{pendingCount > 0 && <b>{pendingCount}</b>}</button>{!emptyVault && <button className="primary" onClick={onNew}><Icon name="plus" />新建记录</button>}</div></header>
    <TimelineImportStatus state={importReceipt} hasZipRecords={records.some(({ origin }) => origin === "zip")} onSettings={onSettings} />
    {(!emptyVault || filtered) && <div className="filter-bar">
      <label>类别<select value={filter.category ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.category; return event.target.value ? { ...next, category: event.target.value as EventCategory } : next; })}><option value="">全部</option><option value="grudge">冲突</option><option value="rights">权益</option><option value="danger">危险</option></select></label>
      <label>来源<select value={filter.origin ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.origin; return event.target.value ? { ...next, origin: event.target.value as RecordOrigin } : next; })}><option value="">全部</option><option value="manual">手动记录</option><option value="dayone">Day One</option><option value="zip">ZIP 导入</option><option value="migration">旧数据迁移</option></select></label>
      <label>从<input type="date" value={filter.from ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.from; return event.target.value ? { ...next, from: event.target.value } : next; })} /></label>
      <label>至<input type="date" value={filter.to ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.to; return event.target.value ? { ...next, to: event.target.value } : next; })} /></label>
      <button className="text-button" onClick={() => setFilter({ limit: 60 })}>清除筛选</button>
    </div>}
    {(!emptyVault || filtered) && <Disclosure title="日期如何匹配？"><p>月份与时间范围按可能重叠筛选；时间未确定时按记录日期。明确时刻按本次查询的本地日期。</p></Disclosure>}
    {selectionMessage && <div className="banner error" role="alert">{selectionMessage}</div>}
    {error && <div className="banner error" role="alert">{records.length ? "列表读取未完成；当前保留上次成功读取的内容。" : "暂时无法读取时间线；不能据此判断没有记录。"} {error}<button onClick={() => void Promise.all([load(), presence.reload()])}>重新载入时间线</button></div>}
    {refreshing && records.length > 0 && <p className="muted" role="status">正在更新列表；当前展示上次成功读取的内容。</p>}
    {loading || (refreshing && records.length === 0) ? <div className="loading" role="status">正在载入时间线…</div> : records.length === 0 ? error ? <p className="muted">未完成读取，请重新载入后查看。</p> : filtered ? <section className="empty-state small"><h2>没有符合筛选的记录</h2><p>试试调整类别、来源或日期。</p><button onClick={() => setFilter({ limit: 60 })}>清除筛选</button></section> : presence.error ? <div className="banner error" role="alert">暂时无法确认账本是否为空。<button onClick={() => void presence.reload()}>重新读取账本状态</button></div> : presence.loading ? <p role="status">正在核对账本状态…</p> : emptyVault ? <EmptyTimeline onNew={onNew} onSettings={onSettings} /> : <p className="muted">当前没有可显示的记录，请重新载入。</p> : <><div className="timeline-guide"><span>{records.length} 条记录{nextCursor ? " · 还有更早的记录" : ""}</span><span>移到节点查看预览 · 点击查看详情</span></div><TimelineRail records={records} timeZone={resultTimeZone} onOpen={id => void open(id)} />{nextCursor && <button className="load-more" disabled={loadingMore || refreshing} onClick={() => void loadMore()}>{loadingMore ? "正在载入…" : "载入更多"}</button>}</>}
  </div>;
}

function PendingDrawer({ items, loading, loadError, onClose, onChanged, onSaved, onReprovide }: {
  items: PendingReview[]; onClose(): void; onChanged(): Promise<void>; onSaved(id: string): void;
  onReprovide(id: string): void; loading: boolean; loadError: string;
}) {
  const dialogRef = useModalFocus<globalThis.HTMLElement>();
  const [busy, setBusy] = useState<string>(); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); onClose();
    };
    globalThis.addEventListener("keydown", closeOnEscape, true);
    return () => globalThis.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);
  const resolve = async (item: PendingReview, action: "keep" | "ignore") => {
    setBusy(item.id); setError(""); setNotice("");
    try { const result = unwrap(await window.grudgeVault.pending.resolve(item.id, action, globalThis.crypto.randomUUID())); await onChanged(); if (result?.kind === "saved") onSaved(result.recordId); }
    catch (cause) { setError(displayError(cause)); } finally { setBusy(undefined); }
  };
  const resolveZip = async (item: PendingReview) => {
    setBusy(item.id); setError(""); setNotice("");
    try {
      const result = unwrap(await window.grudgeVault.pending.chooseDayOneZip(item.id, globalThis.crypto.randomUUID()));
      if (!result) return;
      await onChanged();
      if (result.kind === "saved") onSaved(result.recordId);
      if (result.kind === "failed") setError(`重新筛选失败（${result.code}），请检查模型设置后重试。`);
      if (result.kind === "skipped") setNotice("所选 ZIP 中的日记版本已变化；重新筛选后判定为普通日常，旧待确认项已清理。");
      if (result.kind === "needs_review") setNotice("日记版本已变化，已重新筛选并更新待确认项；仍未建立正式记录。");
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(undefined); }
  };
  const resolveLegacy = async (item: PendingReview) => {
    if (!window.confirm("将只读核对所选旧工作区中的这条原始记录；若版本已变化，新内容会发送给当前模型重新筛选。确认继续吗？")) return;
    setBusy(item.id); setError(""); setNotice("");
    try {
      const result = unwrap(await window.grudgeVault.pending.chooseLegacyWorkspace(item.id, globalThis.crypto.randomUUID()));
      if (!result) return;
      await onChanged();
      if (result.kind === "saved") onSaved(result.recordId);
      if (result.kind === "failed") setError(`旧记录核对失败（${result.code}），请检查模型设置或旧工作区后重试。`);
      if (result.kind === "skipped") setNotice("旧记录版本已变化；重新筛选后判定为普通日常，旧待确认项已清理。");
      if (result.kind === "needs_review") setNotice("旧记录版本已变化，已重新筛选并更新待确认项；仍未建立正式记录。");
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(undefined); }
  };
  return <div className="drawer-backdrop"><aside ref={dialogRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label="待确认">
    <header><div><p className="eyebrow">与正式记录隔离</p><h2>待确认</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button></header>
    <p className="drawer-help">这里只保留最小摘录和判断原因，不会进入时间线或搜索。普通日常不会出现在这里。</p>
    {error && <div className="banner error">{error}</div>}
    {notice && <div className="banner notice" role="status">{notice}</div>}
    {loadError && <div className="banner error" role="alert">暂时无法读取待确认：{loadError}<button onClick={() => void onChanged()}>重新读取待确认</button></div>}
    {loading ? <p role="status">正在读取待确认…</p> : loadError ? null : items.length === 0 ? <div className="empty compact"><h3>没有待确认内容</h3><p>需要你判断的项目会出现在这里。</p></div> : <div className="pending-list">{items.map((item) => <article key={item.id}>
      <div className="chips">{item.categories.map((category) => <span className={`chip chip-${category}`} key={category}>{CATEGORY_LABEL[category]}</span>)}<span className="chip subtle">{ORIGIN_LABEL[item.origin]}</span></div>
      <blockquote>{item.excerpt || "（只有媒体）"}</blockquote><p>{item.reason}</p>
      {!item.sessionAvailable && <p className="muted">原始处理会话已结束。点击“补充”写清需要核对的经过，并添加你希望留存的附件。</p>}
      <footer><button disabled={Boolean(busy)} onClick={() => void resolve(item, "ignore")}>忽略并清理</button><button className="primary" disabled={Boolean(busy)} onClick={() => onReprovide(item.id)}>补充</button>{item.sessionAvailable && <button disabled={Boolean(busy)} onClick={() => void resolve(item, "keep")}>确认保留</button>}</footer>
      {!item.sessionAvailable && (item.origin === "zip" || item.origin === "migration") && <Disclosure title="从原件恢复"><p>也可重新选择原件核对。保留原件可恢复导入来源{item.origin === "migration" ? "和旧修订" : ""}；版本变化时会重新筛选。</p><button disabled={Boolean(busy)} onClick={() => void (item.origin === "zip" ? resolveZip(item) : resolveLegacy(item))}>{item.origin === "zip" ? "选择原 ZIP" : "选择旧工作区"}</button></Disclosure>}
    </article>)}</div>}
  </aside></div>;
}

export function SearchView({ onSettings }: { onSettings?(): void } = {}) {
  const indexSnapshot = useReadOnlySnapshot(READ_SEARCH_INDEX_STATUS, SUBSCRIBE_JOB_READS);
  const { reload: reloadSearchIndex } = indexSnapshot;
  const pollSearchIndex = useCallback(async () => {
    const result = await reloadSearchIndex();
    if (result.kind === "failed") throw result.error;
    return result.kind === "loaded" ? result.value : undefined;
  }, [reloadSearchIndex]);
  useSearchIndexCheckRefresh(indexSnapshot.value?.state, pollSearchIndex, NO_STATUS_PUBLICATION, NO_STATUS_PUBLICATION, indexSnapshot.version);
  const indexReady = Boolean(!indexSnapshot.error && indexSnapshot.value?.enabled && (indexSnapshot.value.state === "ready" || indexSnapshot.value.activeGenerationId));
  const semanticPreference = useRef<boolean | undefined>(undefined);
  const [text, setText] = useState(""); const [files, setFiles] = useState<File[]>([]);
  const textTooLong = codePointLength(text) > RECORD_QUERY_TEXT_LIMIT;
  const [useSemantic, setUseSemantic] = useState(false);
  useEffect(() => { setUseSemantic(files.length > 0 || indexReady && (semanticPreference.current ?? true)); }, [indexReady, files.length]);
  const [semanticRequested, setSemanticRequested] = useState(false);
  const [category, setCategory] = useState<EventCategory | "">(""); const [origin, setOrigin] = useState<RecordOrigin | "">("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [hits, setHits] = useState<RecordSearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string>(); const [selectedAnchor, setSelectedAnchor] = useState<SourceAnchor>();
  const [semanticSessionId, setSemanticSessionId] = useState<string>();
  const { selected, error: selectionError, open: openSelection, close: closeSelection, reload: reloadSelection } = useRecordSelection(RECORD_DETAIL_ACCESS);
  const selectionMessage = selectionError ? displayError(selectionError) : "";
  const [searched, setSearched] = useState(false);
  const resultsScrollPosition = useRef(0);
  const activeSearch = useRef<{ text: string; filters: Omit<RecordSearchQuery, "text" | "cursor"> } | null>(null);
  const [resultTimeZone, setResultTimeZone] = useState<string>();
  const mounted = useRef(true);
  const searchInFlight = useRef(false);
  const searchCancelled = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const pendingPreparation = useRef<string | undefined>(undefined);
  const liveSession = useRef<string | undefined>(undefined);
  const { progress: mediaProgress, clear: clearMediaProgress } = useMediaProgress(SEARCH_PROGRESS, liveSession, searchInFlight);
  const [capabilities, setCapabilities] = useState<Omit<RecordSearchPage["capabilities"], "keyword">>({ semantic: "unavailable", media: "unavailable" });
  const indexIncomplete = searchIndexIncomplete(capabilities);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const selectedId = selected?.record.id;
  useEffect(() => { if (selectedId) globalThis.scrollTo({ top: 0 }); }, [selectedId]);
  const chooseSearchFiles = (incoming: File[]) => {
    if (incoming.length > 4) { setError("一次最多选择 4 个查询附件；本次选择未添加。"); return; }
    if (incoming.some(({ size }) => size > 500 * 1024 * 1024)) {
      setError("单个查询附件不能超过 500 MB；本次选择未添加。"); return;
    }
    setFiles(incoming); setError(""); if (incoming.length) setUseSemantic(true);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const requestId = pendingPreparation.current;
      pendingPreparation.current = undefined;
      if (requestId) void window.grudgeVault.records.abandonSearchPreparation(requestId);
      const sessionId = liveSession.current;
      liveSession.current = undefined;
      if (sessionId) void window.grudgeVault.records.abandonSearch(sessionId);
    };
  }, []);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (searchInFlight.current || textTooLong) return;
    searchInFlight.current = true;
    searchCancelled.current = false; setCancelling(false); clearMediaProgress();
    setBusy(true); setError(""); setSearched(true);
    // A new submission owns a new result set, even while the old session is being released.
    setHits([]); setNextCursor(undefined); setSemanticSessionId(undefined);
    setSemanticRequested(useSemantic && (Boolean(text.trim()) || files.length > 0));
    const submitted = {
      text,
      filters: {
        ...(category ? { category } : {}), ...(origin ? { origin } : {}),
        ...(from ? { from } : {}), ...(to ? { to } : {}), limit: 30,
        timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    };
    activeSearch.current = null;
    try {
      if (liveSession.current) {
        const previousSessionId = liveSession.current;
        liveSession.current = undefined;
        await window.grudgeVault.records.abandonSearch(previousSessionId);
        if (!mounted.current || searchCancelled.current) return;
      }
      if ((!useSemantic || (!text.trim() && files.length === 0)) && files.length === 0) {
        const page = unwrap(await window.grudgeVault.records.search({ text: submitted.text, ...submitted.filters }));
        if (!mounted.current || searchCancelled.current) return;
        activeSearch.current = submitted;
        setResultTimeZone(submitted.filters.timeZone);
        setHits(page.hits); setNextCursor(page.nextCursor);
        setCapabilities({ semantic: "unavailable", media: "unavailable" });
        return;
      }
      const requestId = globalThis.crypto.randomUUID();
      pendingPreparation.current = requestId;
      const prepared = unwrap(await window.grudgeVault.records.prepareSearch({ requestId, text: submitted.text, files }));
      if (pendingPreparation.current === requestId) pendingPreparation.current = undefined;
      if (!mounted.current || searchCancelled.current) {
        void window.grudgeVault.records.abandonSearch(prepared.sessionId);
        return;
      }
      liveSession.current = prepared.sessionId;
      const page = unwrap(await window.grudgeVault.records.executeSearch(prepared.sessionId, submitted.filters));
      if (!mounted.current || searchCancelled.current) return;
      if (page.nextCursor && page.capabilities.semantic === "ready") setSemanticSessionId(prepared.sessionId);
      else liveSession.current = undefined;
      activeSearch.current = submitted;
      setResultTimeZone(submitted.filters.timeZone);
      setHits(page.hits); setNextCursor(page.nextCursor);
      setCapabilities(page.capabilities);
    } catch (cause) {
      pendingPreparation.current = undefined;
      if (liveSession.current) void window.grudgeVault.records.abandonSearch(liveSession.current);
      liveSession.current = undefined;
      if (!mounted.current || searchCancelled.current) return;
      setHits([]); setNextCursor(undefined); setError(displayError(cause));
    } finally {
      searchInFlight.current = false;
      if (mounted.current) {
        if (files.length > 0) setFiles([]);
        setBusy(false);
        setCancelling(false);
      }
    }
  };
  const loadMore = async () => {
    const submitted = activeSearch.current;
    if (!nextCursor || !submitted || searchInFlight.current) return;
    searchInFlight.current = true;
    searchCancelled.current = false; setCancelling(false); clearMediaProgress();
    setBusy(true); setError("");
    try {
      const page = semanticSessionId
        ? unwrap(await window.grudgeVault.records.executeSearch(semanticSessionId, {
          cursor: nextCursor, ...submitted.filters
        }))
        : unwrap(await window.grudgeVault.records.search({ text: submitted.text, cursor: nextCursor, ...submitted.filters }));
      if (!mounted.current || searchCancelled.current) return;
      setHits((current) => [...current, ...page.hits]); setNextCursor(page.nextCursor);
      if (semanticSessionId && !page.nextCursor) { liveSession.current = undefined; setSemanticSessionId(undefined); }
    } catch (cause) {
      if (semanticSessionId) void window.grudgeVault.records.abandonSearch(semanticSessionId);
      liveSession.current = undefined;
      if (!mounted.current || searchCancelled.current) return;
      setSemanticSessionId(undefined); setNextCursor(undefined);
      if (cause instanceof UiError && (cause.code === "REVISION_CONFLICT" || cause.code === "LLM_CONFIGURATION_CHANGED")) {
        setHits([]);
        activeSearch.current = null;
        setError(cause.code === "LLM_CONFIGURATION_CHANGED" ? "模型配置已变化，请重新搜索。旧结果已清除。" : cause.message);
      } else {
        setError(displayError(cause));
      }
    } finally {
      searchInFlight.current = false;
      if (mounted.current) { setBusy(false); setCancelling(false); }
    }
  };
  const openHit = async (hit: RecordSearchHit, anchor = hit.anchor) => {
    resultsScrollPosition.current = globalThis.scrollY;
    setSelectedAnchor(anchor);
    await openSelection(hit.record.id);
  };
  const cancelSearch = () => {
    searchCancelled.current = true; setCancelling(true); setError("本次搜索已取消。");
    clearMediaProgress(); setHits([]); setNextCursor(undefined); setSemanticSessionId(undefined); activeSearch.current = null;
    const requestId = pendingPreparation.current; pendingPreparation.current = undefined;
    if (requestId) void window.grudgeVault.records.abandonSearchPreparation(requestId);
    const sessionId = liveSession.current; liveSession.current = undefined;
    if (sessionId) void window.grudgeVault.records.abandonSearch(sessionId);
  };
  if (selected) return <RecordDetail key={selected.record.id} detail={selected} timeZone={resultTimeZone} {...(selectionMessage ? { refreshError: selectionMessage } : {})} onBack={() => {
    closeSelection(); setSelectedAnchor(undefined);
    globalThis.requestAnimationFrame(() => globalThis.scrollTo({ top: resultsScrollPosition.current }));
  }} backLabel="返回搜索结果" onReload={async (value) => { await reloadSelection(value); }} {...(selectedAnchor ? { sourceAnchor: selectedAnchor } : {})} />;
  return <div className="page search-page"><header className="page-header"><div><p className="eyebrow">正式记录范围</p><h1>搜索</h1><p>关键词在本地检索；语义和附件查询会发送给已授权的服务商。查询副本由本应用清理，服务商按其政策留存。</p></div></header>
    <form className="search-box" onSubmit={(event) => void search(event)}><div className="search-input"><Icon name="search" /><input id="global-search-input" value={text} aria-invalid={textTooLong || undefined} aria-describedby={textTooLong ? "search-text-limit" : undefined} onChange={(event) => setText(event.target.value)} placeholder="描述你记得的内容…" /><button className="primary" disabled={busy || textTooLong}>搜索</button></div>
      {textTooLong && <p id="search-text-limit" className="inline-warning" role="alert">搜索文字不能超过 500 字，请缩短后再搜索。输入未被截断。</p>}
      <div className="search-options"><label className="file-button"><Icon name="plus" />图片／音频／视频<input type="file" aria-label="选择搜索图片、音频或视频" multiple disabled={busy} accept="image/*,audio/*,video/*" onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; chooseSearchFiles(selected); }} /></label>
        <label className="semantic-toggle"><input type="checkbox" checked={useSemantic || files.length > 0} disabled={busy || files.length > 0 || !indexReady} onChange={(event) => { semanticPreference.current = event.target.checked; setUseSemantic(event.target.checked); }} />使用百炼语义检索</label>
        <span className="search-mode" role="status">{indexSnapshot.error ? "检索能力状态未知 · 本地关键词可用" : !indexSnapshot.value ? "正在读取检索能力…" : files.length ? "附件查询 · 需发送给模型理解" : useSemantic ? "关键词＋语义检索" : "本地关键词检索"}</span>
        {!indexReady && onSettings && <button type="button" className="text-button" onClick={onSettings}>设置语义检索</button>}
      </div>
      {indexSnapshot.error && <div className="banner error" role="alert">暂时无法读取搜索能力，不代表未配置。<button type="button" onClick={() => void indexSnapshot.reload()}>重新读取搜索能力</button></div>}
      {files.length > 0 && <ul className="file-list query-files">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}<small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></span><button type="button" disabled={busy} aria-label={`移除查询附件 ${file.name}`} onClick={() => setFiles(current => current.filter((_, at) => at !== index))}>移除</button></li>)}</ul>}
      <Disclosure title="筛选"><div className="search-filters">
        <label>类别<select value={category} onChange={(event) => setCategory(event.target.value as EventCategory | "")}><option value="">全部</option><option value="grudge">冲突</option><option value="rights">权益</option><option value="danger">危险</option></select></label>
        <label>来源<select value={origin} onChange={(event) => setOrigin(event.target.value as RecordOrigin | "")}><option value="">全部</option><option value="manual">手动记录</option><option value="zip">ZIP 导入</option><option value="dayone">Day One</option><option value="migration">旧数据迁移</option></select></label>
        <label>从<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>至<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div><p className="capability-help">月份与时间范围按可能重叠筛选；时间未确定时按记录日期。明确时刻按本次查询的本地日期。</p></Disclosure>
      <div className="filter-chips" aria-label="已选筛选条件">{category && <button type="button" aria-label={`移除类别筛选：${CATEGORY_LABEL[category]}`} onClick={() => setCategory("")}>类别：{CATEGORY_LABEL[category]} <Icon name="close" /></button>}{origin && <button type="button" aria-label={`移除来源筛选：${ORIGIN_LABEL[origin]}`} onClick={() => setOrigin("")}>来源：{ORIGIN_LABEL[origin]} <Icon name="close" /></button>}{from && <button type="button" aria-label="移除起始日期筛选" onClick={() => setFrom("")}>从：{from} <Icon name="close" /></button>}{to && <button type="button" aria-label="移除结束日期筛选" onClick={() => setTo("")}>至：{to} <Icon name="close" /></button>}</div>
    </form>
    {busy && <div className="stage-progress" aria-live="polite"><i /><span>{cancelling ? "正在停止查询并清理临时副本…" : mediaProgress ? mediaProgressLabel(mediaProgress) : "正在处理本次查询…"}</span><button disabled={cancelling} onClick={cancelSearch}>{cancelling ? "正在取消…" : "取消搜索"}</button></div>}
    {searched && !busy && !error && <div className="capability-grid search-capabilities" aria-live="polite"><span className={capabilities.semantic === "ready" ? "ready" : capabilities.semantic === "building" ? "pending" : "unavailable"}>语义索引 · {capabilities.semantic === "ready" ? "可用" : capabilities.semantic === "building" ? "构建中" : "不可用"}</span><span className={capabilities.media === "ready" ? "ready" : capabilities.media === "building" ? "pending" : "unavailable"}>媒体查询 · {capabilities.media === "ready" ? "可用" : capabilities.media === "building" ? "构建中" : "不可用"}</span></div>}
    {(error || selectionMessage) && <div className="banner error" role="alert">{error || selectionMessage}</div>}
    {searched && semanticRequested && capabilities.semantic !== "ready" && !busy && !error && <div className="banner neutral" role="status">{capabilities.semantic === "building" ? "语义索引尚未完成" : "语义检索暂不可用"}，本次仅显示本地关键词结果；无匹配不代表没有相关记录。</div>}
    {searched && semanticRequested && capabilities.semantic === "ready" && indexIncomplete && !busy && !error && <div className="banner neutral" role="status">{searchCoverageMessage(capabilities)}</div>}
    {searched && !busy && hits.length === 0 && !error && <div className="empty-state small"><h2>{semanticRequested && capabilities.semantic !== "ready" ? "本地关键词未找到匹配" : semanticRequested && indexIncomplete ? "当前可搜索范围内未找到匹配" : "没有找到相关正式记录"}</h2><p>{semanticRequested && (capabilities.semantic !== "ready" || indexIncomplete) ? "语义索引尚未完整覆盖当前内容，更新索引后重试或更换关键词。" : "尝试更换关键词或清除类别筛选。"}</p></div>}
    {hits.length > 0 && <div className="search-results"><p role="status">找到 {hits.length} 条记录</p>{hits.map((hit) => <article key={hit.record.id}><RecordCard record={hit.record} timeZone={resultTimeZone} selected={false} onOpen={() => void openHit(hit)} /><div className="match-explanation"><span>匹配原因</span>{(hit.matches ?? [{ explanation: hit.explanation, ...(hit.anchor ? { anchor: hit.anchor } : {}) }]).map((match, index) => {
      const content = <><p>{match.explanation}</p>{match.anchor?.textRange && <em>定位到原文第 {match.anchor.textRange[0] + 1} 字</em>}{match.anchor?.assetId && <em>定位到附件</em>}{match.anchor?.surface === "report" && <em>定位到事件报告</em>}{match.anchor?.surface === "user" && <em>定位到用户补充</em>}{match.anchor?.surface === "record" && <em>定位到标题或摘要</em>}</>;
      return match.anchor
        ? <button className="match-link" key={`${match.explanation}-${index}`} onClick={() => void openHit(hit, match.anchor)}>{content}</button>
        : <div key={`${match.explanation}-${index}`}>{content}</div>;
    })}</div></article>)}{nextCursor && <button className="load-more" disabled={busy} onClick={() => void loadMore()}>载入更多</button>}</div>}
  </div>;
}

function AutoLockSettings() {
  const [saved, setSaved] = useState<WorkspaceSecuritySettings | null>(null);
  const [minutes, setMinutes] = useState<WorkspaceSecuritySettings["autoLockMinutes"]>(15);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const settings = unwrap(await window.grudgeVault.workspace.getSecuritySettings());
      setSaved(settings); setMinutes(settings.autoLockMinutes);
    } catch (cause) { setError(displayError(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!saved || busy || minutes === saved.autoLockMinutes) return;
    if (minutes === 0 && !window.confirm("关闭空闲自动锁定后，工作区会一直保持解锁，直到你手动锁定、锁定屏幕、让 Mac 休眠或退出应用。确定关闭吗？")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const settings = unwrap(await window.grudgeVault.workspace.updateSecuritySettings({
        ...saved, autoLockMinutes: minutes
      }));
      setSaved(settings); setMinutes(settings.autoLockMinutes); setMessage("自动锁定设置已保存。");
    } catch (cause) { setError(displayError(cause)); }
    finally { setBusy(false); }
  };
  return <section className="settings-card"><div className="settings-card-header"><div><h2>离开时自动锁好账本</h2><p>默认离开电脑 15 分钟后锁定，回来时再打开账本。</p></div></div>
    <div className="settings-form">
      {saved ? <>
        <label className="field">Mac 空闲多久后锁定<select aria-label="Mac 空闲多久后锁定" disabled={busy} value={minutes} onChange={(event) => { setMinutes(Number(event.target.value) as WorkspaceSecuritySettings["autoLockMinutes"]); setMessage(""); }}><option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>60 分钟</option><option value={0}>关闭空闲自动锁定</option></select></label>
        {minutes === 0 && <p className="inline-warning">关闭后，工作区不会因 Mac 空闲而锁定；请留意本机访问安全。锁屏和休眠仍会锁定。</p>}
        <button className="primary" disabled={busy || minutes === saved.autoLockMinutes} onClick={() => void save()}>{busy ? "正在保存…" : "保存自动锁定设置"}</button>
      </> : loading ? <p className="capability-help">正在读取自动锁定设置…</p> : <button onClick={() => void load()}>重新读取自动锁定设置</button>}
      <p className="capability-help">工作区锁定、Mac 锁屏或休眠、退出应用都会停止正在进行的 Day One 导入。已保存的记录会保留；重新选择 ZIP 不是断点继续，部分条目可能重新调用模型并产生费用。</p>
      {error && <div className="banner error" role="alert">{error}</div>}{message && <div className="banner notice" role="status">{message}</div>}
    </div>
  </section>;
}

function SnapshotNotice({ name, snapshot }: { name: string; snapshot: {
  value?: unknown; loading: boolean; error?: Error | undefined; reload(): Promise<unknown>;
} }) {
  if (snapshot.loading) return <p className="capability-help" role="status">正在读取{name}…{snapshot.value !== undefined && "当前展示上次成功读取的内容。"}</p>;
  if (!snapshot.error) return null;
  return <div className="banner error" role="alert">暂时无法读取{name}，不能据此判断配置或能力。{snapshot.value !== undefined && "当前展示上次成功读取的内容。"}{displayError(snapshot.error)}<button onClick={() => void snapshot.reload()}>重新读取{name}</button></div>;
}

export function SettingsView({ onDataChanged, initialGroup = "model", navigationId = 0 }: { onDataChanged(): void; initialGroup?: SettingsGroup; navigationId?: number }) {
  const [group, setGroup] = useState<SettingsGroup>(initialGroup);
  useEffect(() => { setGroup(initialGroup); }, [initialGroup, navigationId]);
  const modelSnapshot = useReadOnlySnapshot(READ_MODEL_SETTINGS, SUBSCRIBE_JOB_READS);
  const indexSnapshot = useReadOnlySnapshot(READ_SEARCH_INDEX_STATUS, SUBSCRIBE_JOB_READS);
  const legalSnapshot = useReadOnlySnapshot(READ_DEFAULT_JURISDICTION);
  const settings = modelSnapshot.value, searchIndex = indexSnapshot.value;
  const modelFresh = Boolean(settings && !modelSnapshot.loading && !modelSnapshot.error);
  const indexFresh = Boolean(searchIndex && !indexSnapshot.loading && !indexSnapshot.error);
  const legalFresh = legalSnapshot.value !== undefined && !legalSnapshot.loading && !legalSnapshot.error;
  const { reload: reloadModel } = modelSnapshot;
  const { reload: reloadIndex, captureCommit: captureIndexCommit } = indexSnapshot;
  const { captureCommit: captureLegalCommit } = legalSnapshot;
  const [error, setError] = useState("");
  const [indexBusy, setIndexBusy] = useState(false); const [indexMessage, setIndexMessage] = useState("");
  const pollIndex = useCallback(async () => {
    const result = await reloadIndex();
    if (result.kind === "failed") throw result.error;
    return result.kind === "loaded" ? result.value : undefined;
  }, [reloadIndex]);
  useSearchIndexCheckRefresh(searchIndex?.state, pollIndex, NO_STATUS_PUBLICATION, NO_STATUS_PUBLICATION, indexSnapshot.version);
  const [zipBusy, setZipBusy] = useState(false); const [zipMessage, setZipMessage] = useState("");
  const [zipControlBusy, setZipControlBusy] = useState(false);
  const lastZip = useDayOneImportReceipt(READ_DAYONE_RECEIPT);
  const { reload: reloadZipReceipt } = lastZip;
  const onZipSettled = useCallback(() => { onDataChanged(); void reloadZipReceipt(); }, [onDataChanged, reloadZipReceipt]);
  const zipStatus = useDayOneImportProgress(READ_DAYONE_PROGRESS, onZipSettled);
  const zipActive = zipBusy || dayOneImportActive(zipStatus.progress);
  const [migrationBusy, setMigrationBusy] = useState(false); const [migrationMessage, setMigrationMessage] = useState("");
  const [defaultJurisdiction, setDefaultJurisdiction] = useState("");
  const legalDraftDirty = useRef(false);
  const [legalBusy, setLegalBusy] = useState(false); const [legalMessage, setLegalMessage] = useState("");
  const load = useCallback(async () => {
    await Promise.all([reloadModel(), reloadIndex()]);
  }, [reloadModel, reloadIndex]);
  useEffect(() => {
    if (legalSnapshot.value !== undefined && !legalDraftDirty.current) setDefaultJurisdiction(legalSnapshot.value);
  }, [legalSnapshot.value]);
  const importZip = async () => {
    if (!modelFresh || !settings?.activeProvider) return;
    zipStatus.begin(); setZipBusy(true); setZipMessage(""); setError("");
    try {
      const summary = unwrap(await window.grudgeVault.intake.chooseDayOneZip());
      if (!summary) return;
      setZipMessage(dayOneImportSummaryLabel(summary));
      onDataChanged();
    } catch (cause) {
      if (cause instanceof UiError && cause.code === "IMPORT_CANCELLED") setZipMessage(cause.message);
      else setError(displayError(cause));
    }
    finally { setZipBusy(false); }
  };
  const cancelZip = async () => {
    try {
      if (unwrap(await window.grudgeVault.intake.cancelDayOneZip())) {
        setZipMessage("正在停止本次导入；当前模型请求可能仍会完成，之后会清理临时文件。已处理的正式记录会保留。");
      }
    } catch (cause) { setError(displayError(cause)); }
  };
  const controlZipPause = async (resume: boolean) => {
    const operationId = zipStatus.progress?.operationId;
    if (!operationId || zipControlBusy) return;
    setZipControlBusy(true); setError("");
    try {
      const changed = unwrap(await (resume ? window.grudgeVault.intake.resumeDayOneZip(operationId)
        : window.grudgeVault.intake.pauseDayOneZip(operationId)));
      if (!changed) setZipMessage("本次导入状态已变化，请以最新进度为准。");
    } catch (cause) { setError(displayError(cause)); }
    finally { setZipControlBusy(false); }
  };
  const migrateLegacy = async () => {
    if (!modelFresh || !settings?.activeProvider) return;
    if (!window.confirm("将只读扫描所选旧工作区，并逐条把内容发送给当前模型判断。只有正式收录项会重新加密写入当前新版工作区；旧工作区不会被修改。继续吗？")) return;
    setMigrationBusy(true); setMigrationMessage(""); setError("");
    try {
      const summary = unwrap(await window.grudgeVault.intake.chooseLegacyWorkspace());
      if (!summary) return;
      setMigrationMessage(`已检查 ${summary.total} 条旧记录：收录 ${summary.included}，跳过 ${summary.skipped}，待确认 ${summary.review}，失败 ${summary.failed}。`);
      onDataChanged();
    } catch (cause) {
      if (cause instanceof UiError && cause.code === "IMPORT_CANCELLED") setMigrationMessage(cause.message);
      else setError(displayError(cause));
    }
    finally { setMigrationBusy(false); }
  };
  const cancelLegacy = async () => {
    try {
      if (unwrap(await window.grudgeVault.intake.cancelLegacyWorkspace())) {
        setMigrationMessage("正在停止旧工作区迁移；当前模型请求可能仍会完成，但中止后不会继续写入。此前已收录的记录保留。");
      }
    } catch (cause) { setError(displayError(cause)); }
  };
  const rebuildIndex = async () => {
    if (!indexFresh || indexBusy || !searchIndex?.available) return;
    if (!window.confirm("将把正式记录中的文字和支持的图片发送给百炼 qwen3-vl-embedding，以建立本地向量索引。启用后，语义搜索的查询文字或图片也会发送给百炼；查询只用于当次搜索，不会写入记录、待确认项或索引。继续吗？")) return;
    setIndexBusy(true); setIndexMessage(""); setError("");
    const commit = captureIndexCommit();
    try {
      const status = unwrap(await window.grudgeVault.records.rebuildSearchIndex());
      if (commit.publish(status)) setIndexMessage("已开始后台构建；旧索引会保持可用，完整成功后再切换。");
    } catch (cause) { if (commit.isCurrent()) { setError(displayError(cause)); void reloadIndex(); } }
    finally { if (commit.isCurrent()) setIndexBusy(false); }
  };
  const pauseIndex = async () => {
    if (indexBusy) return;
    setIndexBusy(true); setIndexMessage(""); setError("");
    const commit = captureIndexCommit();
    try {
      const status = unwrap(await window.grudgeVault.records.setSearchIndexEnabled(false));
      if (commit.publish(status)) setIndexMessage("语义查询和自动索引更新已暂停；已有索引仍保留在本地。");
    } catch (cause) { if (commit.isCurrent()) { setError(displayError(cause)); void reloadIndex(); } }
    finally { if (commit.isCurrent()) setIndexBusy(false); }
  };
  const saveDefaultJurisdiction = async () => {
    if (!legalFresh || legalBusy || !defaultJurisdiction.trim()) return;
    setLegalBusy(true); setLegalMessage(""); setError("");
    const commit = captureLegalCommit();
    try {
      const saved = unwrap(await window.grudgeVault.legal.setDefaultJurisdiction(defaultJurisdiction));
      if (commit.publish(saved)) { legalDraftDirty.current = false; setDefaultJurisdiction(saved); setLegalMessage("默认法律地域已保存；事件级地域补充仍会优先。"); }
    } catch (cause) { if (commit.isCurrent()) setError(displayError(cause)); }
    finally { if (commit.isCurrent()) setLegalBusy(false); }
  };
  return <div className="page settings-page"><header className="page-header"><div><p className="eyebrow">能力与数据边界</p><h1>设置</h1><p>连接模型、导入历史记录，或查看隐私与安全设置。</p></div></header>{error && <div className="banner error">{error}</div>}
    <SnapshotNotice name="模型设置" snapshot={modelSnapshot} />
    <nav className="settings-tabs" aria-label="设置分组">{([["model", "模型服务"], ["import", "导入"], ["privacy", "隐私与安全"]] as const).map(([id, label]) => <button key={id} aria-pressed={group === id} className={group === id ? "active" : ""} onClick={() => setGroup(id)}>{label}</button>)}</nav>
    <div className="settings-group" hidden={group !== "model"}>{settings ? <ModelSettings settings={settings} searchIndex={searchIndex ?? null} fresh={modelFresh} indexFresh={indexFresh} onChanged={load} /> : <section className="settings-card blocked-feature"><h2>模型服务</h2><p>{modelSnapshot.loading ? "正在载入模型设置…" : "模型配置状态未知，请重新读取。"}</p></section>}      <section className="settings-card"><div className="settings-card-header"><div><h2>多模态搜索索引</h2><p>启用后可按意思或图片找记录，使用百炼服务并可能产生费用。</p></div><span className={`status ${indexFresh && searchIndex?.state === "ready" ? "status-complete" : searchIndex?.state === "failed" ? "status-failed" : "status-partial"}`}>{indexSnapshot.loading ? "正在读取" : indexSnapshot.error || !searchIndex ? "状态未知" : searchIndex.state === "ready" ? "已就绪" : searchIndex?.state === "checking" ? "检查中" : searchIndex?.state === "building" ? "构建中" : searchIndex?.state === "failed" ? "构建失败" : searchIndex?.state === "paused" ? "已暂停" : "未建立"}</span></div><div className="settings-form"><SnapshotNotice name="索引状态" snapshot={indexSnapshot} /><div className="capability-grid"><span className={!indexFresh ? "pending" : searchIndex?.inputModalities.includes("text") ? "ready" : "unavailable"}>文字索引 · {!indexFresh ? "状态未知" : searchIndex?.inputModalities.includes("text") ? "可用" : "未配置"}</span><span className={!indexFresh ? "pending" : searchIndex?.inputModalities.includes("image") ? "ready" : "unavailable"}>图片索引 · {!indexFresh ? "状态未知" : searchIndex?.inputModalities.includes("image") ? "可用" : "未配置"}</span><span className={!indexFresh ? "pending" : searchIndex?.queryModalities.includes("audio") ? "pending" : "unavailable"}>音频查询{searchIndex?.queryModalities.includes("audio") ? "（待实测）" : ""}</span><span className={!indexFresh ? "pending" : searchIndex?.queryModalities.includes("video") ? "pending" : "unavailable"}>视频查询{searchIndex?.queryModalities.includes("video") ? "（待实测）" : ""}</span></div><Disclosure title="索引与媒体查询详情"><p className="capability-help">仅索引已经正式保存的记录；新代际完整成功后才替换旧索引。音视频查询会先经已启用的百炼 Omni 模型生成当次临时描述，再匹配正式报告中带原件定位的经过片段；不是音视频原件的全量索引。查询媒体和临时描述不会入库。真实 API 与长媒体尚待本机验证；超限或不支持的格式会报错，不会上传到公开 URL。</p></Disclosure>{searchIndex?.fragmentCount ? <div className="storage-row"><span>当前片段</span><strong>{searchIndex.fragmentCount}</strong></div> : null}{searchIndex?.state === "checking" && <div className="banner notice">正在只读核对索引覆盖；确认需要更新后才会请求向量模型，可以随时暂停。</div>}{searchIndex?.lastError && <div className="banner error">{searchIndexFailureMessage(searchIndex.lastError)}</div>}{indexMessage && <div className="banner notice">{indexMessage}</div>}<button className="primary" disabled={indexBusy || !indexFresh || searchIndex?.state === "checking" || searchIndex?.state === "building" || !searchIndex?.available} onClick={() => void rebuildIndex()}>{searchIndex?.state === "checking" ? "正在检查现有索引…" : indexBusy || searchIndex?.state === "building" ? "正在后台构建…" : searchIndex?.state === "paused" ? "恢复并更新索引" : searchIndex?.state === "ready" ? "重建索引" : "建立索引"}</button>{searchIndex?.enabled && <button disabled={indexBusy} onClick={() => void pauseIndex()}>暂停语义查询与自动更新</button>}{indexFresh && !searchIndex?.available && <p className="capability-help">请先连接百炼；MiniMax 可继续作为主分析模型，但当前没有经验证的同空间向量接口。</p>}</div></section>
</div>
    <div className="settings-group" hidden={group !== "import"}>
      <section className="settings-card">
        <div className="settings-card-header"><div><h2>Day One</h2><p>手动导出、按需导入；本版不连接或定时读取 Day One。</p></div></div>
        <div className="settings-form">
          <strong>导入 Day One JSON 导出包</strong>
          <p className="capability-help">在 Day One 选择“文件 → 导出 → JSON”，再选择生成的 ZIP。应用逐条筛选后才保存相关事件。</p>
          <Disclosure title="导入、更新与费用说明">          <p className="capability-help">请在 Day One 中选择“文件 → 导出 → JSON”，然后选择生成的 ZIP（内含 JSON 与媒体文件夹）。应用逐条筛选后才保存相关内容；原 ZIP 和 Day One 日记保持原样。再次导出并导入可检查新版本，但不会自动同步。新版会比较实际媒体内容；此前已导入的含媒体条目在首次重导时可能额外筛选一次并产生模型费用。</p></Disclosure>
          {zipStatus.progress && <div className={`banner ${zipStatus.progress.phase === "failed" ? "error" : "notice"}`} role="status" aria-label="Day One 导入进度">{dayOneImportProgressLabel(zipStatus.progress)}</div>}
          {zipStatus.progress?.receiptSaved !== undefined && <p className="capability-help" aria-label="Day One 导入结束时间">{dayOneImportEndTimeLabel(zipStatus.progress.updatedAt)}</p>}
          {zipStatus.progress?.receiptSaved === false && <p className="inline-warning" role="status">未能保存本次批次摘要，重开后不能查看这次汇总；已处理的记录不受影响，请勿仅为补摘要重新导入。</p>}
          {zipStatus.progress && !["selecting", "previewing", "confirming"].includes(zipStatus.progress.phase) && <p className="capability-help" role="status" aria-label="Day One 筛选用量">{dayOneImportUsageLabel(zipStatus.progress.usage)}</p>}
          {!zipActive && !zipStatus.loading && zipStatus.progress?.receiptSaved === undefined && !lastZip.loading && !lastZip.unavailable && lastZip.receipt && <div role="status" aria-label="Day One 上次导入摘要">
            <p className="capability-help">{dayOneImportEndTimeLabel(lastZip.receipt.finishedAt)}</p>
            <div className={`banner ${lastZip.receipt.outcome === "failed" ? "error" : "notice"}`}>{dayOneImportReceiptLabel(lastZip.receipt)}</div>
            <p className="capability-help">{dayOneImportUsageLabel(lastZip.receipt.usage)}</p>
          </div>}
          {!zipActive && !zipStatus.loading && zipStatus.progress?.receiptSaved === undefined && !lastZip.loading && !lastZip.unavailable && !lastZip.receipt && <p className="capability-help">尚无已保存的批次摘要；旧版导入不会自动补记。这里不代表 Day One 全部历史已检查。</p>}
          {lastZip.unavailable && <p className="inline-warning" role="status">暂时无法读取上次导入摘要；不会重新开始导入。<button onClick={() => void lastZip.reload()}>重新读取摘要</button></p>}
          {!zipStatus.progress && zipMessage && <div className="banner notice">{zipMessage}</div>}
          {zipStatus.unavailable && <p className="inline-warning" role="status">暂时无法读取导入进度，正在重新连接；不会重新开始导入。</p>}
          <button className="primary" disabled={zipActive || zipStatus.loading || zipStatus.unavailable || !modelFresh || !settings?.activeProvider} onClick={() => void importZip()}>{zipActive ? zipStatus.progress ? dayOneImportPhaseLabel(zipStatus.progress) : "正在准备导入…" : "选择 Day One 导出 ZIP"}</button>
          {zipStatus.progress?.phase === "screening" && <button disabled={zipControlBusy || zipStatus.unavailable} onClick={() => void controlZipPause(false)}>暂停筛选</button>}
          {zipStatus.progress && ["pausing", "paused"].includes(zipStatus.progress.phase) && <button disabled={zipControlBusy || zipStatus.unavailable} onClick={() => void controlZipPause(true)}>{zipStatus.progress.phase === "pausing" ? "撤销暂停" : "继续筛选"}</button>}
          {zipActive && <button disabled={zipStatus.progress?.phase === "stopping"} onClick={() => void cancelZip()}>停止本次导入</button>}
          {!modelFresh ? <p className="capability-help">模型配置尚未完成读取，暂不能开始新的筛选导入。</p> : !settings?.activeProvider && <p className="capability-help">最后在本机连接并启用模型服务后，即可执行真实筛选导入。</p>}
        </div>
      </section>
      <section className="settings-card"><div className="settings-card-header"><div><h2>迁移与存储</h2><p>旧工作区保持不变，相关记录在当前新版工作区中重新加密。</p></div></div><div className="settings-form">{migrationMessage && <div className="banner notice">{migrationMessage}</div>}<button className="primary" disabled={migrationBusy || !modelFresh || !settings?.activeProvider} onClick={() => void migrateLegacy()}>{migrationBusy ? "正在逐条迁移…" : "选择旧工作区并开始筛选迁移"}</button>{migrationBusy && <button onClick={() => void cancelLegacy()}>停止本次迁移</button>}<p className="capability-help">只接受格式版本 1／2。修订、来源映射和所需附件随正式记录迁移；普通日常不会复制，无法完整检查的内容进入待确认。</p>{!modelFresh ? <p className="capability-help">模型配置尚未完成读取，暂不能开始新的迁移。</p> : !settings?.activeProvider && <p className="capability-help">请先连接并启用模型服务。</p>}</div></section></div>
    <div className="settings-group" hidden={group !== "privacy"}>
      <section className="settings-card"><div className="settings-card-header"><div><h2>数据如何保存与使用</h2><p>本机保存和模型服务是两个不同的边界。</p></div></div><div className="settings-form privacy-facts"><p><strong>原始附件：</strong>加密保存在本机工作区。</p><p><strong>记录正文、报告及搜索索引：</strong>保存在本机数据库，未做整库加密；工作区锁定不能替代磁盘加密。</p><p><strong>模型服务：</strong>筛选与分析会发送文字和附件，语义查询与索引会发送对应内容。服务商可能计费，并按其政策留存。</p><p><strong>尚未收录的输入：</strong>完整编辑内容只在内存中；待确认只保存加密的短摘录，不代表原文已经保存。</p></div></section>
      {group === "privacy" && <WorkspacePasswordSettings />}<AutoLockSettings />      <section className="settings-card"><div className="settings-card-header"><div><h2>法律地域</h2><p>用于报告中的法律问题整理；不会自动生成确定结论。</p></div></div><div className="settings-form"><SnapshotNotice name="默认地域" snapshot={legalSnapshot} /><label className="field">默认地域<input maxLength={200} disabled={legalBusy || !legalFresh} value={defaultJurisdiction} onChange={(event) => { legalDraftDirty.current = true; setDefaultJurisdiction(event.target.value); setLegalMessage(""); }} placeholder="例如：中国大陆" /></label>{legalMessage && <div className="banner notice">{legalMessage}</div>}<button className="primary" disabled={legalBusy || !legalFresh || !defaultJurisdiction.trim()} onClick={() => void saveDefaultJurisdiction()}>{legalBusy ? "正在保存…" : "保存默认地域"}</button><Disclosure title="法律检索与隐私说明"><div className="banner neutral">启用百炼 qwen3.8-omni-flash 后，中国大陆权益报告会尽量删去姓名、联系方式等标识，再将法律问题联网检索，并重新读取官方网页核对标题与原文摘录；请勿在法律问题中输入不必要的私密信息。具体法律适用性和事发时点仍标“依据待核验”。其他地域暂不检索。</div></Disclosure></div></section>
</div>
  </div>;
}

export function App() {
  const [view, setView] = useState<MainView>("timeline");
  const [settingsTarget, setSettingsTarget] = useState<SettingsGroup>("model");
  const [settingsNavigationId, setSettingsNavigationId] = useState(0);
  const [showNew, setShowNew] = useState(false); const [showPending, setShowPending] = useState(false);
  const [reprovidePendingId, setReprovidePendingId] = useState<string>();
  const [timelineKey, setTimelineKey] = useState(0);
  const [openRecordId, setOpenRecordId] = useState<string>();
  const clearSessionUi = useCallback(() => {
    setShowNew(false); setShowPending(false); setReprovidePendingId(undefined); setOpenRecordId(undefined); setView("timeline");
  }, []);
  const { status: workspaceStatus, ready, error: workspaceError, session, isCurrentSession,
    refreshWorkspace, pending, pendingLoading, pendingError, refreshPending } = useWorkspaceSession(WORKSPACE_SESSION_ACCESS, clearSessionUi);
  const refreshVisiblePending = async () => { if (isCurrentSession(session)) await refreshPending(); };
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!isCurrentSession(session) || showNew || showPending || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLocaleLowerCase("en-US");
      if (key === "n") {
        event.preventDefault(); setShowNew(true);
      } else if (key === "k") {
        event.preventDefault(); setView("search");
        globalThis.requestAnimationFrame(() => { if (isCurrentSession(session)) document.getElementById("global-search-input")?.focus(); });
      }
    };
    globalThis.addEventListener("keydown", handleShortcut);
    return () => globalThis.removeEventListener("keydown", handleShortcut);
  }, [isCurrentSession, session, showNew, showPending]);
  const openSaved = (id: string) => { if (!isCurrentSession(session)) return; setOpenRecordId(id); setShowNew(false); setShowPending(false); setReprovidePendingId(undefined); setView("timeline"); setTimelineKey((value) => value + 1); void refreshPending(); };
  const openPending = () => { if (!isCurrentSession(session)) return; setShowPending(true); void refreshPending(); };
  if (!ready) return <div className="loading full">正在打开你的账本…</div>;
  if (workspaceError) return <main className="landing"><section className="landing-card"><h1>暂时无法读取账本</h1><p role="alert">{displayError(workspaceError)}</p><button onClick={() => void refreshWorkspace()}>重新读取状态</button><p>请重新读取，确认你的账本状态。</p></section></main>;
  if (workspaceStatus.status !== "open") return <WorkspaceLanding status={workspaceStatus} onChanged={refreshWorkspace} />;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span aria-hidden="true"><Icon name="record" /></span><strong>Grudge Vault</strong></div><nav aria-label="主要导航"><button aria-label="时间线" className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><Icon name="timeline" />时间线</button><button aria-label="搜索" className={view === "search" ? "active" : ""} onClick={() => setView("search")}><Icon name="search" />搜索</button><button aria-label="设置" className={view === "settings" ? "active" : ""} onClick={() => { setSettingsTarget("model"); setSettingsNavigationId(value => value + 1); setView("settings"); }}><Icon name="settings" />设置</button></nav><button className="new-record-button" aria-label="新建记录" onClick={() => setShowNew(true)}><Icon name="plus" /><span>新建记录</span></button><div className="workspace-chip"><span>{workspaceStatus.workspace.name}</span><button onClick={() => void window.grudgeVault.workspace.lock().then(() => refreshWorkspace())}>锁定</button></div></aside>
    <main className="main-content" key={`content-${session.version}`}>{Boolean(pendingError) && !showPending && <div className="banner error" role="alert">暂时无法读取待确认：{displayError(pendingError)}<button onClick={() => void refreshVisiblePending()}>重新读取待确认</button></div>}{view === "timeline" && <TimelineView key={timelineKey} onNew={() => setShowNew(true)} onSettings={() => { setSettingsTarget("import"); setView("settings"); }} pendingCount={pending.length} onPending={openPending} {...(openRecordId ? { openRecordId } : {})} onRecordOpened={() => { if (isCurrentSession(session)) setOpenRecordId(undefined); }} />}{view === "search" && <SearchView onSettings={() => { setSettingsTarget("model"); setSettingsNavigationId(value => value + 1); setView("settings"); }} />}{view === "settings" && <SettingsView initialGroup={settingsTarget} navigationId={settingsNavigationId} onDataChanged={() => { if (!isCurrentSession(session)) return; setTimelineKey((value) => value + 1); void refreshPending(); }} />}</main>
    {showNew && <NewRecordDialog key={`intake-${session.version}`} onClose={() => { if (!isCurrentSession(session)) return; setShowNew(false); setReprovidePendingId(undefined); void refreshPending(); }} onSaved={openSaved} onPendingChanged={() => { void refreshVisiblePending(); }} onRescreenSettled={() => { if (!isCurrentSession(session)) return; setReprovidePendingId(undefined); void refreshPending(); }} {...(reprovidePendingId ? { reprovidePendingId, reprovideItem: pending.find(({ id }) => id === reprovidePendingId) } : {})} />}
    {showPending && <PendingDrawer key={`pending-${session.version}`} items={pending} loading={pendingLoading} loadError={pendingError ? displayError(pendingError) : ""} onClose={() => { if (isCurrentSession(session)) setShowPending(false); }} onChanged={refreshVisiblePending} onSaved={openSaved} onReprovide={(id) => { if (!isCurrentSession(session)) return; setShowPending(false); setReprovidePendingId(id); setShowNew(true); }} />}
  </div>;
}
