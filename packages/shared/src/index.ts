import type {
  Asset,
  AgentAction,
  AgentDataCategory,
  AgentExecutionMode,
  AgentModelSettings,
  AgentRun,
  BackfillRun,
  Case,
  CaseBinderExportResult,
  CaseBinderPreview,
  CaseBinderProfile,
  CaseDetail,
  CaseRevision,
  CandidateDetail,
  CandidateSummary,
  Clarification,
  Conversation,
  Emotion,
  Event,
  EventDetail,
  EventParticipant,
  EventRevision,
  EventRelation,
  EventRelationKind,
  EventSearchQuery,
  EmbeddingIndexStatus,
  EvidenceDetail,
  EvidenceReferenceImpact,
  Interest,
  Job,
  ImportRun,
  ImportRunDetail,
  IntegrityScan,
  Message,
  Person,
  PersonAlias,
  PersonIdentityDetail,
  PersonMergeRecord,
  PersonMergeSuggestion,
  ReviewRun,
  SourceReferenceDetail,
  Statement,
  TemporalValue,
  TimelineQuery,
  TimelineResult,
  UnifiedSearchHit,
  UnifiedSearchQuery,
  Workspace,
  WorkspaceCryptoStatus,
  WorkspaceLockState,
  WorkspaceSecuritySettings,
  RecoveryPackageSummary,
  LegalVerificationResult
} from "@grudge-vault/domain";

export const APP_ERROR_CODES = [
  "NO_ACTIVE_WORKSPACE",
  "WORKSPACE_INVALID",
  "WORKSPACE_EXISTS",
  "WORKSPACE_KEY_UNAVAILABLE",
  "WORKSPACE_LOCKED",
  "RECOVERY_PACKAGE_INVALID",
  "CRYPTO_MIGRATION_CONFLICT",
  "INSECURE_KEY_BACKEND",
  "FILE_NOT_REGULAR",
  "ASSET_IMPORT_FAILED",
  "ASSET_NOT_FOUND",
  "ASSET_CORRUPT",
  "ASSET_PREVIEW_UNAVAILABLE",
  "ASSET_EXPORT_FAILED",
  "EVIDENCE_UNAVAILABLE",
  "ENTITY_NOT_FOUND",
  "EVENT_REVISION_CONFLICT",
  "CASE_REVISION_CONFLICT",
  "BINDER_PREVIEW_STALE",
  "BINDER_EXPORT_FAILED",
  "LEGAL_VERIFICATION_UNAVAILABLE",
  "BACKUP_INVALID",
  "BACKUP_EXISTS",
  "IMPORT_INVALID_ARCHIVE",
  "IMPORT_LIMIT_EXCEEDED",
  "IMPORT_RUN_STATE_CONFLICT",
  "BACKFILL_STATE_CONFLICT",
  "CANDIDATE_STATE_CONFLICT",
  "PERSON_MERGE_CONFLICT",
  "RELATION_STATE_CONFLICT",
  "EMBEDDING_UNAVAILABLE",
  "AGENT_CONSENT_REQUIRED",
  "AGENT_RUN_STATE_CONFLICT",
  "AGENT_ACTION_CONFLICT",
  "AGENT_MODEL_CONFIGURATION_INVALID",
  "AGENT_MODEL_UNAVAILABLE",
  "AGENT_TOOL_FAILED",
  "JOB_NOT_RETRYABLE",
  "VALIDATION_FAILED",
  "INTERNAL_ERROR"
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface SerializedAppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, message: string, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedAppError };

export interface AssetImportResult {
  asset: Asset;
  deduplicated: boolean;
}

export interface EventWriteFields {
  title: string;
  status: Event["status"];
  occurredAt: TemporalValue;
  narrative?: string;
  facts: Statement[];
  interpretations: Statement[];
  emotions: Emotion[];
  interests: Interest[];
  participants: EventParticipant[];
  sourceRefs: string[];
  assetRefs: string[];
}

export interface CreateEventInput extends EventWriteFields {
  reason: string;
}

export interface UpdateEventInput extends EventWriteFields {
  eventId: string;
  expectedRevision: number;
  reason: string;
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  createDraft: boolean;
}

export interface SendMessageResult {
  message: Message;
  draft?: Event;
  draftError?: SerializedAppError;
}

export interface ClarificationAnswerInput {
  clarificationId: string;
  answer: string;
  expectedRevision: number;
}

export interface AssetPreview {
  assetId: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface BackupSummary {
  path: string;
  workspaceId: string;
  createdAt: string;
  fileCount: number;
  byteSize: number;
}

export interface StartBackfillInput {
  importRunId?: string;
  from?: string;
  to?: string;
  tags: string[];
  batchSize?: number;
}

export interface CandidateMergeInput {
  candidateEventId: string;
  candidateExpectedRevision: number;
  targetEventId: string;
  targetExpectedRevision: number;
}

export interface CandidateMergeResult {
  candidate: Event;
  target: Event;
}

export interface PersonAliasInput {
  personId: string;
  value: string;
  sourceRefs?: string[];
}

export interface PersonMergeInput {
  sourcePersonId: string;
  targetPersonId: string;
  suggestionId?: string;
}

export interface CreateRelationInput {
  sourceEventId: string;
  targetEventId: string;
  kind: EventRelationKind;
}

export interface ReviewGenerateInput {
  from: string;
  to: string;
}

export interface AgentSendInput {
  conversationId: string;
  content: string;
}

export interface AgentSendResult {
  run: AgentRun;
  userMessage: Message;
  assistantMessage?: Message;
}

export interface AgentEndpointInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearCredential?: boolean;
}

export interface AgentSettingsUpdateInput {
  mode: AgentExecutionMode;
  privateEndpoint?: AgentEndpointInput;
  enhancedEndpoint?: AgentEndpointInput;
  consentedDataCategories?: AgentDataCategory[];
}

export type CaseWriteFields = Omit<Case, "id" | "currentRevision" | "createdAt" | "updatedAt">;

export interface CreateCaseInput extends CaseWriteFields {
  reason: string;
}

export interface UpdateCaseInput extends CaseWriteFields {
  caseId: string;
  expectedRevision: number;
  reason: string;
}

export interface SupersedeAssetInput {
  oldAssetId: string;
  newAssetId: string;
}

export interface DeleteAssetInput {
  assetId: string;
  confirmReferencedDeletion: boolean;
}

export interface RecoveryExportInput {
  passphrase: string;
}

export interface RecoveryImportInput {
  passphrase: string;
}

export interface GrudgeVaultApi {
  workspace: {
    current(): Promise<IpcResult<Workspace | null>>;
    status(): Promise<IpcResult<WorkspaceLockState>>;
    create(name: string): Promise<IpcResult<Workspace | null>>;
    open(): Promise<IpcResult<Workspace | null>>;
    lock(): Promise<IpcResult<WorkspaceLockState>>;
    unlock(): Promise<IpcResult<Workspace | null>>;
    getSecuritySettings(): Promise<IpcResult<WorkspaceSecuritySettings>>;
    updateSecuritySettings(settings: WorkspaceSecuritySettings): Promise<IpcResult<WorkspaceSecuritySettings>>;
    exportRecovery(input: RecoveryExportInput): Promise<IpcResult<RecoveryPackageSummary | null>>;
    recover(input: RecoveryImportInput): Promise<IpcResult<Workspace | null>>;
    rotateKey(): Promise<IpcResult<WorkspaceCryptoStatus>>;
    cryptoStatus(): Promise<IpcResult<WorkspaceCryptoStatus>>;
    onLocked(callback: () => void): () => void;
  };
  conversations: {
    list(): Promise<IpcResult<Conversation[]>>;
    create(title: string): Promise<IpcResult<Conversation>>;
    rename(id: string, title: string): Promise<IpcResult<Conversation>>;
    delete(id: string): Promise<IpcResult<Conversation>>;
    listMessages(id: string): Promise<IpcResult<Message[]>>;
    send(input: SendMessageInput): Promise<IpcResult<SendMessageResult>>;
  };
  agent: {
    send(input: AgentSendInput): Promise<IpcResult<AgentSendResult>>;
    resume(runId: string, disclosureId: string): Promise<IpcResult<AgentSendResult>>;
    cancel(runId: string): Promise<IpcResult<AgentRun>>;
    listRuns(conversationId: string): Promise<IpcResult<AgentRun[]>>;
    getRun(runId: string): Promise<IpcResult<AgentRun>>;
    approveAction(actionId: string): Promise<IpcResult<AgentAction>>;
    rejectAction(actionId: string): Promise<IpcResult<AgentAction>>;
    getSettings(): Promise<IpcResult<AgentModelSettings>>;
    updateSettings(input: AgentSettingsUpdateInput): Promise<IpcResult<AgentModelSettings>>;
    clearCredential(mode: AgentExecutionMode): Promise<IpcResult<AgentModelSettings>>;
  };
  events: {
    search(query: EventSearchQuery): Promise<IpcResult<Event[]>>;
    get(id: string): Promise<IpcResult<EventDetail>>;
    create(input: CreateEventInput): Promise<IpcResult<Event>>;
    update(input: UpdateEventInput): Promise<IpcResult<Event>>;
    confirm(id: string, expectedRevision: number): Promise<IpcResult<Event>>;
    archive(id: string, expectedRevision: number): Promise<IpcResult<Event>>;
    listRevisions(id: string): Promise<IpcResult<EventRevision[]>>;
  };
  people: {
    list(includeArchived?: boolean): Promise<IpcResult<Person[]>>;
    listIdentities(): Promise<IpcResult<PersonIdentityDetail[]>>;
    create(displayName: string, notes?: string): Promise<IpcResult<Person>>;
    update(person: Pick<Person, "id" | "displayName" | "notes">): Promise<IpcResult<Person>>;
    archive(id: string): Promise<IpcResult<Person>>;
    get(id: string): Promise<IpcResult<PersonIdentityDetail>>;
    addAlias(input: PersonAliasInput): Promise<IpcResult<PersonAlias>>;
    deactivateAlias(id: string): Promise<IpcResult<PersonAlias>>;
    listMergeSuggestions(): Promise<IpcResult<PersonMergeSuggestion[]>>;
    rejectMergeSuggestion(id: string): Promise<IpcResult<PersonMergeSuggestion>>;
    merge(input: PersonMergeInput): Promise<IpcResult<PersonMergeRecord>>;
    revertMerge(id: string): Promise<IpcResult<PersonMergeRecord>>;
  };
  relations: {
    listForEvent(eventId: string): Promise<IpcResult<EventRelation[]>>;
    refreshSuggestions(): Promise<IpcResult<EventRelation[]>>;
    create(input: CreateRelationInput): Promise<IpcResult<EventRelation>>;
    confirm(id: string): Promise<IpcResult<EventRelation>>;
    reject(id: string): Promise<IpcResult<EventRelation>>;
    remove(id: string): Promise<IpcResult<void>>;
  };
  timeline: {
    query(input: TimelineQuery): Promise<IpcResult<TimelineResult>>;
  };
  search: {
    query(input: UnifiedSearchQuery): Promise<IpcResult<UnifiedSearchHit[]>>;
    getEmbeddingStatus(): Promise<IpcResult<EmbeddingIndexStatus>>;
    setSemanticEnabled(enabled: boolean): Promise<IpcResult<EmbeddingIndexStatus>>;
    rebuildEmbeddings(): Promise<IpcResult<Job>>;
  };
  reviews: {
    list(): Promise<IpcResult<ReviewRun[]>>;
    get(id: string): Promise<IpcResult<ReviewRun>>;
    generate(input: ReviewGenerateInput): Promise<IpcResult<ReviewRun>>;
  };
  sources: {
    getReference(sourceItemId: string): Promise<IpcResult<SourceReferenceDetail>>;
  };
  clarifications: {
    list(eventId?: string): Promise<IpcResult<Clarification[]>>;
    answer(input: ClarificationAnswerInput): Promise<IpcResult<Event>>;
    dismiss(id: string, expectedRevision: number): Promise<IpcResult<Event>>;
    setPriority(id: string, priority: Clarification["priority"]): Promise<IpcResult<Clarification>>;
  };
  assets: {
    importDropped(files: File[]): Promise<IpcResult<AssetImportResult[]>>;
    chooseAndImport(): Promise<IpcResult<AssetImportResult[]>>;
    importForEvent(files: File[], eventId: string, expectedRevision: number): Promise<IpcResult<Event>>;
    chooseAndImportForEvent(eventId: string, expectedRevision: number): Promise<IpcResult<Event | null>>;
    list(): Promise<IpcResult<Asset[]>>;
    verify(assetId: string): Promise<IpcResult<Job>>;
    preview(assetId: string): Promise<IpcResult<AssetPreview>>;
    exportCopy(assetId: string): Promise<IpcResult<string | null>>;
  };
  evidence: {
    list(): Promise<IpcResult<EvidenceDetail[]>>;
    get(assetId: string): Promise<IpcResult<EvidenceDetail>>;
    startScan(): Promise<IpcResult<IntegrityScan>>;
    listScans(): Promise<IpcResult<IntegrityScan[]>>;
    deleteImpact(assetId: string): Promise<IpcResult<EvidenceReferenceImpact>>;
    deleteOriginal(input: DeleteAssetInput): Promise<IpcResult<EvidenceDetail>>;
    supersede(input: SupersedeAssetInput): Promise<IpcResult<EvidenceDetail>>;
  };
  cases: {
    list(): Promise<IpcResult<Case[]>>;
    get(id: string): Promise<IpcResult<CaseDetail>>;
    create(input: CreateCaseInput): Promise<IpcResult<Case>>;
    update(input: UpdateCaseInput): Promise<IpcResult<Case>>;
    archive(id: string, expectedRevision: number): Promise<IpcResult<Case>>;
    listRevisions(id: string): Promise<IpcResult<CaseRevision[]>>;
    runLegalCheck(id: string): Promise<IpcResult<LegalVerificationResult>>;
    previewBinder(id: string, profile: CaseBinderProfile): Promise<IpcResult<CaseBinderPreview>>;
    exportBinder(previewId: string): Promise<IpcResult<CaseBinderExportResult | null>>;
  };
  imports: {
    chooseDayOneZip(): Promise<IpcResult<ImportRun | null>>;
    list(): Promise<IpcResult<ImportRun[]>>;
    get(id: string): Promise<IpcResult<ImportRunDetail>>;
  };
  backfill: {
    list(): Promise<IpcResult<BackfillRun[]>>;
    start(input: StartBackfillInput): Promise<IpcResult<BackfillRun>>;
    pause(id: string): Promise<IpcResult<BackfillRun>>;
    resume(id: string): Promise<IpcResult<BackfillRun>>;
    cancel(id: string): Promise<IpcResult<BackfillRun>>;
  };
  candidates: {
    list(): Promise<IpcResult<CandidateSummary[]>>;
    get(eventId: string): Promise<IpcResult<CandidateDetail>>;
    confirm(eventId: string, expectedRevision: number): Promise<IpcResult<Event>>;
    ignore(eventId: string, expectedRevision: number): Promise<IpcResult<Event>>;
    merge(input: CandidateMergeInput): Promise<IpcResult<CandidateMergeResult>>;
  };
  backups: {
    createSnapshot(): Promise<IpcResult<BackupSummary | null>>;
    restoreSnapshot(): Promise<IpcResult<Workspace | null>>;
  };
  jobs: {
    list(): Promise<IpcResult<Job[]>>;
    retry(jobId: string): Promise<IpcResult<Job>>;
    onChanged(callback: () => void): () => void;
  };
}

export function toSerializedError(error: unknown): SerializedAppError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL_ERROR", message: "An unexpected local error occurred.", retryable: false };
}
