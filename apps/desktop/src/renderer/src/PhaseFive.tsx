import { useCallback, useEffect, useState } from "react";
import type {
  Asset, Case, CaseBinderPreview, CaseDetail, DerivedArtifactDetail, EvidenceDetail, Event, IntegrityScan, Person,
  WorkspaceCryptoStatus, WorkspaceSecuritySettings
} from "@grudge-vault/domain";
import type { CaseWriteFields } from "@grudge-vault/shared";
import type { Language } from "./i18n";

interface CommonProps {
  language: Language;
  onError(message: string): void;
  onNotice(message: string): void;
}

const copy = (language: Language, zh: string, en: string) => language === "zh-CN" ? zh : en;
const materialStatus = (language: Language, value: string) => ({
  available: copy(language, "可用", "Available"), missing: copy(language, "文件缺失", "Missing"), deleted: copy(language, "已删除", "Deleted"),
  unknown: copy(language, "待检查", "Unchecked"), verified: copy(language, "已检查", "Checked"), corrupt: copy(language, "文件异常", "Damaged"),
  queued: copy(language, "等待处理", "Waiting"), running: copy(language, "正在处理", "Processing"), succeeded: copy(language, "已完成", "Completed"), failed: copy(language, "处理失败", "Failed")
} as Record<string, string>)[value] ?? value;

export function EvidencePanel({ language, onError, onNotice }: CommonProps) {
  const [evidence, setEvidence] = useState<EvidenceDetail[]>([]);
  const [selected, setSelected] = useState<EvidenceDetail>();
  const [scans, setScans] = useState<IntegrityScan[]>([]);
  const [replacementId, setReplacementId] = useState("");
  const [derivedPreview, setDerivedPreview] = useState<DerivedArtifactDetail>();

  const refresh = useCallback(async () => {
    const [items, scanItems] = await Promise.all([window.grudgeVault.evidence.list(), window.grudgeVault.evidence.listScans()]);
    if (!items.ok) onError(items.error.message);
    else {
      setEvidence(items.data);
      setSelected((current) => current ? items.data.find(({ asset }) => asset.id === current.asset.id) : items.data[0]);
    }
    if (scanItems.ok) setScans(scanItems.data); else onError(scanItems.error.message);
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => window.grudgeVault.jobs.onChanged(() => void refresh()), [refresh]);
  useEffect(() => { setDerivedPreview(undefined); }, [selected?.asset.id]);

  const startScan = async () => {
    const result = await window.grudgeVault.evidence.startScan();
    if (!result.ok) return onError(result.error.message);
    onNotice(copy(language, "完整性巡检已排队。", "Integrity scan queued."));
    await refresh();
  };

  const deleteOriginal = async () => {
    if (!selected) return;
    const impact = await window.grudgeVault.evidence.deleteImpact(selected.asset.id);
    if (!impact.ok) return onError(impact.error.message);
    const total = impact.data.eventIds.length + impact.data.sourceItemIds.length + impact.data.importRunIds.length + impact.data.caseIds.length;
    const clearingTombstone = selected.availabilityStatus === "deleted";
    const message = clearingTombstone
      ? copy(language,
          "此材料没有任何引用。将清除残留的文件名、大小和哈希记录。继续吗？",
          "This material has no references. Its remaining file name, size, and hash record will be removed. Continue?")
      : copy(language,
          `将永久移除原件。它被 ${impact.data.eventIds.length} 条记录、${impact.data.sourceItemIds.length} 个来源、${impact.data.importRunIds.length} 次导入和 ${impact.data.caseIds.length} 个材料包引用；无引用时也会清除元数据。继续吗？`,
          `This permanently removes the original. It is used by ${impact.data.eventIds.length} records, ${impact.data.sourceItemIds.length} sources, ${impact.data.importRunIds.length} imports, and ${impact.data.caseIds.length} material packages; unreferenced metadata is also removed. Continue?`);
    if (!window.confirm(message)) return;
    const result = await window.grudgeVault.evidence.deleteOriginal({ assetId: selected.asset.id, confirmReferencedDeletion: total > 0 });
    if (!result.ok) return onError(result.error.message);
    onNotice(total === 0 && selected.derivedArtifacts.length === 0
      ? copy(language, "材料原件及其元数据已永久删除。", "The original and its metadata were permanently deleted.")
      : copy(language, "加密原件已从磁盘永久删除；引用位置仅保留“已删除”记录。", "The encrypted original was permanently removed from disk; referenced locations retain only a “Deleted” record."));
    await refresh();
  };

  const supersede = async () => {
    if (!selected || !replacementId) return;
    const result = await window.grudgeVault.evidence.supersede({ oldAssetId: selected.asset.id, newAssetId: replacementId });
    if (!result.ok) return onError(result.error.message);
    onNotice(copy(language, "已标记替换；既有引用没有被改写。", "Superseded; existing references were not rewritten."));
    setReplacementId("");
    await refresh();
  };

  const processMedia = async () => {
    if (!selected) return;
    const result = await window.grudgeVault.localIntelligence.processAsset(selected.asset.id);
    if (!result.ok) return onError(result.error.message);
    onNotice(copy(language, "本地媒体处理已排队。", "Local media processing queued."));
    await refresh();
  };

  const previewDerived = async (id: string) => {
    const result = await window.grudgeVault.localIntelligence.getArtifact(id);
    if (!result.ok) return onError(result.error.message);
    setDerivedPreview(result.data);
  };

  return <div className="phase-five-grid evidence-view">
    <aside className="panel phase-five-index">
      <div className="section-heading"><h2>{copy(language, "材料详情", "Material details")}</h2>
        <button onClick={() => void startScan()}>{copy(language, "检查材料", "Check materials")}</button></div>
      <div className="event-list">{evidence.map((item) => <article key={item.asset.id}
        className={selected?.asset.id === item.asset.id ? "selected" : ""} onClick={() => setSelected(item)}>
        <div><strong>{item.asset.originalFileName}</strong><span>{item.asset.mimeType} · {item.asset.byteSize.toLocaleString()} B</span></div>
        <em className={`status ${item.availabilityStatus}`}>{materialStatus(language, item.availabilityStatus)}</em></article>)}</div>
      {scans.some(({ state }) => state !== "succeeded") && <section className="subsection"><h3>{copy(language, "处理中", "In progress")}</h3>
        <div className="revision-list">{scans.filter(({ state }) => state !== "succeeded").map((scan) => <article key={scan.id}><strong>{materialStatus(language, scan.state)}</strong>
          <span>{scan.counts.verified}/{scan.counts.total}</span></article>)}</div></section>}
    </aside>
    <section className="panel phase-five-detail">{!selected ? <div className="empty">{copy(language, "还没有材料。", "No materials yet.")}</div> : <>
      <div className="section-heading"><div><h2>{selected.asset.originalFileName}</h2><p className="muted">{materialStatus(language, selected.availabilityStatus)} · {selected.events.length} {copy(language, "条关联记录", "linked records")}</p></div>
        <div className="row-actions permanent">{selected.availabilityStatus !== "deleted" && <>
          <button onClick={() => void processMedia()}>{copy(language, "提取可搜索文字", "Extract searchable text")}</button>
          <button onClick={() => void window.grudgeVault.assets.exportCopy(selected.asset.id)}>{copy(language, "导出副本", "Export copy")}</button>
          <button onClick={() => void deleteOriginal()}>{copy(language, "永久删除原件", "Delete original permanently")}</button></>}
          {selected.availabilityStatus === "deleted" && selected.impact.eventIds.length === 0 && selected.impact.sourceItemIds.length === 0
            && selected.impact.importRunIds.length === 0 && selected.impact.caseIds.length === 0 && selected.derivedArtifacts.length === 0
            && <button onClick={() => void deleteOriginal()}>{copy(language, "清除删除记录", "Remove deleted record")}</button>}</div></div>
      <section className="subsection"><h3>{copy(language, "关联记录", "Linked records")}</h3><div className="chip-list">{selected.events.length === 0
        ? <span>{copy(language, "暂未关联记录", "No linked record")}</span> : selected.events.map((event) => <span key={event.id}>{event.title}</span>)}</div></section>
      <details className="advanced-section"><summary>{copy(language, "高级详情", "Advanced details")}</summary><div className="advanced-content">
      <div className="evidence-metadata"><div><span>SHA-256</span><code>{selected.asset.sha256}</code></div>
        <div><span>{copy(language, "可用性", "Availability")}</span><strong>{selected.availabilityStatus}</strong></div>
        <div><span>{copy(language, "完整性", "Integrity")}</span><strong>{selected.asset.integrityStatus}</strong></div>
        {selected.supersededByAssetId && <div><span>{copy(language, "替换为", "Superseded by")}</span><code>{selected.supersededByAssetId}</code></div>}</div>
      <section className="subsection"><h3>{copy(language, "标记替换", "Mark as superseded")}</h3>
        <p className="muted">{copy(language, "替换不会自动改写记录、来源或材料包引用。", "Replacement never rewrites record, source, or material-package references.")}</p>
        <div className="inline-create"><select value={replacementId} onChange={(event) => setReplacementId(event.target.value)}>
          <option value="">{copy(language, "选择新原件", "Choose new original")}</option>{evidence.filter(({ asset }) => asset.id !== selected.asset.id).map(({ asset }) =>
            <option key={asset.id} value={asset.id}>{asset.originalFileName}</option>)}</select><button disabled={!replacementId} onClick={() => void supersede()}>{copy(language, "确认替换", "Supersede")}</button></div></section>
      <section className="subsection"><h3>{copy(language, "引用影响", "Reference impact")}</h3>
        <p>{copy(language, "记录", "Records")}: {selected.impact.eventIds.length} · {copy(language, "来源", "Sources")}: {selected.impact.sourceItemIds.length} · {copy(language, "材料包", "Material packages")}: {selected.impact.caseIds.length}</p>
        <div className="chip-list">{selected.events.map((event) => <span key={event.id}>{event.title}</span>)}{selected.cases.map((item) => <span key={item.id}>{item.title}</span>)}</div></section>
      <section className="subsection"><h3>{copy(language, "关联事实", "Linked facts")}</h3><div className="mini-list">{selected.facts.map(({ eventId, statement }) =>
        <article key={`${eventId}:${statement.id}`}><div><strong>{statement.kind}</strong><span>{statement.text}</span></div></article>)}</div></section>
      <section className="subsection"><h3>{copy(language, "派生物（非原件）", "Derived artifacts (not originals)")}</h3>
        {selected.derivedArtifacts.length === 0 ? <p className="muted">{copy(language, "暂无派生物。", "No derived artifacts.")}</p> : <div className="mini-list">{selected.derivedArtifacts.map((item) =>
          <article key={item.id}><div><strong>{item.kind} · {item.current ? "current" : "history"}</strong><span>{item.processorIdentity} v{item.processorVersion} · {item.sha256}</span></div>
            <button onClick={() => void previewDerived(item.id)}>{copy(language, "预览", "Preview")}</button></article>)}</div>}
        {derivedPreview && <div className="source-card"><div className="section-heading"><div><p className="eyebrow">{derivedPreview.payload.kind} · v{derivedPreview.payload.formatVersion}</p>
          <h3>{copy(language, "派生文本预览", "Derived text preview")}</h3></div><button onClick={() => setDerivedPreview(undefined)}>×</button></div>
          <pre>{derivedPreview.payload.text}</pre>{derivedPreview.payload.kind === "ocr"
            ? <p className="muted">{derivedPreview.payload.pages.length} pages · {derivedPreview.payload.language}</p>
            : <p className="muted">{derivedPreview.payload.segments.length} segments · {derivedPreview.payload.language}</p>}</div>}</section>
      </div></details>
    </>}</section>
  </div>;
}

function BinderWizard({ detail, language, onError, onNotice }: { detail: CaseDetail } & CommonProps) {
  const [includeOriginals, setIncludeOriginals] = useState(true);
  const [derivedArtifactIds, setDerivedArtifactIds] = useState<string[]>([]);
  const [maskPeople, setMaskPeople] = useState(false);
  const [maskAmounts, setMaskAmounts] = useState(false);
  const [maskContacts, setMaskContacts] = useState(true);
  const [maskAccounts, setMaskAccounts] = useState(true);
  const [maskFileNames, setMaskFileNames] = useState(false);
  const [preview, setPreview] = useState<CaseBinderPreview>();
  const availableDerived = detail.evidence.flatMap(({ derivedArtifacts }) => derivedArtifacts);

  useEffect(() => {
    setDerivedArtifactIds([]);
    setPreview(undefined);
  }, [detail.case.id, detail.case.currentRevision]);

  const createPreview = async () => {
    const result = await window.grudgeVault.cases.previewBinder(detail.case.id, {
      caseRevision: detail.case.currentRevision,
      eventIds: detail.case.eventRefs,
      sourceItemIds: detail.case.sourceRefs,
      assetIds: includeOriginals ? detail.case.assetRefs : [],
      derivedArtifactIds, includeOriginals, includeDerivedArtifacts: derivedArtifactIds.length > 0, locale: language,
      redactions: {
        personIds: maskPeople ? detail.case.personRefs : [], maskAmounts, maskContacts, maskAccounts,
        maskFileNames, omitSourceExcerpts: true
      }
    });
    if (!result.ok) return onError(result.error.message);
    setPreview(result.data);
  };

  const exportBinder = async () => {
    if (!preview) return;
    const result = await window.grudgeVault.cases.exportBinder(preview.id);
    if (!result.ok) return onError(result.error.message);
    if (result.data) onNotice(copy(language, `材料包已导出：${result.data.fileCount} 个文件。`, `Material package exported with ${result.data.fileCount} files.`));
    setPreview(undefined);
  };

  return <section className="subsection binder-wizard"><div className="subsection-heading"><h3>{copy(language, "导出材料包", "Export material package")}</h3></div>
    <p className="warning-copy">{copy(language, "遮盖只作用于目录、PDF 与导出文件名。原件按字节原样导出，内部可能仍含敏感信息。", "Redaction applies only to indexes, PDF, and exported names. Original bytes are unchanged and may still contain sensitive data.")}</p>
    <div className="binder-options"><label className="check"><input type="checkbox" checked={includeOriginals} onChange={(event) => setIncludeOriginals(event.target.checked)} />{copy(language, "包含所选原件", "Include selected originals")}</label>
      <label className="check"><input type="checkbox" checked={maskPeople} onChange={(event) => setMaskPeople(event.target.checked)} />{copy(language, "人物别名", "Alias people")}</label>
      <label className="check"><input type="checkbox" checked={maskAmounts} onChange={(event) => setMaskAmounts(event.target.checked)} />{copy(language, "遮盖金额", "Mask amounts")}</label>
      <label className="check"><input type="checkbox" checked={maskContacts} onChange={(event) => setMaskContacts(event.target.checked)} />{copy(language, "遮盖联系方式", "Mask contacts")}</label>
      <label className="check"><input type="checkbox" checked={maskAccounts} onChange={(event) => setMaskAccounts(event.target.checked)} />{copy(language, "遮盖账号", "Mask accounts")}</label>
      <label className="check"><input type="checkbox" checked={maskFileNames} onChange={(event) => setMaskFileNames(event.target.checked)} />{copy(language, "遮盖文件名", "Mask filenames")}</label></div>
    {availableDerived.length > 0 && <fieldset><legend>{copy(language, "派生附件（逐项选择，非原件）", "Derived attachments (select individually; not originals)")}</legend>
      <div className="people-picker">{availableDerived.map((artifact) => <label className="check" key={artifact.id}>
        <input type="checkbox" checked={derivedArtifactIds.includes(artifact.id)} onChange={(event) => setDerivedArtifactIds(event.target.checked
          ? [...derivedArtifactIds, artifact.id] : derivedArtifactIds.filter((id) => id !== artifact.id))} />
        {artifact.kind} · {artifact.processorIdentity} v{artifact.processorVersion}
      </label>)}</div></fieldset>}
    <button className="primary" onClick={() => void createPreview()}>{copy(language, "生成明确预览", "Create explicit preview")}</button>
    {preview && <div className="binder-preview"><h3>{copy(language, "导出预览", "Export preview")}</h3>
      {preview.warnings.map((item) => <p className="warning-copy" key={item}>{item}</p>)}
      {preview.blockedReasons.map((item) => <p className="error-banner" key={item}>{item}</p>)}
      <div className="revision-list">{preview.files.map((file) => <article key={file.path}><strong>{file.classification}</strong><span>{file.path}</span></article>)}</div>
      <button className="primary" disabled={preview.blockedReasons.length > 0} onClick={() => void exportBinder()}>{copy(language, "选择目录并导出", "Choose directory and export")}</button></div>}
  </section>;
}

export function CasesPanel({ language, events, people, evidence, onError, onNotice }: CommonProps & {
  events: Event[];
  people: Person[];
  evidence: Asset[];
}) {
  const [cases, setCases] = useState<Case[]>([]);
  const [detail, setDetail] = useState<CaseDetail>();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<Case["status"]>("draft");
  const [eventRefs, setEventRefs] = useState<string[]>([]);
  const [personRefs, setPersonRefs] = useState<string[]>([]);
  const [assetRefs, setAssetRefs] = useState<string[]>([]);
  const [amountLabel, setAmountLabel] = useState("");
  const [amountCurrency, setAmountCurrency] = useState("CNY");
  const [amountValue, setAmountValue] = useState("");
  const [gapLabel, setGapLabel] = useState("");

  const loadCases = useCallback(async () => {
    const result = await window.grudgeVault.cases.list();
    if (!result.ok) return onError(result.error.message);
    setCases(result.data);
  }, [onError]);
  useEffect(() => { void loadCases(); }, [loadCases]);

  const applyDetail = (next: CaseDetail) => {
    setDetail(next); setTitle(next.case.title); setSummary(next.case.summary ?? ""); setJurisdiction(next.case.jurisdiction === "unspecified" ? "" : next.case.jurisdiction);
    setAsOfDate(next.case.asOfDate); setStatus(next.case.status); setEventRefs(next.case.eventRefs);
    setPersonRefs(next.case.personRefs); setAssetRefs(next.case.assetRefs);
  };
  const openCase = async (id: string) => {
    const result = await window.grudgeVault.cases.get(id);
    if (!result.ok) return onError(result.error.message);
    applyDetail(result.data);
  };
  const fields = (): CaseWriteFields => ({
    title, status, ...(summary.trim() ? { summary: summary.trim() } : {}), jurisdiction: jurisdiction.trim() || "unspecified", asOfDate,
    eventRefs, personRefs, sourceRefs: detail?.case.sourceRefs ?? [], assetRefs,
    amounts: detail?.case.amounts ?? [], disputePoints: detail?.case.disputePoints ?? [],
    questions: detail?.case.questions ?? [], materialGaps: detail?.case.materialGaps ?? [], evidenceLinks: detail?.case.evidenceLinks ?? []
  });
  const createCase = async () => {
    if (!title.trim()) return;
    const result = await window.grudgeVault.cases.create({ ...fields(), reason: "Case created in desktop UI" });
    if (!result.ok) return onError(result.error.message);
    await loadCases(); await openCase(result.data.id);
  };
  const updateCase = async (patch: Partial<CaseWriteFields> = {}) => {
    if (!detail) return createCase();
    const result = await window.grudgeVault.cases.update({ ...fields(), ...patch, caseId: detail.case.id,
      expectedRevision: detail.case.currentRevision, reason: "Case revised in desktop UI" });
    if (!result.ok) return onError(result.error.message);
    await loadCases(); await openCase(result.data.id);
  };
  const addAmount = async () => {
    if (!detail || !amountLabel.trim() || !amountValue.trim()) return;
    await updateCase({ amounts: [...detail.case.amounts, { id: window.crypto.randomUUID(), label: amountLabel,
      currency: amountCurrency.toUpperCase(), amount: amountValue, precision: "exact", certainty: "documented", sourceRefs: [] }] });
    setAmountLabel(""); setAmountValue("");
  };
  const addGap = async () => {
    if (!detail || !gapLabel.trim()) return;
    await updateCase({ materialGaps: [...detail.case.materialGaps, { id: window.crypto.randomUUID(), label: gapLabel,
      reason: copy(language, "需要补充材料", "Supporting material is needed"), priority: "important", status: "open" }] });
    setGapLabel("");
  };
  const runLegal = async () => {
    if (!detail) return;
    const result = await window.grudgeVault.cases.runLegalCheck(detail.case.id);
    if (!result.ok) return onError(result.error.message);
    onNotice(copy(language, "已生成离线动态核验问题；没有产生实体法律结论。", "Offline verification questions generated; no substantive legal conclusion was produced."));
    await openCase(detail.case.id);
  };
  const toggle = (items: string[], id: string, checked: boolean, set: (value: string[]) => void) => set(checked ? [...items, id] : items.filter((item) => item !== id));

  return <div className="phase-five-grid cases-view">
    <aside className="panel phase-five-index"><div className="section-heading"><h2>{copy(language, "材料包", "Material packages")}</h2>
      <button onClick={() => { setDetail(undefined); setTitle(""); setSummary(""); setEventRefs([]); setPersonRefs([]); setAssetRefs([]); }}>{copy(language, "新建", "New")}</button></div>
      <div className="event-list">{cases.map((item) => <article key={item.id} className={detail?.case.id === item.id ? "selected" : ""} onClick={() => void openCase(item.id)}>
        <div><strong>{item.title}</strong><span>{item.jurisdiction === "unspecified" ? copy(language, "未填写地区", "No region") : item.jurisdiction} · {item.asOfDate}</span></div><em className={`status ${item.status}`}>{({ draft: copy(language, "整理中", "Preparing"), active: copy(language, "使用中", "Active"), archived: copy(language, "已归档", "Archived") } as const)[item.status]}</em></article>)}</div></aside>
    <section className="panel phase-five-detail"><div className="section-heading"><h2>{detail ? detail.case.title : copy(language, "新材料包", "New material package")}</h2>
      {detail && <div className="row-actions permanent"><button onClick={() => void runLegal()}>{copy(language, "生成待核实问题", "Generate verification questions")}</button></div>}</div>
      <div className="editor-form"><label className="field"><span>{copy(language, "标题", "Title")}</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <div className="form-row"><label className="field"><span>{copy(language, "适用地区（可选）", "Region (optional)")}</span><input value={jurisdiction} onChange={(event) => setJurisdiction(event.target.value)} /></label>
          <label className="field"><span>{copy(language, "整理日期", "Package date")}</span><input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label></div>
        <label className="field"><span>{copy(language, "状态", "Status")}</span><select value={status} onChange={(event) => setStatus(event.target.value as Case["status"])}>
          <option value="draft">{copy(language, "整理中", "Preparing")}</option><option value="active">{copy(language, "使用中", "Active")}</option><option value="archived">{copy(language, "已归档", "Archived")}</option></select></label>
        <label className="field"><span>{copy(language, "摘要", "Summary")}</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <fieldset><legend>{copy(language, "包含的记录", "Included records")}</legend><div className="people-picker">{events.map((item) => <label className="check" key={item.id}>
          <input type="checkbox" checked={eventRefs.includes(item.id)} onChange={(event) => toggle(eventRefs, item.id, event.target.checked, setEventRefs)} />{item.title}</label>)}</div></fieldset>
        <fieldset><legend>{copy(language, "人物", "People")}</legend><div className="people-picker">{people.map((item) => <label className="check" key={item.id}>
          <input type="checkbox" checked={personRefs.includes(item.id)} onChange={(event) => toggle(personRefs, item.id, event.target.checked, setPersonRefs)} />{item.displayName}</label>)}</div></fieldset>
        <fieldset><legend>{copy(language, "包含的材料", "Included materials")}</legend><div className="people-picker">{evidence.map((item) => <label className="check" key={item.id}>
          <input type="checkbox" checked={assetRefs.includes(item.id)} onChange={(event) => toggle(assetRefs, item.id, event.target.checked, setAssetRefs)} />{item.originalFileName}</label>)}</div></fieldset>
        <button className="primary wide" onClick={() => void updateCase()}>{detail ? copy(language, "保存材料包", "Save material package") : copy(language, "创建材料包", "Create material package")}</button></div>
      {detail && <><section className="subsection"><h3>{copy(language, "十进制金额", "Decimal amounts")}</h3><div className="mini-list">{detail.case.amounts.map((item) =>
        <article key={item.id}><div><strong>{item.label}</strong><span>{item.currency} {item.amount ?? `${item.minimum}–${item.maximum}`} · {item.certainty}</span></div></article>)}</div>
        <div className="compact-form"><input placeholder={copy(language, "金额说明", "Amount label")} value={amountLabel} onChange={(event) => setAmountLabel(event.target.value)} />
          <input maxLength={3} value={amountCurrency} onChange={(event) => setAmountCurrency(event.target.value)} /><input inputMode="decimal" placeholder="0.00" value={amountValue} onChange={(event) => setAmountValue(event.target.value)} />
          <button onClick={() => void addAmount()}>{copy(language, "添加", "Add")}</button></div></section>
        <section className="subsection"><h3>{copy(language, "材料缺口", "Material gaps")}</h3><div className="mini-list">{detail.case.materialGaps.map((item) =>
          <article key={item.id}><div><strong>{item.label}</strong><span>{item.reason}</span></div><em className={`status ${item.status}`}>{item.status}</em></article>)}</div>
          <div className="inline-create"><input value={gapLabel} placeholder={copy(language, "缺少的材料", "Missing material")} onChange={(event) => setGapLabel(event.target.value)} /><button onClick={() => void addGap()}>{copy(language, "添加缺口", "Add gap")}</button></div></section>
        <section className="subsection"><h3>{copy(language, "相关时间线", "Related timeline")}</h3><div className="timeline-groups">{detail.timeline.groups.map((group) =>
          <section key={group.key}><h3>{group.label}</h3>{group.events.map((item) => <article key={item.id}><span className="timeline-dot" /><div><strong>{item.title}</strong><p>{item.narrative}</p></div></article>)}</section>)}</div></section>
        {detail.legalVerification && <section className="subsection"><h3>{copy(language, "待核实问题", "Verification questions")}</h3>
          <em className={`status ${detail.legalVerification.stale ? "failed" : "queued"}`}>{detail.legalVerification.stale ? copy(language, "需重新生成", "Needs refresh") : copy(language, "需要外部核实", "Needs external verification")}</em>
          <p>{detail.legalVerification.disclaimer}</p><ul>{detail.legalVerification.questions.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        <BinderWizard detail={detail} language={language} onError={onError} onNotice={onNotice} /></>}
    </section>
  </div>;
}

export function WorkspaceSecurityPanel({ language, onError, onNotice, onLocked, mode = "advanced" }: CommonProps & {
  onLocked(): void;
  mode?: "general" | "advanced";
}) {
  const [settings, setSettings] = useState<WorkspaceSecuritySettings>();
  const [crypto, setCrypto] = useState<WorkspaceCryptoStatus>();
  const [passphrase, setPassphrase] = useState("");
  const refresh = useCallback(async () => {
    const [securityResult, cryptoResult] = await Promise.all([
      window.grudgeVault.workspace.getSecuritySettings(), window.grudgeVault.workspace.cryptoStatus()
    ]);
    if (securityResult.ok) setSettings(securityResult.data); else onError(securityResult.error.message);
    if (cryptoResult.ok) setCrypto(cryptoResult.data); else onError(cryptoResult.error.message);
  }, [onError]);
  useEffect(() => { void refresh(); }, [refresh]);
  const save = async () => {
    if (!settings) return;
    const result = await window.grudgeVault.workspace.updateSecuritySettings(settings);
    if (!result.ok) onError(result.error.message); else onNotice(copy(language, "安全设置已保存。", "Security settings saved."));
  };
  const exportRecovery = async () => {
    const result = await window.grudgeVault.workspace.exportRecovery({ passphrase });
    setPassphrase("");
    if (!result.ok) onError(result.error.message); else if (result.data) onNotice(copy(language, "恢复包已导出，请与快照分开保管。", "Recovery package exported; store it separately from snapshots."));
  };
  const rotate = async () => {
    if (!window.confirm(copy(language, "开始可恢复的全库密钥轮换？", "Start recoverable workspace key rotation?"))) return;
    const result = await window.grudgeVault.workspace.rotateKey();
    if (!result.ok) onError(result.error.message); else { setCrypto(result.data); onNotice(copy(language, "密钥迁移已排队。", "Key migration queued.")); }
  };
  const lock = async () => {
    const result = await window.grudgeVault.workspace.lock();
    if (!result.ok) onError(result.error.message); else onLocked();
  };
  return <section className="panel settings-card security-card"><h2>{mode === "general" ? copy(language, "自动锁定", "Auto lock") : copy(language, "数据保护", "Data protection")}</h2>
    {settings && <><label className="field"><span>{copy(language, "自动锁定", "Auto lock")}</span><select value={settings.autoLockMinutes}
      onChange={(event) => setSettings({ ...settings, autoLockMinutes: Number(event.target.value) as WorkspaceSecuritySettings["autoLockMinutes"] })}>
      <option value={0}>{copy(language, "关闭", "Off")}</option>{[5, 15, 30, 60].map((value) => <option key={value} value={value}>{value} {copy(language, "分钟", "min")}</option>)}</select></label>
      {mode === "advanced" && <label className="field"><span>{copy(language, "材料检查间隔（天）", "Material check interval (days)")}</span><input type="number" min={1} max={365} value={settings.integrityScanIntervalDays}
        onChange={(event) => setSettings({ ...settings, integrityScanIntervalDays: Number(event.target.value) })} /></label>}
      <div className="landing-actions"><button onClick={() => void save()}>{copy(language, "保存", "Save")}</button>
        {mode === "general" && <button className="primary" onClick={() => void lock()}>{copy(language, "立即锁定", "Lock now")}</button>}</div></>}
    {mode === "advanced" && <><details className="advanced-section"><summary>{copy(language, "加密诊断信息", "Encryption diagnostics")}</summary>
      {crypto && <div className="crypto-status"><p><strong>Epoch {crypto.keyEpoch}</strong> · {crypto.migrationState}</p><code>{crypto.activeKeyId}</code>
        <p className="muted">GVOB v{crypto.objectFormatVersion} · retiring {crypto.retiringKeyIds.length}</p></div>}</details>
      <label className="field"><span>{copy(language, "恢复包口令（至少 12 字符）", "Recovery passphrase (12+ characters)")}</span>
        <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
      <div className="landing-actions"><button disabled={Array.from(passphrase).length < 12} onClick={() => void exportRecovery()}>{copy(language, "导出恢复包", "Export recovery package")}</button>
        <button onClick={() => void rotate()}>{copy(language, "轮换密钥", "Rotate key")}</button><button className="primary" onClick={() => void lock()}>{copy(language, "立即锁定", "Lock now")}</button></div></>}
  </section>;
}
