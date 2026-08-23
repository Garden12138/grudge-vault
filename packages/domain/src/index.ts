export type EntityId = string;
export type IsoDateTime = string;

export type TemporalValue =
  | { kind: "instant"; value: string }
  | { kind: "date"; value: string }
  | { kind: "month"; value: string }
  | { kind: "range"; from?: string; to?: string }
  | { kind: "relative"; text: string; anchorRef?: EntityId }
  | { kind: "unknown" };

export type Certainty = "observed" | "documented" | "recalled" | "inferred" | "unknown";
export type Precision = "exact" | "approximate" | "range" | "unknown";

export interface SourcedValue<T> {
  value: T;
  precision: Precision;
  certainty: Certainty;
  sourceRef?: EntityId;
  verified: boolean;
}

export interface Workspace {
  id: EntityId;
  name: string;
  rootPath: string;
  formatVersion: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type SourceKind = "chat" | "dayone" | "manual" | "manual-file";

export interface Source {
  id: EntityId;
  kind: SourceKind;
  name: string;
  createdAt: IsoDateTime;
}

export interface SourceItem {
  id: EntityId;
  sourceId: EntityId;
  externalId?: string;
  content?: string;
  recordedAt: IsoDateTime;
  assetRefs: EntityId[];
  deletedAt?: IsoDateTime;
}

export interface SourceVersion {
  id: EntityId;
  sourceItemId: EntityId;
  version: number;
  content?: string;
  contentHash: string;
  externalModifiedAt?: IsoDateTime;
  raw: unknown;
  importRunId: EntityId;
  createdAt: IsoDateTime;
}

export interface JournalLocation {
  name?: string;
  locality?: string;
  administrativeArea?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
}

export interface JournalEntry {
  sourceItemId: EntityId;
  externalId: string;
  entryUuid?: string;
  fingerprint: string;
  creationDate: IsoDateTime;
  journalDate: string;
  modifiedDate?: IsoDateTime;
  timeZone?: string;
  tags: string[];
  location?: JournalLocation;
  currentVersionId: EntityId;
  currentVersion: number;
  importRunId: EntityId;
}

export type ImportRunState = "queued" | "running" | "succeeded" | "failed";

export interface ImportRunCounts {
  totalEntries: number;
  newEntries: number;
  updatedEntries: number;
  skippedEntries: number;
  mediaImported: number;
  mediaMissing: number;
  errorCount: number;
}

export interface ImportRun {
  id: EntityId;
  archiveAssetId: EntityId;
  archiveFileName: string;
  state: ImportRunState;
  progress: number;
  counts: ImportRunCounts;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
  lastError?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ImportIssue {
  id: EntityId;
  importRunId: EntityId;
  severity: "warning" | "error";
  code: string;
  entryExternalId?: string;
  archivePath?: string;
  message: string;
  createdAt: IsoDateTime;
}

export interface ImportRunDetail {
  run: ImportRun;
  issues: ImportIssue[];
}

export interface BackfillScope {
  importRunId?: EntityId;
  from?: string;
  to?: string;
  tags: string[];
  batchSize: number;
}

export type BackfillRunState = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface BackfillRun {
  id: EntityId;
  scope: BackfillScope;
  detectorIdentity: string;
  detectorVersion: number;
  state: BackfillRunState;
  totalItems: number;
  processedItems: number;
  candidateCount: number;
  cursor?: string;
  lastError?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
}

export type CandidateReviewState = "pending" | "confirmed" | "ignored" | "merged" | "superseded";

export interface CandidateExtraction {
  id: EntityId;
  sourceVersionId: EntityId;
  eventId: EntityId;
  detectorIdentity: string;
  detectorVersion: number;
  ordinal: number;
  anchorStart: number;
  anchorEnd: number;
  temporalBasis: "source-text" | "relative" | "journal-date";
  reviewState: CandidateReviewState;
  mergedIntoEventId?: EntityId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CandidateSummary {
  extraction: CandidateExtraction;
  event: Event;
  journalEntry: JournalEntry;
  excerpt: string;
}

export interface CandidateDetail extends CandidateSummary {
  detail: EventDetail;
  sourceVersion: SourceVersion;
}

export interface Conversation {
  id: EntityId;
  sourceId: EntityId;
  title: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt?: IsoDateTime;
}

export interface Message {
  id: EntityId;
  conversationId: EntityId;
  sourceItemId: EntityId;
  role: "user" | "assistant" | "system";
  content?: string;
  createdAt: IsoDateTime;
  deletedAt?: IsoDateTime;
}

export type IntegrityStatus = "pending" | "verified" | "corrupt";

export interface Asset {
  id: EntityId;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalFileName: string;
  vaultFormat: number;
  integrityStatus: IntegrityStatus;
  verifiedAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

export type StatementKind =
  | "fact.confirmed"
  | "fact.disputed"
  | "fact.unknown"
  | "interpretation.user"
  | "interpretation.agent"
  | "emotion";

export interface Statement {
  id: EntityId;
  kind: StatementKind;
  text: string;
  sourceRefs: EntityId[];
}

export interface Emotion {
  id: EntityId;
  label: string;
  intensity?: 1 | 2 | 3 | 4 | 5;
  sourceRefs: EntityId[];
}

export interface Interest {
  id: EntityId;
  label: string;
  description?: string;
  sourceRefs: EntityId[];
}

export interface Person {
  id: EntityId;
  displayName: string;
  notes?: string;
  status: "active" | "archived";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EventParticipant {
  personId: EntityId;
  role?: string;
}

export interface CompletenessSummary {
  missingFields: string[];
  openClarificationCount: number;
}

export interface Event {
  id: EntityId;
  title: string;
  status: "candidate" | "confirmed" | "archived";
  occurredAt: TemporalValue;
  recordedAt: IsoDateTime;
  narrative?: string;
  facts: Statement[];
  interpretations: Statement[];
  emotions: Emotion[];
  interests: Interest[];
  participants: EventParticipant[];
  sourceRefs: EntityId[];
  assetRefs: EntityId[];
  completeness: CompletenessSummary;
  currentRevision: number;
  updatedAt: IsoDateTime;
}

export interface EventRevision {
  id: EntityId;
  eventId: EntityId;
  revision: number;
  previousRevision: number;
  snapshot: Event;
  actor: "user" | "importer" | "agent";
  reason: string;
  sourceRefs: EntityId[];
  createdAt: IsoDateTime;
}

export interface Clarification {
  id: EntityId;
  eventId: EntityId;
  fieldPath?: string;
  question: string;
  reason: string;
  priority: "normal" | "important" | "rights_related";
  status: "open" | "answered" | "dismissed";
  answerSourceRef?: EntityId;
  sourceRefs: EntityId[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EventDetail {
  event: Event;
  people: Person[];
  clarifications: Clarification[];
  assets: Asset[];
}

export interface EventSearchQuery {
  text?: string;
  status?: Event["status"];
  personId?: EntityId;
  from?: string;
  to?: string;
  limit?: number;
}

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: EntityId;
  type: string;
  payload: unknown;
  state: JobState;
  progress?: number;
  attempts: number;
  maxAttempts: number;
  availableAt: IsoDateTime;
  leaseUntil?: IsoDateTime;
  lastError?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
