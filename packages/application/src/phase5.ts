import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  Asset, Case, CaseBinderExportResult, CaseBinderManifestEntry, CaseBinderManifestV1,
  CaseBinderPreview, CaseBinderProfile, CaseDetail, CaseRevision, DerivedArtifact,
  EvidenceDetail, EvidenceReferenceImpact, IntegrityScan, IntegrityScanItemResult, LegalVerificationResult
} from "@grudge-vault/domain";
import { AppError, type CaseWriteFields } from "@grudge-vault/shared";
import { buildTimeline } from "./phase3";
import type { AssetRepositoryPort, ObjectVaultPort, VaultKey } from "./index";
import type { MemoryRepositoryPort } from "./memory";

export interface PhaseFiveRepositoryPort {
  listCases(): Case[];
  getCase(id: string): Case | undefined;
  listCaseRevisions(id: string): CaseRevision[];
  commitCase(value: Case, revision: CaseRevision): Case;
  listEvidence(): EvidenceDetail[];
  getEvidence(assetId: string): EvidenceDetail | undefined;
  getEvidenceImpact(assetId: string): EvidenceReferenceImpact;
  setAssetAvailability(
    assetId: string,
    status: Asset["availabilityStatus"],
    now: string,
    supersededByAssetId?: string
  ): void;
  purgeUnreferencedAsset(assetId: string): boolean;
  listDerivedArtifacts(assetId?: string): DerivedArtifact[];
  saveDerivedArtifact(artifact: DerivedArtifact): DerivedArtifact;
  createIntegrityScan(scan: IntegrityScan): IntegrityScan;
  listIntegrityScans(): IntegrityScan[];
  getIntegrityScan(id: string): IntegrityScan | undefined;
  saveIntegrityScan(scan: IntegrityScan): IntegrityScan;
  saveIntegrityScanResult(scanId: string, result: IntegrityScanItemResult): void;
  getActiveCryptoMigration(): CryptoMigrationRecord | undefined;
  saveCryptoMigration(migration: CryptoMigrationRecord): CryptoMigrationRecord;
  saveLegalVerification(result: LegalVerificationResult): LegalVerificationResult;
  getLatestLegalVerification(caseId: string): LegalVerificationResult | undefined;
  saveBinderExport(input: {
    id: string;
    caseId: string;
    caseRevision: number;
    profile: CaseBinderProfile;
    manifestSha256: string;
    generatedAt: string;
  }): void;
}

export interface CryptoMigrationRecord {
  id: string;
  fromKeyId: string;
  toKeyId: string;
  state: "queued" | "running" | "succeeded" | "failed";
  cursor?: string;
  processedObjects: number;
  totalObjects: number;
  lastError?: string | undefined;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface LegalInformationAdapterPort {
  readonly identity: string;
  readonly version: number;
  verify(input: {
    caseId: string;
    caseRevision: number;
    jurisdiction: string;
    asOfDate: string;
    topics: string[];
  }): Promise<Omit<LegalVerificationResult, "id" | "createdAt" | "stale">>;
}

export class PlaceholderLegalInformationAdapter implements LegalInformationAdapterPort {
  readonly identity = "offline.placeholder-legal-information";
  readonly version = 1;

  async verify(input: {
    caseId: string;
    caseRevision: number;
    jurisdiction: string;
    asOfDate: string;
    topics: string[];
  }): Promise<Omit<LegalVerificationResult, "id" | "createdAt" | "stale">> {
    const normalized = {
      jurisdiction: input.jurisdiction.trim() || "unspecified",
      asOfDate: input.asOfDate,
      topics: input.topics.map((item) => item.trim()).filter(Boolean).sort()
    };
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    return {
      caseId: input.caseId,
      caseRevision: input.caseRevision,
      jurisdiction: normalized.jurisdiction,
      asOfDate: normalized.asOfDate,
      adapterIdentity: this.identity,
      adapterVersion: this.version,
      requestHash,
      status: "needs_external_verification",
      questions: [
        `Which rules were effective in ${normalized.jurisdiction} on ${normalized.asOfDate}?`,
        "Which limitation periods, evidence rules, and available remedies require authoritative verification?",
        ...normalized.topics.map((topic) => `Which authoritative sources govern: ${topic}?`)
      ],
      disclaimer: "This offline result organizes verification questions only. It is not legal advice or a legal conclusion."
    };
  }
}

export interface CaseSummaryPdfPort {
  render(input: { title: string; locale: "zh-CN" | "en"; html: string }): Promise<Buffer>;
}

export interface PhaseFiveContext {
  workspaceId: string;
  workspaceRoot: string;
  key: VaultKey;
  assets: AssetRepositoryPort;
  memory: MemoryRepositoryPort;
  phase5: PhaseFiveRepositoryPort;
  vault: ObjectVaultPort;
}

const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ISO4217_CODES = new Set((Intl as typeof Intl & { supportedValuesOf(key: "currency"): string[] }).supportedValuesOf("currency"));
const CONTACT_PATTERN = /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\+?\d[\d\s().-]{6,}\d)/g;
const ACCOUNT_PATTERN = /\b(?:\d[ -]?){8,20}\b/g;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareDecimal(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  if (leftInteger.length !== rightInteger.length) return leftInteger.length < rightInteger.length ? -1 : 1;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const length = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(length, "0");
  const normalizedRight = rightFraction.padEnd(length, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

function validateCaseFields(fields: CaseWriteFields, context: PhaseFiveContext): CaseWriteFields {
  if (!fields.title.trim()) throw new AppError("VALIDATION_FAILED", "Case title is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.asOfDate)) {
    throw new AppError("VALIDATION_FAILED", "Case as-of date must use YYYY-MM-DD.");
  }
  for (const amount of fields.amounts) {
    if (!/^[A-Z]{3}$/.test(amount.currency) || !ISO4217_CODES.has(amount.currency)) {
      throw new AppError("VALIDATION_FAILED", "Case currencies must use ISO 4217 codes.");
    }
    const values = [amount.amount, amount.minimum, amount.maximum].filter((item): item is string => item !== undefined);
    if (values.length === 0 || values.some((item) => !MONEY_PATTERN.test(item))) {
      throw new AppError("VALIDATION_FAILED", "Case amounts must use non-negative decimal strings.");
    }
    if (amount.precision === "range" && (!amount.minimum || !amount.maximum || compareDecimal(amount.minimum, amount.maximum) > 0)) {
      throw new AppError("VALIDATION_FAILED", "Range amounts require an ordered minimum and maximum.");
    }
  }
  for (const id of unique(fields.eventRefs)) {
    if (!context.memory.getEvent(id)) throw new AppError("ENTITY_NOT_FOUND", "A selected Event no longer exists.");
  }
  for (const id of unique(fields.personRefs)) {
    if (!context.memory.getPerson(id)) throw new AppError("ENTITY_NOT_FOUND", "A selected Person no longer exists.");
  }
  for (const id of unique(fields.sourceRefs)) {
    if (!context.memory.getSourceReference(id)) throw new AppError("ENTITY_NOT_FOUND", "A selected Source no longer exists.");
  }
  const assets = new Map(context.assets.list().map((asset) => [asset.id, asset]));
  for (const id of unique(fields.assetRefs)) {
    if (!assets.has(id)) throw new AppError("ENTITY_NOT_FOUND", "A selected original no longer exists.");
  }
  for (const link of fields.evidenceLinks) {
    if (!assets.has(link.assetId)) throw new AppError("ENTITY_NOT_FOUND", "A linked original no longer exists.");
    if (!fields.assetRefs.includes(link.assetId)) {
      throw new AppError("VALIDATION_FAILED", "Evidence links may only use originals selected by the Case.");
    }
    if (link.eventId && !fields.eventRefs.includes(link.eventId)) {
      throw new AppError("VALIDATION_FAILED", "Evidence links may only target Events selected by the Case.");
    }
    if (link.eventId) {
      const event = context.memory.getEvent(link.eventId)!;
      const statementIds = new Set([...event.facts, ...event.interpretations].map(({ id }) => id));
      if (link.statementIds.some((id) => !statementIds.has(id))) {
        throw new AppError("VALIDATION_FAILED", "Evidence links contain a Statement outside the selected Event.");
      }
    }
  }
  const selectedSources = new Set(fields.sourceRefs);
  const nestedSourceRefs = [
    ...fields.amounts.flatMap(({ sourceRefs }) => sourceRefs),
    ...fields.disputePoints.flatMap(({ sourceRefs }) => sourceRefs),
    ...fields.questions.flatMap(({ sourceRefs }) => sourceRefs),
    ...fields.evidenceLinks.flatMap(({ sourceRefs }) => sourceRefs)
  ];
  if (nestedSourceRefs.some((id) => !selectedSources.has(id))) {
    throw new AppError("VALIDATION_FAILED", "Case fields may only cite Sources selected by the Case.");
  }
  for (const gap of fields.materialGaps) {
    if (gap.resolvedByAssetId && !fields.assetRefs.includes(gap.resolvedByAssetId)) {
      throw new AppError("VALIDATION_FAILED", "A resolved material gap must use an original selected by the Case.");
    }
  }
  return {
    ...fields,
    title: fields.title.trim(),
    ...(fields.summary?.trim() ? { summary: fields.summary.trim() } : {}),
    jurisdiction: fields.jurisdiction.trim() || "unspecified",
    eventRefs: unique(fields.eventRefs), personRefs: unique(fields.personRefs),
    sourceRefs: unique(fields.sourceRefs), assetRefs: unique(fields.assetRefs),
    amounts: fields.amounts.map((item) => ({ ...item, label: item.label.trim(), sourceRefs: unique(item.sourceRefs) })),
    disputePoints: fields.disputePoints.map((item) => ({ ...item, text: item.text.trim(), sourceRefs: unique(item.sourceRefs) })),
    questions: fields.questions.map((item) => ({ ...item, question: item.question.trim(), reason: item.reason.trim(), sourceRefs: unique(item.sourceRefs) })),
    materialGaps: fields.materialGaps.map((item) => ({ ...item, label: item.label.trim(), reason: item.reason.trim() })),
    evidenceLinks: fields.evidenceLinks.map((item) => ({
      ...item, statementIds: unique(item.statementIds), sourceRefs: unique(item.sourceRefs),
      ...(item.notes?.trim() ? { notes: item.notes.trim() } : {})
    }))
  };
}

function redactText(value: string, detail: CaseDetail, profile: CaseBinderProfile): string {
  let result = value;
  for (const [index, personId] of profile.redactions.personIds.entries()) {
    const person = detail.people.find(({ id }) => id === personId);
    if (person?.displayName) result = result.replaceAll(person.displayName, `Person ${index + 1}`);
  }
  if (profile.redactions.maskContacts) result = result.replace(CONTACT_PATTERN, "[REDACTED CONTACT]");
  if (profile.redactions.maskAccounts) result = result.replace(ACCOUNT_PATTERN, "[REDACTED ACCOUNT]");
  return result;
}

function safeFileName(name: string, fallback: string): string {
  const normalized = name.normalize("NFKC").replace(/[\0/\\:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return (normalized || fallback).slice(0, 120);
}

function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function buildPdfHtml(detail: CaseDetail, profile: CaseBinderProfile): string {
  const redacted = (value: string) => escaped(redactText(value, detail, profile));
  const amountRows = profile.redactions.maskAmounts ? "<li>[REDACTED AMOUNT]</li>" : detail.case.amounts.map((amount) =>
    `<li>${redacted(amount.label)}: ${escaped(amount.currency)} ${escaped(amount.amount ?? `${amount.minimum ?? "?"}–${amount.maximum ?? "?"}`)} (${amount.certainty})</li>`).join("");
  const timeline = detail.timeline.groups.flatMap((group) => group.events.map((event) =>
    `<li><strong>${redacted(group.label)}</strong> — ${redacted(event.title)}</li>`)).join("");
  const disputes = detail.case.disputePoints.map((item) => `<li>${redacted(item.text)}</li>`).join("");
  const gaps = detail.case.materialGaps.map((item) => `<li>${redacted(item.label)} — ${item.status}</li>`).join("");
  return `<!doctype html><html lang="${profile.locale}"><meta charset="utf-8"><style>
    @page{size:A4;margin:18mm}body{font:12px/1.55 system-ui,"Noto Sans CJK SC",sans-serif;color:#222}
    h1{font-size:24px}h2{font-size:16px;margin-top:22px}code{overflow-wrap:anywhere}.notice{padding:10px;background:#f3efe5}
  </style><body><h1>${redacted(detail.case.title)}</h1><p>${redacted(detail.case.summary ?? "")}</p>
  <p class="notice">${redacted(detail.legalVerification?.disclaimer ?? "Materials organizer only; verify any legal information externally.")}</p>
  <h2>Timeline</h2><ol>${timeline}</ol><h2>Amounts</h2><ul>${amountRows}</ul>
  <h2>Disputed points</h2><ul>${disputes}</ul><h2>Missing materials</h2><ul>${gaps}</ul>
  <h2>Evidence</h2><ul>${detail.evidence.map(({ asset }) => `<li>${redacted(profile.redactions.maskFileNames ? "Evidence file" : asset.originalFileName)}<br><code>${asset.sha256}</code></li>`).join("")}</ul>
  </body></html>`;
}

async function hashFile(path: string): Promise<{ sha256: string; byteSize: number }> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

export class PhaseFiveService {
  private readonly previews = new Map<string, CaseBinderPreview>();

  constructor(
    private readonly context: () => PhaseFiveContext,
    private readonly pdf?: CaseSummaryPdfPort,
    private readonly legal: LegalInformationAdapterPort = new PlaceholderLegalInformationAdapter()
  ) {}

  listCases(): Case[] { return this.context().phase5.listCases(); }

  getCase(id: string): CaseDetail {
    const context = this.context();
    const value = context.phase5.getCase(id);
    if (!value) throw new AppError("ENTITY_NOT_FOUND", "The Case no longer exists.");
    const events = value.eventRefs.flatMap((eventId) => context.memory.getEvent(eventId) ?? []);
    const people = value.personRefs.flatMap((personId) => context.memory.getPerson(personId) ?? []);
    const legal = context.phase5.getLatestLegalVerification(id);
    return {
      case: value,
      revisions: context.phase5.listCaseRevisions(id),
      events,
      people,
      evidence: value.assetRefs.flatMap((assetId) => context.phase5.getEvidence(assetId) ?? []),
      timeline: buildTimeline(events, { includeArchived: true }),
      ...(legal ? { legalVerification: { ...legal, stale: legal.caseRevision !== value.currentRevision } } : {})
    };
  }

  createCase(fields: CaseWriteFields, reason: string, actor: CaseRevision["actor"] = "user"): Case {
    const context = this.context();
    const normalized = validateCaseFields(fields, context);
    const now = new Date().toISOString();
    const value: Case = { id: randomUUID(), ...normalized, currentRevision: 1, createdAt: now, updatedAt: now };
    return context.phase5.commitCase(value, {
      id: randomUUID(), caseId: value.id, revision: 1, previousRevision: 0,
      snapshot: value, actor, reason: reason.trim() || "Case created", createdAt: now
    });
  }

  updateCase(caseId: string, expectedRevision: number, fields: CaseWriteFields, reason: string, actor: CaseRevision["actor"] = "user"): Case {
    const context = this.context();
    const current = context.phase5.getCase(caseId);
    if (!current) throw new AppError("ENTITY_NOT_FOUND", "The Case no longer exists.");
    if (current.currentRevision !== expectedRevision) {
      throw new AppError("CASE_REVISION_CONFLICT", "The Case changed after it was opened. Reload it before saving.", true);
    }
    const now = new Date().toISOString();
    const value: Case = {
      id: current.id, ...validateCaseFields(fields, context), currentRevision: current.currentRevision + 1,
      createdAt: current.createdAt, updatedAt: now
    };
    return context.phase5.commitCase(value, {
      id: randomUUID(), caseId, revision: value.currentRevision, previousRevision: current.currentRevision,
      snapshot: value, actor, reason: reason.trim() || "Case updated", createdAt: now
    });
  }

  listEvidence(): EvidenceDetail[] { return this.context().phase5.listEvidence(); }
  getEvidence(assetId: string): EvidenceDetail {
    const value = this.context().phase5.getEvidence(assetId);
    if (!value) throw new AppError("ASSET_NOT_FOUND", "The original no longer exists.");
    return value;
  }
  getEvidenceImpact(assetId: string): EvidenceReferenceImpact { return this.context().phase5.getEvidenceImpact(assetId); }

  startIntegrityScan(): IntegrityScan {
    const context = this.context();
    const now = new Date().toISOString();
    const scan: IntegrityScan = {
      id: randomUUID(), state: "queued",
      counts: { total: context.assets.list().filter(({ availabilityStatus }) => availabilityStatus !== "deleted").length, verified: 0, corrupt: 0, missing: 0, skipped: 0 },
      createdAt: now, updatedAt: now
    };
    return context.phase5.createIntegrityScan(scan);
  }

  async runIntegrityScan(scanId: string, reportProgress: (value: number) => void, signal: AbortSignal): Promise<void> {
    const context = this.context();
    let scan = context.phase5.getIntegrityScan(scanId);
    if (!scan) throw new AppError("ENTITY_NOT_FOUND", "The integrity scan no longer exists.");
    const candidates = context.assets.list().filter(({ availabilityStatus }) => availabilityStatus !== "deleted")
      .sort((a, b) => a.id.localeCompare(b.id));
    let start = scan.cursor ? candidates.findIndex(({ id }) => id === scan!.cursor) + 1 : 0;
    scan = context.phase5.saveIntegrityScan({ ...scan, state: "running", updatedAt: new Date().toISOString() });
    for (let index = Math.max(0, start); index < candidates.length; index += 1) {
      if (signal.aborted) throw new Error("Integrity scan interrupted.");
      const asset = candidates[index]!;
      const valid = await context.vault.verify(asset.sha256, context.key, undefined, asset.byteSize);
      const now = new Date().toISOString();
      if (valid) {
        context.assets.setIntegrity(asset.id, "verified", now);
        context.phase5.setAssetAvailability(asset.id, "available", now);
        scan.counts.verified += 1;
        context.phase5.saveIntegrityScanResult(scan.id, {
          assetId: asset.id, result: "verified", expectedSha256: asset.sha256,
          expectedByteSize: asset.byteSize, verifiedAt: now
        });
      } else {
        const exists = await context.vault.exists(asset.sha256);
        context.assets.setIntegrity(asset.id, exists ? "corrupt" : "pending");
        context.phase5.setAssetAvailability(asset.id, exists ? "available" : "missing", now);
        if (exists) scan.counts.corrupt += 1; else scan.counts.missing += 1;
        context.phase5.saveIntegrityScanResult(scan.id, {
          assetId: asset.id, result: exists ? "corrupt" : "missing", expectedSha256: asset.sha256,
          expectedByteSize: asset.byteSize, verifiedAt: now
        });
      }
      scan = context.phase5.saveIntegrityScan({ ...scan, cursor: asset.id, updatedAt: now });
      reportProgress(candidates.length === 0 ? 1 : (index + 1) / candidates.length);
    }
    context.phase5.saveIntegrityScan({ ...scan, state: "succeeded", updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  }

  async deleteOriginal(assetId: string, confirmReferencedDeletion: boolean): Promise<EvidenceDetail> {
    const context = this.context();
    const impact = context.phase5.getEvidenceImpact(assetId);
    const referenced = impact.eventIds.length + impact.sourceItemIds.length + impact.importRunIds.length + impact.caseIds.length > 0;
    if (referenced && !confirmReferencedDeletion) {
      throw new AppError("EVIDENCE_UNAVAILABLE", "The original is referenced. Review and confirm the deletion impact first.");
    }
    const asset = context.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The original no longer exists.");
    const evidence = this.getEvidence(assetId);
    const now = new Date().toISOString();
    await context.vault.remove(asset.sha256);
    if (context.phase5.purgeUnreferencedAsset(assetId)) {
      return {
        ...evidence,
        asset: { ...asset, availabilityStatus: "deleted", deletedAt: now },
        availabilityStatus: "deleted",
        deletedAt: now
      };
    }
    context.phase5.setAssetAvailability(assetId, "deleted", now);
    return this.getEvidence(assetId);
  }

  supersedeOriginal(oldAssetId: string, newAssetId: string): EvidenceDetail {
    const context = this.context();
    const oldAsset = context.assets.findById(oldAssetId);
    const next = context.assets.findById(newAssetId);
    if (!oldAsset || !next || oldAssetId === newAssetId) throw new AppError("VALIDATION_FAILED", "Choose two distinct existing originals.");
    context.phase5.setAssetAvailability(oldAssetId, "superseded", new Date().toISOString(), newAssetId);
    return this.getEvidence(oldAssetId);
  }

  async runLegalCheck(caseId: string): Promise<LegalVerificationResult> {
    const context = this.context();
    const value = context.phase5.getCase(caseId);
    if (!value) throw new AppError("ENTITY_NOT_FOUND", "The Case no longer exists.");
    const result = await this.legal.verify({
      caseId, caseRevision: value.currentRevision, jurisdiction: value.jurisdiction, asOfDate: value.asOfDate,
      topics: value.disputePoints.map(({ text }) => text)
    });
    return context.phase5.saveLegalVerification({ ...result, id: randomUUID(), createdAt: new Date().toISOString(), stale: false });
  }

  previewBinder(caseId: string, profile: CaseBinderProfile): CaseBinderPreview {
    const detail = this.getCase(caseId);
    if (detail.case.currentRevision !== profile.caseRevision) throw new AppError("BINDER_PREVIEW_STALE", "Reload the Case before previewing its Binder.", true);
    if (profile.eventIds.some((id) => !detail.case.eventRefs.includes(id)) ||
      profile.sourceItemIds.some((id) => !detail.case.sourceRefs.includes(id))) {
      throw new AppError("ENTITY_NOT_FOUND", "A selected Event or Source is outside this Case.");
    }
    const indexedAssets = profile.assetIds
      .map((id) => detail.evidence.find(({ asset }) => asset.id === id)).filter(Boolean) as EvidenceDetail[];
    if (indexedAssets.length !== profile.assetIds.length) {
      throw new AppError("ENTITY_NOT_FOUND", "A selected original is outside this Case.");
    }
    const selectedAssets = profile.includeOriginals ? indexedAssets : [];
    const availableDerived = detail.evidence.flatMap(({ derivedArtifacts }) => derivedArtifacts);
    const selectedDerived = (profile.includeDerivedArtifacts ? profile.derivedArtifactIds : [])
      .map((id) => availableDerived.find((artifact) => artifact.id === id)).filter(Boolean) as DerivedArtifact[];
    if (selectedDerived.length !== (profile.includeDerivedArtifacts ? profile.derivedArtifactIds.length : 0)) {
      throw new AppError("ENTITY_NOT_FOUND", "A selected derived artifact is outside this Case.");
    }
    const blockedReasons = selectedAssets.flatMap(({ asset, availabilityStatus }) => {
      if (availabilityStatus !== "available") return [`${asset.originalFileName}: ${availabilityStatus}`];
      if (asset.integrityStatus !== "verified") return [`${asset.originalFileName}: ${asset.integrityStatus}`];
      return [];
    });
    const warnings = [
      ...(profile.includeOriginals ? ["Included originals are byte-for-byte unchanged and may contain sensitive information."] : []),
      ...(detail.case.materialGaps.some(({ status }) => status === "open") ? ["The Case still has open material gaps."] : []),
      ...(detail.case.questions.some(({ status }) => status === "open") ? ["The Case still has unanswered questions."] : [])
    ];
    const files = [
      { path: "case-summary.pdf", classification: "generated" as const },
      { path: "01_timeline/timeline.json", classification: "generated" as const },
      { path: "02_statements/statements.json", classification: "generated" as const },
      { path: "03_people/people.json", classification: "generated" as const },
      { path: "04_evidence-index/evidence.json", classification: "generated" as const },
      ...selectedAssets.map(({ asset }, index) => ({
        path: `05_originals/${String(index + 1).padStart(3, "0")}-${safeFileName(profile.redactions.maskFileNames ? `evidence${extname(asset.originalFileName)}` : asset.originalFileName, `evidence-${index + 1}`)}`,
        classification: "original" as const, byteSize: asset.byteSize, sourceId: asset.id, sha256: asset.sha256
      })),
      ...selectedDerived.map((artifact, index) => ({
        path: `06_transcripts/${String(index + 1).padStart(3, "0")}-${safeFileName(`${artifact.kind}-${artifact.id}${extname(artifact.mimeType)}`, `derived-${index + 1}`)}`,
        classification: "derived" as const, byteSize: artifact.byteSize, sourceId: artifact.id, sha256: artifact.sha256
      }))
    ];
    const preview: CaseBinderPreview = {
      id: randomUUID(), caseId, caseRevision: profile.caseRevision, profile,
      files, warnings, blockedReasons, createdAt: new Date().toISOString()
    };
    this.previews.set(preview.id, preview);
    return preview;
  }

  async exportBinder(previewId: string, destinationPath: string): Promise<CaseBinderExportResult> {
    const preview = this.previews.get(previewId);
    if (!preview) throw new AppError("BINDER_PREVIEW_STALE", "Create a fresh Binder preview before exporting.");
    const detail = this.getCase(preview.caseId);
    if (detail.case.currentRevision !== preview.caseRevision) throw new AppError("BINDER_PREVIEW_STALE", "The Case changed after the Binder preview.", true);
    if (preview.blockedReasons.length > 0) throw new AppError("BINDER_EXPORT_FAILED", "Resolve unavailable originals before exporting.");
    if (!this.pdf) throw new AppError("BINDER_EXPORT_FAILED", "The PDF renderer is unavailable.");
    if (!isAbsolute(destinationPath) || dirname(destinationPath) === destinationPath) {
      throw new AppError("BINDER_EXPORT_FAILED", "Choose a safe absolute Binder destination.");
    }
    const context = this.context();
    const staging = join(dirname(destinationPath), `.${randomUUID()}.case-binder.tmp`);
    const generatedAt = new Date().toISOString();
    try {
      await stat(destinationPath).then(() => { throw new AppError("BINDER_EXPORT_FAILED", "Choose a destination that does not already exist."); }, () => undefined);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const scopedEvents = detail.events.filter(({ id }) => preview.profile.eventIds.includes(id));
      const scopedEvidence = detail.evidence.filter(({ asset, derivedArtifacts }) =>
        preview.profile.assetIds.includes(asset.id) || derivedArtifacts.some(({ id }) => preview.profile.derivedArtifactIds.includes(id)));
      const scopedDetail: CaseDetail = {
        ...detail, events: scopedEvents, evidence: scopedEvidence,
        timeline: buildTimeline(scopedEvents, { includeArchived: true })
      };
      const redact = (value: string) => redactText(value, scopedDetail, preview.profile);
      const generated = new Map<string, unknown>([
        ["01_timeline/timeline.json", scopedDetail.timeline],
        ["02_statements/statements.json", scopedEvents.map(({ id, title, currentRevision, facts, interpretations }) => ({
          id, title: redact(title), currentRevision,
          facts: facts.map((item) => ({ ...item, text: redact(item.text) })),
          interpretations: interpretations.map((item) => ({ ...item, text: redact(item.text) }))
        }))],
        ["03_people/people.json", detail.people.map((person, index) => ({
          id: person.id,
          displayName: preview.profile.redactions.personIds.includes(person.id) ? `Person ${index + 1}` : person.displayName
        }))],
        ["04_evidence-index/evidence.json", scopedEvidence.filter(({ asset }) => preview.profile.assetIds.includes(asset.id)).map(({ asset, availabilityStatus }) => ({
          assetId: asset.id, fileName: preview.profile.redactions.maskFileNames ? "[REDACTED FILENAME]" : asset.originalFileName,
          sha256: asset.sha256, byteSize: asset.byteSize, mimeType: asset.mimeType, availabilityStatus, integrityStatus: asset.integrityStatus
        }))]
      ]);
      const entries: CaseBinderManifestEntry[] = [];
      const pdfPath = join(staging, "case-summary.pdf");
      await writeFile(pdfPath, await this.pdf.render({ title: detail.case.title, locale: preview.profile.locale, html: buildPdfHtml(scopedDetail, preview.profile) }), { mode: 0o600 });
      for (const [filePath, value] of generated) {
        const absolute = join(staging, filePath);
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      }
      for (const file of preview.files.filter(({ classification }) => classification === "original")) {
        const evidence = scopedEvidence.find(({ asset }) => asset.id === file.sourceId)!;
        if (evidence.availabilityStatus !== "available" || !(await context.vault.verify(evidence.asset.sha256, context.key, undefined, evidence.asset.byteSize))) {
          throw new AppError("BINDER_EXPORT_FAILED", `Original ${evidence.asset.originalFileName} failed export verification.`);
        }
        const absolute = join(staging, file.path);
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        await pipeline(await context.vault.open(evidence.asset.sha256, context.key), createWriteStream(absolute, { flags: "wx", mode: 0o600 }));
      }
      for (const file of preview.files.filter(({ classification }) => classification === "derived")) {
        const artifact = scopedEvidence.flatMap(({ derivedArtifacts }) => derivedArtifacts).find(({ id }) => id === file.sourceId);
        if (!artifact || !(await context.vault.verify(artifact.sha256, context.key, undefined, artifact.byteSize))) {
          throw new AppError("BINDER_EXPORT_FAILED", "A selected derived artifact failed export verification.");
        }
        const absolute = join(staging, file.path);
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        await pipeline(await context.vault.open(artifact.sha256, context.key), createWriteStream(absolute, { flags: "wx", mode: 0o600 }));
      }
      for (const file of preview.files) {
        const info = await hashFile(join(staging, file.path));
        entries.push({ path: file.path.split(sep).join("/"), classification: file.classification, ...info,
          ...(file.sourceId ? { sourceId: file.sourceId } : {}),
          ...(file.classification === "original" && file.sha256 ? { originalSha256: file.sha256 } : {}) });
      }
      const manifest: CaseBinderManifestV1 = {
        formatVersion: 1, caseId: detail.case.id, caseRevision: detail.case.currentRevision, generatedAt,
        generatorIdentity: "grudge-vault.case-binder", generatorVersion: 1, profile: preview.profile,
        eventRevisions: scopedEvents.map(({ id, currentRevision }) => ({ eventId: id, revision: currentRevision })), entries
      };
      const manifestPath = join(staging, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const manifestInfo = await hashFile(manifestPath);
      const sums = [...entries, { path: "manifest.json", classification: "generated" as const, ...manifestInfo }]
        .map(({ sha256, path }) => `${sha256}  ${path}`).join("\n") + "\n";
      await writeFile(join(staging, "sha256sums.txt"), sums, { mode: 0o600 });
      await rename(staging, destinationPath);
      const all = [...entries, { path: "manifest.json", classification: "generated" as const, ...manifestInfo },
        { path: "sha256sums.txt", classification: "generated" as const, ...(await hashFile(join(destinationPath, "sha256sums.txt"))) }];
      const result: CaseBinderExportResult = {
        path: destinationPath, manifestSha256: manifestInfo.sha256, fileCount: all.length,
        byteSize: all.reduce((sum, item) => sum + item.byteSize, 0), generatedAt
      };
      context.phase5.saveBinderExport({ id: randomUUID(), caseId: detail.case.id, caseRevision: detail.case.currentRevision,
        profile: preview.profile, manifestSha256: manifestInfo.sha256, generatedAt });
      this.previews.delete(previewId);
      return result;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("BINDER_EXPORT_FAILED", "The Case Binder could not be exported.", true, { cause: error });
    }
  }
}
