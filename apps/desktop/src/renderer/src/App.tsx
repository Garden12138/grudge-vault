import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import type {
  Asset, EventCategory, EventRecord, EventRecordDetail, LlmModelOption, LlmSettings, PendingReview, RecordSearchIndexStatus,
  RecordOrigin, RecordSearchHit, RecordSearchPage, RecordSearchQuery, ReportClarification, SourceAnchor, TimelineFilter, WorkspaceLockState,
  WorkspaceSecuritySettings, TemporalValue
} from "@grudge-vault/domain";
import { APP_ERROR_CODES, codePointLength, RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT } from "@grudge-vault/shared";
import type { AppErrorCode, IpcResult } from "@grudge-vault/shared";
import { mediaAnchorSeek } from "./media-anchor";
import { matchesTestedModelConfiguration } from "./model-configuration";
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
import { dateLabel, occurrenceTimeLabel, recordTimeSourceLabel, temporalLabel, timelineGroupLabel } from "./record-time";
import { searchCoverageMessage, searchIndexIncomplete } from "./search-coverage";
import { RecordTimeEditor } from "./record-time-editor";

type MainView = "timeline" | "search" | "settings";
type IntakeState = "editing" | "preparing" | "screening" | "skipped" | "review" | "failed";
const READ_DAYONE_RECEIPT = async () => unwrap(await window.grudgeVault.intake.lastDayOneImportReceipt());
const READ_SEARCH_INDEX_STATUS = async () => unwrap(await window.grudgeVault.records.searchIndexStatus());
const READ_MODEL_SETTINGS = async () => unwrap(await window.grudgeVault.llm.getSettings());
const READ_DEFAULT_JURISDICTION = async () => unwrap(await window.grudgeVault.legal.getDefaultJurisdiction());
const SUBSCRIBE_JOB_READS = (listener: () => void) => window.grudgeVault.jobs.onChanged(listener);
const NO_STATUS_PUBLICATION = () => {};

const CATEGORY_LABEL: Record<EventCategory, string> = { grudge: "冲突", rights: "权益", danger: "危险" };
const ORIGIN_LABEL: Record<RecordOrigin, string> = { manual: "手动记录", dayone: "Day One", zip: "ZIP 导入", migration: "旧数据迁移" };
const REPORT_LABEL: Record<EventRecord["reportState"], string> = {
  queued: "等待分析", running: "分析中", partial: "部分完成", failed: "分析失败", complete: "已完成", stale: "报告待更新"
};

class UiError extends Error {
  constructor(readonly code: AppErrorCode, message: string, readonly retryable: boolean) { super(message); }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new UiError(result.error.code, result.error.message, result.error.retryable);
  return result.data;
}

const RECORD_DETAIL_ACCESS: RecordDetailAccess = {
  read: async (id) => unwrap(await window.grudgeVault.records.get(id)),
  subscribe: (listener) => window.grudgeVault.jobs.onChanged(listener)
};
const TIMELINE_ACCESS: TimelineAccess = {
  read: async (filter) => unwrap(await window.grudgeVault.records.timeline(filter)),
  subscribe: (listener) => window.grudgeVault.jobs.onChanged(listener)
};
const INTAKE_PROGRESS: MediaProgressSubscription = (listener) => window.grudgeVault.intake.onMediaProgress(listener);
const SEARCH_PROGRESS: MediaProgressSubscription = (listener) => window.grudgeVault.records.onSearchMediaProgress(listener);
const READ_DAYONE_PROGRESS = async () => unwrap(await window.grudgeVault.intake.dayOneImportProgress());
const WORKSPACE_SESSION_ACCESS: WorkspaceSessionAccess = {
  status: async () => unwrap(await window.grudgeVault.workspace.status()),
  pending: async () => unwrap(await window.grudgeVault.pending.list()),
  onLocked: (listener) => window.grudgeVault.workspace.onLocked(listener)
};

function displayError(error: unknown): string {
  if (error instanceof UiError) {
    const known: Partial<Record<AppErrorCode, string>> = {
      MODEL_NOT_CONFIGURED: "请先在设置中连接并启用百炼或 MiniMax。",
      MODALITY_UNAVAILABLE: "当前模型无法完整处理所选媒体。MiniMax 主模型的音视频任务需要先在设置中配置并测试百炼 Omni 辅助能力；也可启用百炼 Omni 作为主模型。若仍超出分段限制或格式不支持，请调整原件后重试。",
      LLM_AUTHENTICATION_FAILED: "模型密钥验证失败，请在设置中检查密钥并重新测试连接。",
      LLM_REGION_MISMATCH: "模型密钥与百炼地域可能不匹配，请检查设置后重新测试连接。",
      LLM_CONFIGURATION_CHANGED: "工作区或模型配置已变化，原任务已失效，请按当前配置重新执行。",
      LLM_MODEL_NOT_FOUND: "所选模型不可用，请在设置中检查模型 ID。",
      LLM_TOOL_UNSUPPORTED: "所选模型不支持本次结构化判断，请在设置中换用支持的模型。",
      LLM_RATE_LIMITED: "模型服务暂时限流；输入仍在编辑器中，请稍后重试。",
      SOURCE_UNAVAILABLE: "原始输入已失效或附件发生变化，请重新选择完整内容。",
      SCREENING_FAILED: "未完成判断，请重试。",
      CLEANUP_FAILED: "清理临时内容失败，请先检查工作区状态，不要重复提交。",
      REVISION_CONFLICT: "记录已在其他位置更新，请重新载入后再保存。",
      WORKSPACE_MIGRATION_REQUIRED: "这是旧版工作区。请先创建独立的新版工作区，再从设置中筛选迁移。",
      ASSET_PREVIEW_UNAVAILABLE: "这个原件超出当前安全预览能力或预览占用达到上限；请先关闭其他预览，或保存原始副本后查看。",
      ASSET_CORRUPT: "原件完整性校验失败，暂时不能预览。"
    };
    return known[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : "发生了未知错误。";
}

function searchIndexFailureMessage(code: string): string {
  if (code === "MODALITY_UNAVAILABLE") return "索引中有当前向量模型无法处理或超过大小限制的附件；请检查后重建。";
  if (code === "MODEL_NOT_CONFIGURED" || code === "LLM_AUTHENTICATION_FAILED" || code === "LLM_REGION_MISMATCH") {
    return "索引构建失败：请检查百炼连接、密钥和地域后重试。";
  }
  if (code === "JOB_STATE_CONFLICT") return "索引构建已暂停；恢复后可以重新建立。";
  return "索引构建失败。请检查模型连接与正式附件后重试；持续失败时可暂时使用关键词搜索。";
}

function Landing({ status, onChanged }: { status: WorkspaceLockState; onChanged(): Promise<void> }) {
  const [name, setName] = useState("我的事件账本");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<IpcResult<unknown>>) => {
    setBusy(true); setError("");
    try { unwrap(await action()); await onChanged(); }
    catch (cause) {
      setError(displayError(cause));
      // Opening may fail after the manager has moved to a locked recovery state.
      await onChanged().catch(() => {});
    }
    finally { setBusy(false); }
  };
  return <main className="landing">
    <section className="landing-card">
      <p className="eyebrow">GRUDGE VAULT</p>
      <h1>把重要的事，留下依据</h1>
      <p className="lede">只收录与你的冲突、权益或安全有关的具体事件。普通日常不会进入账本。</p>
      {error && <div className="banner error" role="alert">{error}</div>}
      {status.status === "locked" ? <>
        <div className="workspace-summary"><strong>{status.workspaceName}</strong><span>工作区已锁定</span></div>
        <button className="primary wide" disabled={busy} onClick={() => void run(() => window.grudgeVault.workspace.unlock())}>解锁工作区</button>
      </> : <>
        <label className="field">工作区名称<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
        <div className="landing-actions">
          <button className="primary" disabled={busy || !name.trim()} onClick={() => void run(() => window.grudgeVault.workspace.create(name.trim()))}>创建新工作区</button>
          <button disabled={busy} onClick={() => void run(() => window.grudgeVault.workspace.open())}>打开已有工作区</button>
        </div>
      </>}
      <p className="security-note">原始附件写入加密对象库；结构化索引的本地加密边界以当前工作区实现为准。</p>
    </section>
  </main>;
}

function StatusBadge({ record }: { record: EventRecord }) {
  const state = record.sourceReviewRequired ? "stale" : record.reportState;
  return <span className={`status status-${state}`}>{record.sourceReviewRequired ? "来源待核对" : REPORT_LABEL[state]}</span>;
}

function RecordCard({ record, selected, onOpen, timeZone }: { record: EventRecord; selected: boolean; onOpen(): void; timeZone?: string | undefined }) {
  return <button className={`record-card${selected ? " selected" : ""}`} onClick={onOpen}>
    <div className="record-card-top"><span>{temporalLabel(record, timeZone)}{recordTimeSourceLabel(record) &&
      <small className="record-time-source" title="时间来源不等于事实已核实">{recordTimeSourceLabel(record)}</small>}</span><StatusBadge record={record} /></div>
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
    <div className="empty-icon">◎</div><h2>还没有正式记录</h2>
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
  return <section className="detail-panel">
    <header className="detail-header">
      <button className="text-button" onClick={onBack}>← {backLabel}</button>
      <div><div className="chips">{record.categories.map((category) => <span className={`chip chip-${category}`} key={category}>{CATEGORY_LABEL[category]}</span>)}</div><h2>{record.title}</h2><p>{temporalLabel(record, timeZone)} · {ORIGIN_LABEL[record.origin]}{recordTimeSourceLabel(record) &&
        <small className="record-time-source" title="时间来源不等于事实已核实">{recordTimeSourceLabel(record)}</small>}</p><button className="text-button" onClick={() => beginEdit("title", record.title)}>编辑标题</button></div>
      <StatusBadge record={record} />
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
      {!report && <div className="report-placeholder"><h3>{record.sourceReviewRequired ? "来源待核对" : record.reportState === "failed" ? "分析未完成" : "报告正在生成"}</h3><p>正式记录已经安全保存。分析失败不会丢失原文或原件。</p>{record.reportState === "failed" && <button className="primary" disabled={busy} onClick={() => void reanalyze()}>重试分析</button>}{activeAnalysisJobId && <button disabled={busy} onClick={() => void cancelAnalysis()}>取消分析</button>}</div>}
      {report && <>
        {(record.reportState === "queued" || record.reportState === "running") && <div className="banner notice">当前展示上一版报告，新报告完成后会自动切换。{activeAnalysisJobId && <button disabled={busy} onClick={() => void cancelAnalysis()}>取消分析</button>}</div>}
        {record.reportState === "stale" && !record.sourceReviewRequired && <div className="banner notice">当前报告尚未包含最新补充信息；点击“重新分析”后才会生成新版报告。</div>}
        {record.reportState === "failed" && <div className="banner error" role="alert">新报告分析失败，当前仍展示上一版成功报告。<button disabled={busy} onClick={() => void reanalyze()}>重试分析</button></div>}
        {record.reportState === "partial" && <div className="banner notice">部分内容尚未完成处理；已完成的报告仍可查看。<button disabled={busy} onClick={() => void reanalyze()}>重试未完成分析</button></div>}
        <section className="report-section"><h3>事件摘要</h3><p className="report-summary">{report.content.summary}</p></section>
        <section className="report-section field-grid">
          <ReportTimeField field={report.content.time} userSupplied={Boolean(occurredAtOverride)} userKind={record.occurredAt.kind} {...(occurredAtOverride && record.occurredAt.kind !== "unknown" ? { userValue: occurrenceTimeLabel(record, timeZone) } : {})} />
          <ReportField label="地点" value={String(locationOverride?.value ?? report.content.location.value ?? "")} prompt={report.content.location.prompt ?? "待补充：事情发生在哪里？"} source={locationOverride ? "user" : report.content.location.source} />
          <ReportPeopleField people={report.content.people} disabled={busy} onSupplement={() => editClarification("unknown", "有哪些相关人物及角色？")} />
          <ReportField label="报告版本" value={`记录修订 ${report.recordRevision}`} source="ai" />
        </section>
        <section className="report-section"><h3>事件经过</h3>{report.content.chronology.length ? <ol className="chronology">{report.content.chronology.map((step) => <li key={step.id}>{step.anchor ? <button className="anchor-link" onClick={() => { setActiveAnchor(step.anchor); setTab("source"); }}>{step.text}<span>查看对应原始内容</span></button> : step.text}</li>)}</ol> : <p className="muted">尚未整理出明确经过。</p>}</section>
        {(report.content.mediaSegments?.length ?? 0) > 0 && <section className="report-section"><h3>媒体片段</h3><p className="muted">以下是模型生成的描述与建议定位，请对照原件核实。</p><ol className="chronology">{report.content.mediaSegments!.map((segment) => <li key={segment.id}><button className="anchor-link" onClick={() => { setActiveAnchor(segment.anchor); setTab("source"); }}>{segment.description}<span>查看对应原始内容</span></button></li>)}</ol></section>}
        <section className="report-section split-sections"><div><h3>缺失与争议</h3>
          {report.content.unknowns.length > 0 && <><h4>待补充</h4><ul>{issueItems("unknown", report.content.unknowns)}</ul></>}
          {report.content.disputes.length > 0 && <><h4>存在争议</h4><ul>{issueItems("dispute", report.content.disputes)}</ul></>}
          {(report.content.speculations?.length ?? 0) > 0 && <><h4>待核对推测</h4><ul>{issueItems("speculation", report.content.speculations ?? [])}</ul></>}
          {report.content.unknowns.length === 0 && report.content.disputes.length === 0 &&
            (report.content.speculations?.length ?? 0) === 0 && <p className="muted">当前报告没有列出缺失、争议或推测。</p>}
          {unmatchedClarifications.length > 0 && <div className="prior-clarifications"><h4>此前补充的问题</h4><ul>{unmatchedClarifications.map(({ kind, topic, response }) => <li key={`${kind}-${topic}`}><span>{topic}</span><p className="clarification-response">你已补充（用户陈述，待核对）：{response}</p><button className="text-button" disabled={busy} onClick={() => editClarification(kind, topic)}>修改此项补充</button></li>)}</ul></div>}
          {clarificationEditor && <div className="inline-editor clarification-editor"><label>针对“{clarificationEditor.topic}”的补充说明<textarea autoFocus maxLength={2_000} value={clarificationValue} onChange={(event) => setClarificationValue(event.target.value)} /></label><button className="primary" disabled={busy || !clarificationValue.trim()} onClick={() => void saveClarification()}>保存补充</button><button disabled={busy} onClick={() => setClarificationEditor(undefined)}>取消</button></div>}
        </div><div><h3>解决建议</h3><ol>{report.content.suggestions.map((item, index) => <li key={index}>{item}</li>)}</ol></div></section>
        {record.categories.includes("rights") && <section className="report-section legal"><h3>法律视角</h3>{reportMatchesCurrentRevision ? <><p className="muted">法域：{String(jurisdictionOverride?.value ?? defaultJurisdiction)} · 下列内容是待核验问题，不是确定法律结论。</p><ul>{report.content.legalIssues.map((item, index) => <li key={index}>{item}</li>)}</ul>{report.content.citations.length === 0 ? <span className="verification-pending">依据待核验</span> : <ul className="citation-list">{report.content.citations.map((citation) => <CitationCard citation={citation} issues={report.content.legalIssues} onOpen={openCitation} key={citation.id} />)}</ul>}</> : <p className="verification-pending" role="status">记录已有新的补充或来源版本；旧报告的法律问题与依据暂不展示。请重新分析后核对当前法域、事实和事发时间。</p>}</section>}
        {report.content.coverageNotes.length > 0 && <section className="report-section warning"><h3>覆盖限制</h3><ul>{report.content.coverageNotes.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      </>}
      <section className="report-section supplement"><h3>补充信息</h3>{editField === "occurredAt"
        ? <RecordTimeEditor initialValue={record.occurredAt} busy={busy} onSave={saveTime} onCancel={() => setEditField(null)} />
        : editField ? <div className="inline-editor"><input autoFocus type="text" value={editValue} placeholder={editField === "title" ? "输入标题" : editField === "location" ? "输入明确地点" : "输入适用法域"} onChange={(event) => setEditValue(event.target.value)} /><button className="primary" disabled={busy || !editValue.trim()} onClick={() => void saveField()}>保存</button><button onClick={() => setEditField(null)}>取消</button></div> : <div className="supplement-actions"><button onClick={() => beginEdit("occurredAt")}>补充时间</button><button onClick={() => beginEdit("location")}>补充地点</button>{record.categories.includes("rights") && <button onClick={() => beginEdit("jurisdiction", String(jurisdictionOverride?.value ?? defaultJurisdiction))}>修改法域</button>}</div>}<button disabled={busy} onClick={() => void reanalyze()}>重新分析</button></section>
    </div>}
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
  const listScrollPosition = useRef(0);
  const { records, nextCursor, timeZone: resultTimeZone, loading, refreshing, loadingMore, error: readError,
    reload: load, loadMore } = useTimelineRecords(TIMELINE_ACCESS, filter);
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
  const groups = new Map<string, EventRecord[]>();
  records.forEach((record) => { const key = timelineGroupLabel(record, resultTimeZone); groups.set(key, [...(groups.get(key) ?? []), record]); });
  return <div className="page timeline-page">
    <header className="page-header"><div><p className="eyebrow">事件账本</p><h1>时间线</h1><p>这里只显示已经通过筛选并正式保存的记录。</p></div><div className="header-actions"><button onClick={onPending}>待确认{pendingCount > 0 && <b>{pendingCount}</b>}</button><button className="primary" onClick={onNew}>＋ 新建记录</button></div></header>
    <div className="filter-bar">
      <label>类别<select value={filter.category ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.category; return event.target.value ? { ...next, category: event.target.value as EventCategory } : next; })}><option value="">全部</option><option value="grudge">冲突</option><option value="rights">权益</option><option value="danger">危险</option></select></label>
      <label>来源<select value={filter.origin ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.origin; return event.target.value ? { ...next, origin: event.target.value as RecordOrigin } : next; })}><option value="">全部</option><option value="manual">手动记录</option><option value="dayone">Day One</option><option value="zip">ZIP 导入</option><option value="migration">旧数据迁移</option></select></label>
      <label>从<input type="date" value={filter.from ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.from; return event.target.value ? { ...next, from: event.target.value } : next; })} /></label>
      <label>至<input type="date" value={filter.to ?? ""} onChange={(event) => setFilter((current) => { const next = { ...current }; delete next.to; return event.target.value ? { ...next, to: event.target.value } : next; })} /></label>
      <button className="text-button" onClick={() => setFilter({ limit: 60 })}>清除筛选</button>
    </div>
    <p className="muted">月份与时间范围按可能重叠筛选；时间未确定时按记录日期。明确时刻按本次查询的本地日期。</p>
    {selectionMessage && <div className="banner error" role="alert">{selectionMessage}</div>}
    {error && <div className="banner error" role="alert">{records.length ? "列表读取未完成；当前保留上次成功读取的内容。" : "暂时无法读取时间线；不能据此判断没有记录。"} {error}<button onClick={() => void load()}>重新载入时间线</button></div>}
    {refreshing && records.length > 0 && <p className="muted" role="status">正在更新列表；当前展示上次成功读取的内容。</p>}
    {loading || (refreshing && records.length === 0) ? <div className="loading" role="status">正在载入时间线…</div> : records.length === 0 ? error ? <p className="muted">未完成读取，请重新载入后查看。</p> : <EmptyTimeline onNew={onNew} onSettings={onSettings} /> : <div className="timeline-groups">{[...groups].map(([date, items]) => <section key={date}><h2>{date}</h2><div className="record-grid">{items.map((record) => <RecordCard key={record.id} record={record} timeZone={resultTimeZone} selected={false} onOpen={() => void open(record.id)} />)}</div></section>)}{nextCursor && <button className="load-more" disabled={loadingMore || refreshing} onClick={() => void loadMore()}>{loadingMore ? "正在载入…" : "载入更多"}</button>}</div>}
  </div>;
}

function NewRecordDialog({ onClose, onSaved, onPending, reprovidePendingId, reprovideOrigin, onRescreenSettled }: {
  onClose(): void; onSaved(id: string): void; onPending(): void;
  reprovidePendingId?: string; reprovideOrigin?: RecordOrigin | undefined; onRescreenSettled(): void;
}) {
  const dialogRef = useModalFocus<globalThis.HTMLElement>();
  const [text, setText] = useState(""); const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<IntakeState>("editing"); const [message, setMessage] = useState("");
  const sessionId = useRef<string | undefined>(undefined); const cancelled = useRef(false);
  const pendingPreparation = useRef<string | undefined>(undefined);
  const submitting = useRef(false);
  const { progress: mediaProgress, clear: clearMediaProgress } = useMediaProgress(INTAKE_PROGRESS, sessionId, submitting);
  const busy = state === "preparing" || state === "screening";
  const textLength = codePointLength(text);
  const textTooLong = textLength > RECORD_TEXT_LIMIT;
  const needsMediaSegmentation = files.some((file) => /\.(mp3|m4a|wav|mp4|mov)$/i.test(file.name) &&
    (file.size > 7_000_000 || /\.m4a$/i.test(file.name)));
  const exceedsImageInput = files.some((file) => /\.(jpe?g|png|webp|heic)$/i.test(file.name) && file.size > 20 * 1024 * 1024);
  const hasUnverifiedFormat = files.some((file) => /\.(m4a|heic)$/i.test(file.name));
  const appendFiles = (incoming: File[]) => {
    if (submitting.current || incoming.length === 0) return;
    if (files.length + incoming.length > 20) {
      setState("editing"); setMessage("一次最多选择 20 个附件；本次选择未添加。"); return;
    }
    if (incoming.some(({ size }) => size > 500 * 1024 * 1024)) {
      setState("editing"); setMessage("单个附件不能超过 500 MB；本次选择未添加。"); return;
    }
    setFiles((current) => [...current, ...incoming]); setState("editing"); setMessage("");
  };
  const dropFiles = (event: DragEvent) => {
    event.preventDefault(); appendFiles(Array.from(event.dataTransfer.files));
  };
  const close = useCallback(async () => {
    if ((text.trim() || files.length) && !window.confirm(
      "当前编辑器中的完整输入尚未正式保存；待确认只保留最小摘录。关闭后完整输入无法恢复。确定放弃吗？"
    )) return;
    if (cancelled.current) return;
    cancelled.current = true;
    const pendingRequestId = pendingPreparation.current;
    pendingPreparation.current = undefined;
    const abandonedSessionId = sessionId.current;
    sessionId.current = undefined;
    try {
      await Promise.allSettled([
        ...(pendingRequestId ? [window.grudgeVault.intake.abandonPreparation(pendingRequestId)] : []),
        ...(abandonedSessionId ? [window.grudgeVault.intake.abandon(abandonedSessionId)] : [])
      ]);
    } finally {
      onClose();
    }
  }, [files.length, onClose, text]);
  useEffect(() => () => {
    const requestId = pendingPreparation.current;
    pendingPreparation.current = undefined;
    if (requestId) void window.grudgeVault.intake.abandonPreparation(requestId);
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void close();
    };
    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [close]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || cancelled.current) return;
    if (textTooLong) { setState("editing"); return; }
    submitting.current = true; clearMediaProgress(); setMessage(""); setState("preparing");
    try {
      if (sessionId.current) {
        const previousSessionId = sessionId.current;
        sessionId.current = undefined;
        unwrap(await window.grudgeVault.intake.abandon(previousSessionId));
      }
      if (cancelled.current) return;
      const requestId = globalThis.crypto.randomUUID();
      pendingPreparation.current = requestId;
      const prepared = unwrap(await window.grudgeVault.intake.prepare({ requestId, text, files }));
      if (pendingPreparation.current === requestId) pendingPreparation.current = undefined;
      sessionId.current = prepared.sessionId;
      if (cancelled.current) {
        sessionId.current = undefined;
        void window.grudgeVault.intake.abandon(prepared.sessionId);
        return;
      }
      setState("screening");
      const result = unwrap(await (reprovidePendingId
        ? window.grudgeVault.pending.rescreenManual(reprovidePendingId, prepared.sessionId)
        : window.grudgeVault.intake.screenAndSave(prepared.sessionId, globalThis.crypto.randomUUID())));
      if (reprovidePendingId && result.kind !== "failed") onRescreenSettled();
      if (cancelled.current) return;
      if (result.kind === "saved") { onSaved(result.recordId); return; }
      if (result.kind === "skipped") { setState("skipped"); setMessage("不属于收录范围。内容仍留在编辑器中，你可以修改后重新判断。"); return; }
      if (result.kind === "needs_review") { setState("review"); setMessage("无法确定是否与你有关，已加入待确认。正式时间线尚未建立记录。"); onPending(); return; }
      const code = APP_ERROR_CODES.find((known) => known === result.code);
      setState("failed"); setMessage(code
        ? displayError(new UiError(code, "未完成判断，请检查设置或重新提供输入。", result.retryable))
        : "未完成判断，请检查设置或重新提供输入。");
    } catch (cause) {
      pendingPreparation.current = undefined;
      if (!cancelled.current) { setState("failed"); setMessage(displayError(cause)); }
    }
    finally { submitting.current = false; }
  };
  return <div className="modal-backdrop" role="presentation"><section ref={dialogRef} tabIndex={-1} className="modal intake-modal" role="dialog" aria-modal="true" aria-labelledby="new-record-title">
    <header><div><p className="eyebrow">先判断，再保存</p><h2 id="new-record-title">{reprovidePendingId ? "重新提供并筛选" : "新建记录"}</h2></div><button className="icon-button" aria-label="关闭" onClick={() => void close()}>×</button></header>
    {reprovidePendingId && <p className="drawer-help">请重新输入完整原文并重选附件；待确认短摘录不会自动填入或代替原件。新内容会重新经过模型筛选。{reprovideOrigin === "migration" && "这会作为手动记录保存，不携带旧工作区的修订和来源映射；以后再次迁移原记录可能产生重复，请自行核对。"}</p>}
    <form onSubmit={(event) => void submit(event)}>
      <label className="field">发生了什么？<textarea autoFocus disabled={busy} value={text} aria-invalid={textTooLong || undefined} aria-describedby={textTooLong ? "record-text-count record-text-limit" : "record-text-count"} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter(({ type }) => type.startsWith("image/")); if (images.length) appendFiles(images); }} onChange={(event) => { if (submitting.current) return; setText(event.target.value); setState("editing"); setMessage(""); }} placeholder="写下具体经过、相关人物和你记得的细节…" /><small id="record-text-count">{textLength.toLocaleString()} / 50,000 字</small></label>
      {textTooLong && <p id="record-text-limit" className="inline-warning" role="alert">文字不能超过 50,000 字，请缩短后再保存。输入未被截断。</p>}
      <label className="file-drop" onDragOver={(event) => event.preventDefault()} onDrop={dropFiles}>添加或拖入图片、音频或视频<input type="file" aria-label="添加图片、音频或视频" multiple disabled={busy} accept="image/jpeg,image/png,image/webp,image/heic,audio/mpeg,audio/mp4,audio/wav,video/mp4,video/quicktime" onChange={(event) => { const incoming = Array.from(event.target.files ?? []); event.target.value = ""; appendFiles(incoming); }} /><span>也可直接粘贴图片（单张不超过 20 MB，合计不超过 64 MB）；本地文件可选择 JPEG、PNG、WebP、HEIC、MP3、M4A、WAV、MP4、MOV。500 MB 是单文件选择上限，不代表当前模型能完整分析。</span></label>
      {files.length > 0 && <ul className="file-list">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><button type="button" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => { if (submitting.current) return; setFiles((current) => current.filter((_, at) => at !== index)); setState("editing"); setMessage(""); }}>移除</button></li>)}</ul>}
      {needsMediaSegmentation && <p className="inline-warning" role="status">这些音视频需要本机分段后逐段调用模型，可能增加耗时和 API 费用。当前仅 Mac 支持本机分段，音视频理解需启用百炼 qwen3.8-omni-flash；格式、片段数量或完整描述超限会明确失败，不会只看开头或文字作结论。</p>}
      {exceedsImageInput && <p className="inline-warning" role="status">图片超过 20 MB 单次模型输入上限，请压缩后重试。</p>}
      {hasUnverifiedFormat && <p className="inline-warning" role="status">M4A 在 Mac 上先转为临时 WAV 片段，HEIC 先转为保留完整尺寸、已应用方向的私有图片副本，再交给模型；原件不变。转换副本可能有编码差异，多图／HDR／超限或不支持的编码明确失败。真实 API 兼容性仍待验证。</p>}
      {message && <div className={`banner ${state === "skipped" ? "neutral" : state === "review" ? "notice" : "error"}`} role={state === "failed" ? "alert" : "status"}>{message}{state === "review" && <button type="button" onClick={onPending}>查看待确认</button>}</div>}
      {busy && <div className="stage-progress" aria-live="polite"><i /><span>{mediaProgress ? mediaProgressLabel(mediaProgress) : state === "preparing" ? "正在检查格式和模型能力…" : "正在判断是否收录…"}</span></div>}
      <footer><button type="button" onClick={() => void close()}>取消</button><button className="primary" disabled={busy || textTooLong || (!text.trim() && files.length === 0)}>{state === "failed" ? "重试" : "保存"}</button></footer>
    </form>
  </section></div>;
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
    <header><div><p className="eyebrow">与正式记录隔离</p><h2>待确认</h2></div><button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></header>
    <p className="drawer-help">这里只保留最小摘录和判断原因，不会进入时间线或搜索。普通日常不会出现在这里。</p>
    {error && <div className="banner error">{error}</div>}
    {notice && <div className="banner notice" role="status">{notice}</div>}
    {loadError && <div className="banner error" role="alert">暂时无法读取待确认：{loadError}<button onClick={() => void onChanged()}>重新读取待确认</button></div>}
    {loading ? <p role="status">正在读取待确认…</p> : loadError ? null : items.length === 0 ? <div className="empty compact"><h3>没有待确认内容</h3><p>需要你判断的项目会出现在这里。</p></div> : <div className="pending-list">{items.map((item) => <article key={item.id}>
      <div className="chips">{item.categories.map((category) => <span className={`chip chip-${category}`} key={category}>{CATEGORY_LABEL[category]}</span>)}<span className="chip subtle">{ORIGIN_LABEL[item.origin]}</span></div>
      <blockquote>{item.excerpt || "（只有媒体）"}</blockquote><p>{item.reason}</p>
      {!item.sessionAvailable && <div className="inline-warning">{item.origin === "manual" ? "原始会话已失效；保留前需要重新提供完整内容。" : item.origin === "migration" ? "迁移临时文件已清理；重新选择旧工作区可核对原件并保留旧修订。也可重新提供完整内容作为手动记录，但不携带旧来源映射。" : item.origin === "zip" ? "请重新选择包含此日记的 ZIP；来源版本不变可确认保留，若已修改则先重新筛选。" : "导出包临时来源已清理；请重新选择 Day One JSON ZIP 并导入。"}</div>}
      <footer><button disabled={busy === item.id} onClick={() => void resolve(item, "ignore")}>忽略并清理</button>{item.origin === "manual" && !item.sessionAvailable ? <button className="primary" disabled={busy === item.id} onClick={() => onReprovide(item.id)}>重新提供完整内容</button> : item.origin === "migration" && !item.sessionAvailable ? <><button disabled={busy === item.id} onClick={() => onReprovide(item.id)}>重新提供（手动记录）</button><button className="primary" disabled={busy === item.id} onClick={() => void resolveLegacy(item)}>重新选择旧工作区并核对</button></> : item.origin === "zip" && !item.sessionAvailable ? <button className="primary" disabled={busy === item.id} onClick={() => void resolveZip(item)}>重新选择 ZIP 并核对</button> : <button className="primary" disabled={busy === item.id || !item.sessionAvailable} onClick={() => void resolve(item, "keep")}>确认保留</button>}</footer>
    </article>)}</div>}
  </aside></div>;
}

export function SearchView() {
  const [text, setText] = useState(""); const [files, setFiles] = useState<File[]>([]);
  const textTooLong = codePointLength(text) > RECORD_QUERY_TEXT_LIMIT;
  const [useSemantic, setUseSemantic] = useState(true);
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
  return <div className="page search-page"><header className="page-header"><div><p className="eyebrow">正式记录范围</p><h1>搜索</h1><p>关键词始终在本地可用；已启用的语义与图片查询会发送给百炼，并在当次搜索结束后清理。</p></div></header>
    <form className="search-box" onSubmit={(event) => void search(event)}><div className="search-input"><span>⌕</span><input id="global-search-input" value={text} aria-invalid={textTooLong || undefined} aria-describedby={textTooLong ? "search-text-limit" : undefined} onChange={(event) => setText(event.target.value)} placeholder="描述你记得的内容…" /><button className="primary" disabled={busy || textTooLong}>搜索</button></div>
      {textTooLong && <p id="search-text-limit" className="inline-warning" role="alert">搜索文字不能超过 500 字，请缩短后再搜索。输入未被截断。</p>}
      <div className="search-options"><label className="file-button">＋ 图片／音频／视频<input type="file" aria-label="选择搜索图片、音频或视频" multiple disabled={busy} accept="image/*,audio/*,video/*" onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; chooseSearchFiles(selected); }} /></label><label className="semantic-toggle"><input type="checkbox" checked={useSemantic} disabled={files.length > 0} onChange={(event) => setUseSemantic(event.target.checked)} />使用百炼语义检索</label><label>类别<select value={category} onChange={(event) => setCategory(event.target.value as EventCategory | "")}><option value="">全部</option><option value="grudge">冲突</option><option value="rights">权益</option><option value="danger">危险</option></select></label><label>来源<select value={origin} onChange={(event) => setOrigin(event.target.value as RecordOrigin | "")}><option value="">全部</option><option value="manual">手动记录</option><option value="zip">ZIP 导入</option><option value="dayone">Day One</option><option value="migration">旧数据迁移</option></select></label><label>从<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>至<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>{files.map((file) => <span className="query-file" key={file.name}>{file.name}</span>)}</div>
    </form>
    <p className="muted">月份与时间范围按可能重叠筛选；时间未确定时按记录日期。明确时刻按本次查询的本地日期。</p>
    {busy && <div className="stage-progress" aria-live="polite"><i /><span>{cancelling ? "正在停止查询并清理临时副本…" : mediaProgress ? mediaProgressLabel(mediaProgress) : "正在处理本次查询…"}</span><button disabled={cancelling} onClick={cancelSearch}>{cancelling ? "正在取消…" : "取消搜索"}</button></div>}
    {searched && !busy && !error && <div className="capability-grid search-capabilities" aria-live="polite"><span className={capabilities.semantic === "ready" ? "ready" : capabilities.semantic === "building" ? "pending" : "unavailable"}>语义索引</span><span className={capabilities.media === "ready" ? "ready" : capabilities.media === "building" ? "pending" : "unavailable"}>媒体查询</span></div>}
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

function ModelSettings({ settings, searchIndex, fresh, indexFresh, onChanged }: {
  settings: LlmSettings;
  searchIndex: RecordSearchIndexStatus | null;
  fresh: boolean;
  indexFresh: boolean;
  onChanged(): Promise<void>;
}) {
  const [provider, setProvider] = useState<"bailian" | "minimax">("bailian"); const config = settings?.providers[provider];
  const [model, setModel] = useState(settings.providers.bailian?.model ?? "qwen3.8-omni-flash"); const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState<"cn-beijing" | "ap-southeast-1" | "us-east-1" | "cn-hongkong">(settings.providers.bailian?.region ?? "cn-beijing");
  const [workspaceId, setWorkspaceId] = useState(settings.providers.bailian?.workspaceId ?? ""); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [recommendations, setRecommendations] = useState<LlmModelOption[]>([]);
  const [recommendationError, setRecommendationError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setRecommendations([]); setRecommendationError("");
    void window.grudgeVault.llm.listModels({
      provider, recommendationsOnly: true, ...(provider === "bailian" ? { region: "cn-beijing" as const } : {})
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) setRecommendations(result.data.filter(({ recommended }) => recommended));
      else setRecommendationError("暂时无法载入内置候选清单；仍可填写模型 ID 后测试连接。");
    }).catch(() => {
      if (!cancelled) setRecommendationError("暂时无法载入内置候选清单；仍可填写模型 ID 后测试连接。");
    });
    return () => { cancelled = true; };
  }, [provider]);
  const selectProvider = (next: "bailian" | "minimax") => {
    const nextConfig = settings.providers[next];
    setProvider(next); setModel(nextConfig?.model ?? (next === "bailian" ? "qwen3.8-omni-flash" : "MiniMax-M3"));
    setRegion(nextConfig?.region ?? "cn-beijing"); setWorkspaceId(nextConfig?.workspaceId ?? "");
    setApiKey(""); setMessage("");
  };
  const connect = async () => {
    if (!fresh || busy) return;
    if ((!config?.credentialConfigured || provider === "bailian" && model.trim() === "qwen3.8-omni-flash" && config?.model !== "qwen3.8-omni-flash") && !window.confirm(
      "启用模型后，筛选会发送尚未确定是否收录的文字和附件，正式记录会发送用于报告分析；如选择百炼 qwen3.8-omni-flash，中国大陆权益问题还会联网搜索官方来源。服务商可能计费并按其政策处理数据。继续测试并保存配置吗？"
    )) return;
    setBusy(true); setMessage("");
    try {
      unwrap(await window.grudgeVault.llm.connect({ provider, model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(provider === "bailian" ? { region, ...(workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}) } : {}) }));
      await onChanged(); setApiKey(""); setMessage("连接测试通过，已保存配置。");
    } catch (cause) { setMessage(displayError(cause)); } finally { setBusy(false); }
  };
  const pause = async () => {
    setBusy(true); setMessage("");
    try {
      unwrap(await window.grudgeVault.llm.pause());
      await onChanged();
      setMessage("已暂停模型筛选、报告与语义外发；配置和密钥仍安全保留。已开始的请求可能仍会完成。");
    } catch (cause) { setMessage(displayError(cause)); } finally { setBusy(false); }
  };
  const active = settings?.activeProvider === provider;
  const testedConfiguration = matchesTestedModelConfiguration(config, { provider, model, region, workspaceId, apiKey });
  const capabilities = testedConfiguration ? config?.capabilities : undefined;
  const selectedRecommendation = recommendations.find(({ id }) => id === model.trim());
  const textVerified = Boolean(capabilities?.structuredOutput && capabilities.inputModalities.includes("text"));
  const imageVerified = Boolean(capabilities?.inputModalities.includes("image"));
  const audioVerified = Boolean(capabilities?.inputModalities.includes("audio"));
  const videoVerified = Boolean(capabilities?.inputModalities.includes("video"));
  const imageCandidate = Boolean(selectedRecommendation?.inputModalities.includes("image")) || /(?:omni|vision|(?:^|[-_])vl(?:[-_]|$)|minimax-m3)/i.test(model);
  const nativeMediaCandidate = provider === "bailian" && model.trim() === "qwen3.8-omni-flash";
  return <section className="settings-card"><div className="settings-card-header"><div><h2>模型服务</h2><p>筛选会发送尚未确定是否收录的内容；服务商留存政策由对应平台决定。</p></div>{!fresh ? <span className="status status-partial">上次读取配置</span> : active ? <span className="status status-complete">{testedConfiguration ? "当前启用" : "已保存配置启用中"}</span> : config?.credentialConfigured ? <span className="status status-partial">{config.status === "needs_attention" ? "需重新测试" : settings?.activeProvider ? "已配置" : "已暂停"}</span> : null}</div>
    <div className="provider-tabs"><button disabled={busy} className={provider === "bailian" ? "active" : ""} onClick={() => selectProvider("bailian")}>百炼</button><button disabled={busy} className={provider === "minimax" ? "active" : ""} onClick={() => selectProvider("minimax")}>MiniMax</button></div>
    <div className="settings-form">
      <label className="field">推荐模型（候选，待验证）<select aria-label="推荐模型" disabled={busy || recommendations.length === 0} value={selectedRecommendation?.id ?? ""} onChange={(event) => { setModel(event.target.value); setMessage(""); }}><option value="">自定义模型 ID</option>{recommendations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
      <p className="capability-help">候选来自应用内置清单，不读取账号目录或自动调用模型；具体地域、开通状态和任务能力以你的连接测试及实际输入验证为准。也可直接填写自定义模型 ID。</p>
      {recommendationError && <p className="inline-warning" role="status">{recommendationError}</p>}
      <label className="field">模型 ID<input disabled={busy} value={model} onChange={(event) => { setModel(event.target.value); setMessage(""); }} placeholder={provider === "bailian" ? "输入账户中已开通的模型 ID" : "MiniMax-M3"} /></label>
      {provider === "bailian" && <div className="form-row"><label className="field">地域<select aria-label="地域" disabled={busy} value={region} onChange={(event) => { setRegion(event.target.value as typeof region); setMessage(""); }}><option value="cn-beijing">中国大陆（北京）</option><option value="cn-hongkong">中国香港</option><option value="ap-southeast-1">国际（新加坡）</option><option value="us-east-1">美国（弗吉尼亚）</option></select></label><label className="field">业务空间（按需）<input disabled={busy} value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setMessage(""); }} /></label></div>}
      <label className="field">API 密钥<input disabled={busy} type="password" autoComplete="off" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setMessage(""); }} placeholder={config?.credentialConfigured ? "已安全保存；留空则沿用" : "输入密钥"} /></label>
      {!testedConfiguration && config?.credentialConfigured && <p className="inline-warning" role="status">当前输入尚未测试；已保存配置不会因编辑而改变。能力标签仅在该模型、地域、业务空间和密钥对应的测试通过后恢复。</p>}
      <div className="capability-grid"><span className={fresh && textVerified ? "ready" : "pending"}>文字＋结构化输出</span><span className={fresh && capabilities?.streaming ? "ready" : "pending"}>流式响应</span><span className={!fresh ? "pending" : imageVerified ? "ready" : imageCandidate ? "pending" : "unavailable"}>图片理解</span><span className={!fresh ? "pending" : audioVerified ? "ready" : nativeMediaCandidate ? "pending" : "unavailable"}>音频理解</span><span className={!fresh ? "pending" : videoVerified ? "ready" : nativeMediaCandidate ? "pending" : "unavailable"}>视频理解</span><span className={!indexFresh ? "pending" : searchIndex?.state === "ready" ? "ready" : searchIndex?.available ? "pending" : "unavailable"}>百炼图文检索（独立）</span></div>
      <p className="capability-help">连接测试验证文字与结构化输出；只有服务端实际返回并通过汇聚校验的 SSE 才标记流式能力。“待验证”不会被当作可用能力。图片、音频和视频只有在对应真实筛选完整成功后才标为已验证。音视频理解可选择百炼 qwen3.8-omni-flash：小文件直传，Mac 上的长媒体及 M4A 本机分段后逐段调用，可能增加耗时和 API 费用；不会静默截断或跳过。真实媒体协议和定位质量仍需本机授权后验证。图文检索由下方独立授权和构建，可在 MiniMax 作为主分析模型时使用已配置的百炼补齐。{capabilities?.maxInput ? ` 已验证单次输入上限：${capabilities.maxInput.toLocaleString()}。` : ""}{capabilities?.lastVerifiedAt ? ` 最近验证：${dateLabel(capabilities.lastVerifiedAt)}。` : ""}</p>
      {message && <div className={`banner ${message.includes("通过") || message.includes("已暂停") ? "notice" : "error"}`}>{message}</div>}
      <button className="primary" disabled={busy || !fresh || !model.trim() || (!apiKey.trim() && !config?.credentialConfigured)} onClick={() => void connect()}>{busy ? "正在处理…" : config?.credentialConfigured && !active ? "重新测试并启用" : "测试连接并保存"}</button>
      {active && <button disabled={busy} onClick={() => void pause()}>暂停全部模型外发</button>}
    </div>
  </section>;
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
  return <section className="settings-card"><div className="settings-card-header"><div><h2>工作区自动锁定</h2><p>保护本机上的工作区；默认在 Mac 空闲 15 分钟后锁定。</p></div></div>
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

export function SettingsView({ onDataChanged }: { onDataChanged(): void }) {
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
  return <div className="page settings-page"><header className="page-header"><div><p className="eyebrow">能力与数据边界</p><h1>设置</h1><p>模型、Day One、默认法律地域和存储状态。</p></div></header>{error && <div className="banner error">{error}</div>}
    <SnapshotNotice name="模型设置" snapshot={modelSnapshot} />
    <div className="settings-grid">{settings ? <ModelSettings settings={settings} searchIndex={searchIndex ?? null} fresh={modelFresh} indexFresh={indexFresh} onChanged={load} /> : <section className="settings-card blocked-feature"><h2>模型服务</h2><p>{modelSnapshot.loading ? "正在载入模型设置…" : "模型配置状态未知，请重新读取。"}</p></section>}
      <section className="settings-card">
        <div className="settings-card-header"><div><h2>Day One</h2><p>手动导出、按需导入；本版不连接或定时读取 Day One。</p></div></div>
        <div className="settings-form">
          <strong>导入 Day One JSON 导出包</strong>
          <p className="capability-help">请在 Day One 中选择“文件 → 导出 → JSON”，然后选择生成的 ZIP（内含 JSON 与媒体文件夹）。应用逐条筛选后才保存相关内容；原 ZIP 和 Day One 日记保持原样。再次导出并导入可检查新版本，但不会自动同步。新版会比较实际媒体内容；此前已导入的含媒体条目在首次重导时可能额外筛选一次并产生模型费用。</p>
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
      <AutoLockSettings />
      <section className="settings-card"><div className="settings-card-header"><div><h2>法律地域</h2><p>用于报告中的法律问题整理；不会自动生成确定结论。</p></div></div><div className="settings-form"><SnapshotNotice name="默认地域" snapshot={legalSnapshot} /><label className="field">默认地域<input maxLength={200} disabled={legalBusy || !legalFresh} value={defaultJurisdiction} onChange={(event) => { legalDraftDirty.current = true; setDefaultJurisdiction(event.target.value); setLegalMessage(""); }} placeholder="例如：中国大陆" /></label>{legalMessage && <div className="banner notice">{legalMessage}</div>}<button className="primary" disabled={legalBusy || !legalFresh || !defaultJurisdiction.trim()} onClick={() => void saveDefaultJurisdiction()}>{legalBusy ? "正在保存…" : "保存默认地域"}</button><div className="banner neutral">启用百炼 qwen3.8-omni-flash 后，中国大陆权益报告会尽量删去姓名、联系方式等标识，再将法律问题联网检索，并重新读取官方网页核对标题与原文摘录；请勿在法律问题中输入不必要的私密信息。具体法律适用性和事发时点仍标“依据待核验”。其他地域暂不检索。</div></div></section>
      <section className="settings-card"><div className="settings-card-header"><div><h2>多模态搜索索引</h2><p>使用百炼 qwen3-vl-embedding 的同一向量空间索引正式记录文字与本地图片。</p></div><span className={`status ${indexFresh && searchIndex?.state === "ready" ? "status-complete" : searchIndex?.state === "failed" ? "status-failed" : "status-partial"}`}>{indexSnapshot.loading ? "正在读取" : indexSnapshot.error || !searchIndex ? "状态未知" : searchIndex.state === "ready" ? "已就绪" : searchIndex?.state === "checking" ? "检查中" : searchIndex?.state === "building" ? "构建中" : searchIndex?.state === "failed" ? "构建失败" : searchIndex?.state === "paused" ? "已暂停" : "未建立"}</span></div><div className="settings-form"><SnapshotNotice name="索引状态" snapshot={indexSnapshot} /><div className="capability-grid"><span className={!indexFresh ? "pending" : searchIndex?.inputModalities.includes("text") ? "ready" : "unavailable"}>文字索引</span><span className={!indexFresh ? "pending" : searchIndex?.inputModalities.includes("image") ? "ready" : "unavailable"}>图片索引</span><span className={!indexFresh ? "pending" : searchIndex?.queryModalities.includes("audio") ? "pending" : "unavailable"}>音频查询{searchIndex?.queryModalities.includes("audio") ? "（待实测）" : ""}</span><span className={!indexFresh ? "pending" : searchIndex?.queryModalities.includes("video") ? "pending" : "unavailable"}>视频查询{searchIndex?.queryModalities.includes("video") ? "（待实测）" : ""}</span></div><p className="capability-help">仅索引已经正式保存的记录；新代际完整成功后才替换旧索引。音视频查询会先经已启用的百炼 Omni 模型生成当次临时描述，再匹配正式报告中带原件定位的经过片段；不是音视频原件的全量索引。查询媒体和临时描述不会入库。真实 API 与长媒体尚待本机验证；超限或不支持的格式会报错，不会上传到公开 URL。</p>{searchIndex?.fragmentCount ? <div className="storage-row"><span>当前片段</span><strong>{searchIndex.fragmentCount}</strong></div> : null}{searchIndex?.state === "checking" && <div className="banner notice">正在只读核对索引覆盖；确认需要更新后才会请求向量模型，可以随时暂停。</div>}{searchIndex?.lastError && <div className="banner error">{searchIndexFailureMessage(searchIndex.lastError)}</div>}{indexMessage && <div className="banner notice">{indexMessage}</div>}<button className="primary" disabled={indexBusy || !indexFresh || searchIndex?.state === "checking" || searchIndex?.state === "building" || !searchIndex?.available} onClick={() => void rebuildIndex()}>{searchIndex?.state === "checking" ? "正在检查现有索引…" : indexBusy || searchIndex?.state === "building" ? "正在后台构建…" : searchIndex?.state === "paused" ? "恢复并更新索引" : searchIndex?.state === "ready" ? "重建索引" : "建立索引"}</button>{searchIndex?.enabled && <button disabled={indexBusy} onClick={() => void pauseIndex()}>暂停语义查询与自动更新</button>}{indexFresh && !searchIndex?.available && <p className="capability-help">请先连接百炼；MiniMax 可继续作为主分析模型，但当前没有经验证的同空间向量接口。</p>}</div></section>
      <section className="settings-card"><div className="settings-card-header"><div><h2>迁移与存储</h2><p>旧工作区保持不变，相关记录在当前新版工作区中重新加密。</p></div></div><div className="settings-form"><div className="storage-row"><span>加密对象库</span><strong>已启用</strong></div><div className="storage-row"><span>结构化 SQLite 数据</span><strong>本地存储</strong></div>{migrationMessage && <div className="banner notice">{migrationMessage}</div>}<button className="primary" disabled={migrationBusy || !modelFresh || !settings?.activeProvider} onClick={() => void migrateLegacy()}>{migrationBusy ? "正在逐条迁移…" : "选择旧工作区并开始筛选迁移"}</button>{migrationBusy && <button onClick={() => void cancelLegacy()}>停止本次迁移</button>}<p className="capability-help">只接受格式版本 1／2。修订、来源映射和所需附件随正式记录迁移；普通日常不会复制，无法完整检查的内容进入待确认。</p>{!modelFresh ? <p className="capability-help">模型配置尚未完成读取，暂不能开始新的迁移。</p> : !settings?.activeProvider && <p className="capability-help">请先连接并启用模型服务。</p>}</div></section>
    </div>
  </div>;
}

export function App() {
  const [view, setView] = useState<MainView>("timeline");
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
  if (!ready) return <div className="loading full">正在读取工作区状态…</div>;
  if (workspaceError) return <main className="landing"><section className="landing-card"><h1>暂时无法读取工作区状态</h1><p role="alert">{displayError(workspaceError)}</p><button onClick={() => void refreshWorkspace()}>重新读取状态</button><p>不会重新打开工作区、恢复旧输入或启动模型任务。</p></section></main>;
  if (workspaceStatus.status !== "open") return <Landing status={workspaceStatus} onChanged={refreshWorkspace} />;
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h12v18H6a3 3 0 0 1 0-6h12M6 3a3 3 0 0 0-3 3v12M8 7h6M8 10h4" /></svg></span><strong>Grudge Vault</strong></div><nav aria-label="主要导航"><button aria-label="时间线" className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><i>◷</i>时间线</button><button aria-label="搜索" className={view === "search" ? "active" : ""} onClick={() => setView("search")}><i>⌕</i>搜索</button><button aria-label="设置" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><i>⚙</i>设置</button></nav><button className="new-record-button" onClick={() => setShowNew(true)}>＋ 新建记录</button><div className="workspace-chip"><span>{workspaceStatus.workspace.name}</span><button onClick={() => void window.grudgeVault.workspace.lock().then(() => refreshWorkspace())}>锁定</button></div></aside>
    <main className="main-content" key={`content-${session.version}`}>{Boolean(pendingError) && !showPending && <div className="banner error" role="alert">暂时无法读取待确认：{displayError(pendingError)}<button onClick={() => void refreshVisiblePending()}>重新读取待确认</button></div>}{view === "timeline" && <TimelineView key={timelineKey} onNew={() => setShowNew(true)} onSettings={() => setView("settings")} pendingCount={pending.length} onPending={openPending} {...(openRecordId ? { openRecordId } : {})} onRecordOpened={() => { if (isCurrentSession(session)) setOpenRecordId(undefined); }} />}{view === "search" && <SearchView />}{view === "settings" && <SettingsView onDataChanged={() => { if (!isCurrentSession(session)) return; setTimelineKey((value) => value + 1); void refreshPending(); }} />}</main>
    {showNew && <NewRecordDialog key={`intake-${session.version}`} onClose={() => { if (!isCurrentSession(session)) return; setShowNew(false); setReprovidePendingId(undefined); void refreshPending(); }} onSaved={openSaved} onPending={openPending} onRescreenSettled={() => { if (!isCurrentSession(session)) return; setReprovidePendingId(undefined); void refreshPending(); }} {...(reprovidePendingId ? { reprovidePendingId, reprovideOrigin: pending.find(({ id }) => id === reprovidePendingId)?.origin } : {})} />}
    {showPending && <PendingDrawer key={`pending-${session.version}`} items={pending} loading={pendingLoading} loadError={pendingError ? displayError(pendingError) : ""} onClose={() => { if (isCurrentSession(session)) setShowPending(false); }} onChanged={refreshVisiblePending} onSaved={openSaved} onReprovide={(id) => { if (!isCurrentSession(session)) return; setShowPending(false); setReprovidePendingId(id); setShowNew(true); }} />}
  </div>;
}
