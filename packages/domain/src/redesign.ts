import type { Asset, EntityId, IsoDateTime, Precision, TemporalValue } from "./index";

export type ScreeningDecision = "include" | "skip" | "review";
export type EventCategory = "grudge" | "rights" | "danger";
export type ScreeningCoverage = "complete" | "partial";
export type RecordOrigin = "manual" | "dayone" | "zip" | "migration";
export type ReportState = "queued" | "running" | "partial" | "failed" | "complete" | "stale";

/** Volatile metadata only. No media content, file path, name, or credential belongs in progress events. */
export interface NativeMediaProgress {
  mediaId: string;
  mediaNumber: number;
  mediaCount: number;
  stage: "processing" | "understanding" | "checked" | "summarizing";
  segmentNumber: number;
  checkedDurationMs: number;
  sourceDurationMs?: number;
}

/** Per-request observation, never a billing estimate or a source-level audit record. */
export type ModelUsageEvent = { kind: "request-started" } | {
  kind: "response-received"; promptTokens?: number; completionTokens?: number;
};
export interface ModelUsageTotals {
  requests: number;
  responses: number;
  completeUsageResponses: number;
  promptTokens: number;
  completionTokens: number;
}

export interface SourceAnchor {
  sourceVersion: string;
  surface?: "source" | "record" | "report" | "user";
  fieldKey?: FieldOverride["fieldKey"];
  assetId?: EntityId;
  temporaryMediaRef?: string;
  textRange?: [number, number];
  intervalMs?: [number, number];
  frameTimeMs?: number;
}

export interface ScreeningResult {
  decision: ScreeningDecision;
  categories: EventCategory[];
  reason: string;
  anchors: SourceAnchor[];
  coverage: ScreeningCoverage;
  policyVersion: string;
}

export type ScreenAndSaveResult =
  | { kind: "saved"; recordId: EntityId; reportState: "queued" }
  | { kind: "skipped"; message: string }
  | { kind: "needs_review"; pendingId: EntityId }
  | { kind: "failed"; code: string; retryable: boolean };

export interface IntakeAttachment {
  id: EntityId;
  fileName: string;
  mimeType: string;
  byteSize: number;
  kind: "image" | "audio" | "video";
}

export interface PreparedIntake {
  sessionId: EntityId;
  textLength: number;
  attachments: IntakeAttachment[];
  expiresAt: IsoDateTime;
}

export interface RetainedSource {
  id: EntityId;
  recordId: EntityId;
  origin: RecordOrigin;
  connectorId?: string;
  journalId?: string;
  entryId?: string;
  sourceVersion: string;
  contentHash: string;
  text?: string;
  recordedAt: IsoDateTime;
  createdAt: IsoDateTime;
}

export interface EventRecord {
  id: EntityId;
  origin: RecordOrigin;
  categories: EventCategory[];
  title: string;
  summary: string;
  revision: number;
  occurredAt: TemporalValue;
  /** Reversible current report/user projection, not a verified fact or stored source rewrite. */
  occurredAtSource?: ReportFieldSource;
  occurredAtPrecision?: Precision;
  recordedAt: IsoDateTime;
  reportState: ReportState;
  sourceUpdated: boolean;
  sourceReviewRequired: boolean;
  attachmentCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ReportFieldSource = "source" | "ai" | "user";

export interface ReportField<T = string> {
  value?: T;
  source: ReportFieldSource;
  prompt?: string;
}

export interface ReportPerson {
  name: string;
  role?: string;
  source: ReportFieldSource;
}

export interface ReportStep {
  id: EntityId;
  text: string;
  anchor?: SourceAnchor;
}

export interface ReportMediaSegment {
  id: EntityId;
  description: string;
  anchor: SourceAnchor;
}

export interface LegalCitation {
  id: EntityId;
  title: string;
  publisher: string;
  url: string;
  retrievedAt: IsoDateTime;
  jurisdiction: string;
  effectiveInfo?: string;
  supportingExcerpt: string;
  claimId: string;
  verificationStatus: "verified" | "pending" | "failed";
}

export interface AnalysisReportContent {
  summary: string;
  time: ReportField<{ value: string; precision: Precision }>;
  location: ReportField;
  people: ReportPerson[];
  chronology: ReportStep[];
  mediaSegments?: ReportMediaSegment[];
  unknowns: string[];
  disputes: string[];
  speculations?: string[];
  suggestions: string[];
  legalIssues: string[];
  citations: LegalCitation[];
  coverageNotes: string[];
}

export interface AnalysisReport {
  id: EntityId;
  analysisRunId?: EntityId;
  recordId: EntityId;
  recordRevision: number;
  inputHash: string;
  promptVersion: string;
  modelProfile: string;
  content: AnalysisReportContent;
  state: Exclude<ReportState, "queued" | "running" | "stale">;
  errorCode?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface FieldOverride {
  id: EntityId;
  recordId: EntityId;
  fieldKey: "title" | "occurredAt" | "location" | "jurisdiction" | "clarifications";
  value: unknown;
  actor: "user";
  revision: number;
  basis?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ReportClarification {
  kind: "unknown" | "dispute" | "speculation";
  topic: string;
  response: string;
}

export interface EventRecordDetail {
  record: EventRecord;
  source: RetainedSource;
  attachments: Asset[];
  report?: AnalysisReport;
  overrides: FieldOverride[];
}

export interface PendingReview {
  id: EntityId;
  origin: RecordOrigin;
  originLocator?: string;
  sourceVersion: string;
  excerpt: string;
  reason: string;
  categories: EventCategory[];
  coverage: ScreeningCoverage;
  sessionAvailable: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TimelineFilter {
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  category?: EventCategory;
  origin?: RecordOrigin;
  timeZone?: string;
}

export interface TimelinePage {
  records: EventRecord[];
  nextCursor?: string;
}

export interface RecordSearchQuery {
  text: string;
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  category?: EventCategory;
  origin?: RecordOrigin;
  timeZone?: string;
}

export interface RecordSearchHit {
  record: EventRecord;
  explanation: string;
  anchor?: SourceAnchor;
  matches?: Array<{
    explanation: string;
    anchor?: SourceAnchor;
  }>;
}

export interface RecordSearchPage {
  hits: RecordSearchHit[];
  nextCursor?: string;
  capabilities: {
    keyword: "ready";
    semantic: "ready" | "unavailable" | "building";
    media: "ready" | "unavailable" | "building";
    /** Current formal projection only; counts are not evidence of retrieval quality. */
    indexCoverage?: {
      currentFragments: number;
      expectedFragments: number;
      outdatedFragments: number;
    };
  };
}

export type RecordSearchModality = "text" | "image" | "audio" | "video";

export interface PreparedSearchQuery {
  sessionId: EntityId;
  textLength: number;
  attachments: IntakeAttachment[];
  expiresAt: IsoDateTime;
}

export interface RecordSearchFragment {
  id: EntityId;
  recordId: EntityId;
  recordRevision: number;
  sourceVersion: string;
  modality: RecordSearchModality;
  contentHash: string;
  text?: string;
  assetId?: EntityId;
  anchor: SourceAnchor;
}

export interface RecordSearchGeneration {
  id: EntityId;
  adapterIdentity: string;
  adapterVersion: number;
  dimensions: number;
  normalization: "none" | "l2";
  inputModalities: RecordSearchModality[];
  state: "building" | "active" | "superseded" | "failed";
  fragmentCount: number;
  lastError?: string;
  createdAt: IsoDateTime;
  activatedAt?: IsoDateTime;
}

export interface RecordSearchIndexStatus {
  available: boolean;
  enabled: boolean;
  state: "unavailable" | "paused" | "empty" | "checking" | "building" | "ready" | "failed";
  inputModalities: RecordSearchModality[];
  queryModalities: RecordSearchModality[];
  activeGenerationId?: EntityId;
  fragmentCount: number;
  lastError?: string;
}

export interface ConnectorAggregateCounts {
  checked: number;
  included: number;
  skipped: number;
  review: number;
  failed: number;
  analyzed: number;
}

export interface ConnectorState {
  id: EntityId;
  kind: "dayone" | "zip";
  selectedJournals: string[];
  committedCursor?: string;
  scanBoundary?: string;
  policyVersion: string;
  status: "idle" | "running" | "paused" | "cancelled" | "failed";
  counts: ConnectorAggregateCounts;
  lastSuccess?: IsoDateTime;
  nextCheck?: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ScreenedZipImportSummary {
  totalEntries: number;
  included: number;
  skipped: number;
  review: number;
  failed: number;
  mediaEntries: number;
  missingMedia: number;
  issueCount: number;
}

export type ScreenedZipImportCounters = Pick<ScreenedZipImportSummary, "included" | "skipped" | "review" | "failed" | "issueCount">;
/** Latest terminal batch only. No source identifiers, input content or resumable checkpoint. */
export interface ScreenedZipImportReceipt extends ScreenedZipImportCounters {
  finishedAt: IsoDateTime;
  outcome: "completed" | "cancelled" | "failed";
  totalEntries: number | null;
  mediaEntries?: number;
  missingMedia?: number;
  errorCode?: string;
  usage?: ModelUsageTotals;
}
export interface ScreenedZipImportProgress extends ScreenedZipImportCounters {
  operationId: string;
  phase: "selecting" | "previewing" | "confirming" | "screening" | "pausing" | "paused" | "stopping" | "completed" | "cancelled" | "failed";
  totalEntries: number | null;
  updatedAt: IsoDateTime;
  summary?: ScreenedZipImportSummary;
  errorCode?: string;
  usage?: ModelUsageTotals;
  receiptSaved?: boolean;
}

export interface LegacyMigrationSummary {
  total: number;
  included: number;
  skipped: number;
  review: number;
  failed: number;
}
