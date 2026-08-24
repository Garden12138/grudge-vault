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

export interface PersonAlias {
  id: EntityId;
  personId: EntityId;
  value: string;
  normalizedValue: string;
  sourceRefs: EntityId[];
  status: "active" | "inactive";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PersonMergeSuggestion {
  id: EntityId;
  personAId: EntityId;
  personBId: EntityId;
  score: number;
  basis: string[];
  algorithmIdentity: string;
  algorithmVersion: number;
  status: "pending" | "confirmed" | "rejected";
  mergeRecordId?: EntityId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface PersonMergeRecord {
  id: EntityId;
  sourcePersonId: EntityId;
  targetPersonId: EntityId;
  suggestionId?: EntityId;
  status: "active" | "reverted";
  createdAt: IsoDateTime;
  revertedAt?: IsoDateTime;
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

export interface PersonIdentityDetail {
  canonicalPerson: Person;
  identities: Person[];
  aliases: PersonAlias[];
  events: Event[];
  activeMerges: PersonMergeRecord[];
}

export type EventRelationKind = "similar" | "precedes" | "same_topic" | "same_case";

export interface RelationBasis {
  kind: "person" | "topic" | "text" | "time" | "source";
  label: string;
  personIds: EntityId[];
  eventIds: EntityId[];
  sourceRefs: EntityId[];
}

export interface EventRelation {
  id: EntityId;
  sourceEventId: EntityId;
  targetEventId: EntityId;
  kind: EventRelationKind;
  status: "suggested" | "confirmed" | "rejected";
  origin: "algorithm" | "user";
  score?: number;
  basis: RelationBasis[];
  algorithmIdentity?: string;
  algorithmVersion?: number;
  sourceRevision: number;
  targetRevision: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TimelineQuery {
  personId?: EntityId;
  status?: Event["status"];
  from?: string;
  to?: string;
  includeArchived?: boolean;
}

export interface TimelineGroup {
  key: string;
  label: string;
  events: Event[];
}

export interface TimelineResult {
  query: TimelineQuery;
  groups: TimelineGroup[];
  total: number;
}

export type UnifiedSearchKind = "event" | "journal_entry" | "transcript";

export interface UnifiedSearchQuery {
  text: string;
  kinds?: UnifiedSearchKind[];
  personId?: EntityId;
  status?: Event["status"];
  from?: string;
  to?: string;
  semantic?: boolean;
  limit?: number;
}

export interface UnifiedSearchHit {
  kind: UnifiedSearchKind;
  id: EntityId;
  title: string;
  excerpt: string;
  occurredAt?: string;
  eventId?: EntityId;
  sourceItemId?: EntityId;
  sourceRefs: EntityId[];
  keywordScore?: number;
  semanticScore?: number;
  combinedScore: number;
}

export interface SearchDocument {
  kind: UnifiedSearchKind;
  id: EntityId;
  title: string;
  content: string;
  contentHash: string;
  occurredAt?: string;
  eventId?: EntityId;
  sourceItemId?: EntityId;
  sourceRefs: EntityId[];
}

export interface SourceReferenceDetail {
  sourceItemId: EntityId;
  kind: "journal_entry" | "message" | "manual" | "transcript";
  title: string;
  excerpt: string;
  recordedAt: IsoDateTime;
  sourceVersion?: number;
  contentHash?: string;
  conversationId?: EntityId;
  messageId?: EntityId;
  eventIds: EntityId[];
  assetIds: EntityId[];
}

export interface ReviewPattern {
  id: EntityId;
  kind: "person" | "topic" | "relation" | "time_cluster";
  title: string;
  summary: string;
  eventIds: EntityId[];
  eventRevisionRefs: Array<{ eventId: EntityId; revision: number }>;
  personIds: EntityId[];
  sourceRefs: EntityId[];
}

export interface ReviewRun {
  id: EntityId;
  from: string;
  to: string;
  generatorIdentity: string;
  generatorVersion: number;
  inputHash: string;
  patterns: ReviewPattern[];
  eventIds: EntityId[];
  sourceRefs: EntityId[];
  createdAt: IsoDateTime;
  stale: boolean;
}

export interface EmbeddingIndexStatus {
  available: boolean;
  enabled: boolean;
  adapterIdentity?: string;
  adapterVersion?: number;
  dimensions?: number;
  activeGenerationId?: EntityId;
  documentCount: number;
  state: "unavailable" | "disabled" | "empty" | "building" | "ready" | "failed";
  lastError?: string;
}

export interface EmbeddingGeneration {
  id: EntityId;
  adapterIdentity: string;
  adapterVersion: number;
  dimensions: number;
  state: "building" | "active" | "superseded" | "failed";
  documentCount: number;
  lastError?: string;
  createdAt: IsoDateTime;
  activatedAt?: IsoDateTime;
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
  personIds?: EntityId[];
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

export type AgentIntent = "record" | "retrieve" | "review" | "clarify" | "strategy";
export type AgentExecutionMode = "private" | "enhanced";
export type AgentDataCategory =
  | "conversation_text"
  | "event_fields"
  | "source_excerpt"
  | "asset_metadata"
  | "transcript_excerpt";

export interface AgentCitation {
  id: EntityId;
  kind: "event" | "source" | "asset" | "transcript";
  targetId: EntityId;
  label: string;
  excerpt?: string;
  available: boolean;
}

export interface GroundedAgentClaim {
  id: EntityId;
  text: string;
  citationIds: EntityId[];
  kind?: "fact.confirmed" | "fact.disputed" | "fact.unknown" | "interpretation.user" | "interpretation.agent" | "emotion";
}

export interface StrategyOption {
  id: EntityId;
  title: string;
  description: string;
  benefits: string[];
  costs: string[];
  risks: string[];
  unknowns: string[];
  reversible: boolean;
  citationIds: EntityId[];
}

export interface StrategyAnalysis {
  confirmedFacts: GroundedAgentClaim[];
  disputedOrUnknown: GroundedAgentClaim[];
  materials: GroundedAgentClaim[];
  interpretations: GroundedAgentClaim[];
  emotions: GroundedAgentClaim[];
  interests: GroundedAgentClaim[];
  historicalPatterns: GroundedAgentClaim[];
  risks: GroundedAgentClaim[];
  options: StrategyOption[];
  actionPlan: string[];
  suggestedQuestions: string[];
}

export interface ExternalContextDisclosure {
  id: EntityId;
  runId: EntityId;
  policyVersion: number;
  categories: AgentDataCategory[];
  categoryCounts: Partial<Record<AgentDataCategory, number>>;
  contextHash: string;
  required: boolean;
  acceptedAt?: IsoDateTime;
  rejectedAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

export interface AgentToolCall {
  id: EntityId;
  runId: EntityId;
  sequence: number;
  toolName: string;
  toolVersion: number;
  inputHash: string;
  inputRefs: EntityId[];
  outputRefs: EntityId[];
  status: "running" | "succeeded" | "failed" | "proposed";
  errorCode?: string;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
}

export interface AgentAction {
  id: EntityId;
  runId: EntityId;
  toolCallId: EntityId;
  toolName: string;
  toolVersion: number;
  summary: string;
  payload: unknown;
  expectedRevision?: number;
  status: "pending" | "approved" | "rejected" | "stale" | "failed";
  resultRefs: EntityId[];
  createdAt: IsoDateTime;
  resolvedAt?: IsoDateTime;
  errorCode?: string;
}

export interface AgentRun {
  id: EntityId;
  conversationId: EntityId;
  userMessageId: EntityId;
  assistantMessageId?: EntityId;
  intent: AgentIntent;
  mode: AgentExecutionMode;
  status: "awaiting_consent" | "running" | "succeeded" | "failed" | "cancelled";
  modelIdentity?: string;
  modelVersion?: number;
  toolSchemaVersion: number;
  contextHash: string;
  responseVersion: number;
  responseText?: string;
  analysis?: StrategyAnalysis;
  citations: AgentCitation[];
  toolCalls: AgentToolCall[];
  actions: AgentAction[];
  disclosure?: ExternalContextDisclosure;
  errorCode?: string;
  createdAt: IsoDateTime;
  completedAt?: IsoDateTime;
}

export interface AgentModelCallAudit {
  id: EntityId;
  runId: EntityId;
  sequence: number;
  endpointOrigin: string;
  model: string;
  categories: AgentDataCategory[];
  contextHash: string;
  status: "running" | "succeeded" | "failed";
  promptTokens?: number;
  completionTokens?: number;
  errorCode?: string;
  startedAt: IsoDateTime;
  finishedAt?: IsoDateTime;
}

export interface AgentEndpointSettings {
  baseUrl: string;
  model: string;
  credentialConfigured: boolean;
}

export interface AgentModelSettings {
  mode: AgentExecutionMode;
  privateEndpoint?: AgentEndpointSettings;
  enhancedEndpoint?: AgentEndpointSettings;
  consentPolicyVersion: number;
  consentedDataCategories: AgentDataCategory[];
}
