import type {
  Asset,
  NativeMediaProgress,
  AgentAction,
  AgentDataCategory,
  AgentExecutionMode,
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
  DerivedArtifactDetail,
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
  LlmModelOption,
  LlmProvider,
  LlmSettings,
  BailianRegion,
  ImportFolderStatus,
  IntegrityScan,
  Message,
  LocalProcessorStatus,
  MediaProcessingSettings,
  Person,
  PersonAlias,
  PersonIdentityDetail,
  PersonMergeRecord,
  PersonMergeSuggestion,
  ReviewRun,
  Reminder,
  ReviewAutomationSettings,
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
  , PreparedIntake, ScreenAndSaveResult, ScreenedZipImportSummary, ScreenedZipImportProgress, ScreenedZipImportReceipt, LegacyMigrationSummary, PendingReview, TimelineFilter, TimelinePage,
  EventRecordDetail, FieldOverride, PreparedSearchQuery, RecordSearchIndexStatus, RecordSearchQuery, RecordSearchPage
} from "@grudge-vault/domain";

export { codePointLength, RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT } from "./text-limits";
export { findCaseInsensitiveTextRange } from "./text-anchors";
export { reportContentSearchText } from "./report-search-text";
export { calendarDateDay, projectRecordDate, recordDateMatches, recordTimeZone, resolveRecordDateFilter } from "./record-dates";
export type { RecordDateFilter, RecordDateProjection } from "./record-dates";
export { projectRecordOccurrence } from "./record-occurrence";
export type { RecordOccurrenceProjection } from "./record-occurrence";

export const APP_ERROR_CODES = [
  "WORKSPACE_PASSWORD_REQUIRED", "WORKSPACE_PASSWORD_INCORRECT", "WORKSPACE_PASSWORD_THROTTLED",
  "NO_ACTIVE_WORKSPACE",
  "WORKSPACE_INVALID",
  "WORKSPACE_EXISTS",
  "WORKSPACE_KEY_UNAVAILABLE",
  "WORKSPACE_LOCKED",
  "WORKSPACE_MIGRATION_REQUIRED",
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
  "IMPORT_CANCELLED",
  "IMPORT_RUN_STATE_CONFLICT",
  "BACKFILL_STATE_CONFLICT",
  "CANDIDATE_STATE_CONFLICT",
  "PERSON_MERGE_CONFLICT",
  "RELATION_STATE_CONFLICT",
  "EMBEDDING_UNAVAILABLE",
  "LOCAL_PROCESSOR_UNAVAILABLE",
  "MEDIA_PROCESSING_FAILED",
  "IMPORT_FOLDER_UNAVAILABLE",
  "REMINDER_NOT_FOUND",
  "AGENT_CONSENT_REQUIRED",
  "AGENT_RUN_STATE_CONFLICT",
  "AGENT_ACTION_CONFLICT",
  "AGENT_MODEL_CONFIGURATION_INVALID",
  "AGENT_MODEL_UNAVAILABLE",
  "LLM_AUTHENTICATION_FAILED",
  "LLM_MODEL_NOT_FOUND",
  "LLM_TOOL_UNSUPPORTED",
  "LLM_RATE_LIMITED",
  "LLM_REGION_MISMATCH",
  "LLM_CONFIGURATION_CHANGED",
  "MODEL_NOT_CONFIGURED",
  "MODALITY_UNAVAILABLE",
  "SOURCE_UNAVAILABLE",
  "SOURCE_VERSION_CHANGED",
  "INVALID_INPUT",
  "SCREENING_FAILED",
  "WRITE_FAILED",
  "REVISION_CONFLICT",
  "CLEANUP_FAILED",
  "AGENT_TOOL_FAILED",
  "JOB_NOT_RETRYABLE",
  "JOB_STATE_CONFLICT",
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
  intent: "record" | "source";
}

export interface SendMessageResult {
  message: Message;
  event?: Event;
  eventError?: SerializedAppError;
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
  representation?: "converted-image";
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

export interface LlmConnectInput {
  provider: LlmProvider;
  model: string;
  region?: BailianRegion;
  workspaceId?: string;
  apiKey?: string;
}

export interface LlmListModelsInput {
  provider: LlmProvider;
  region?: BailianRegion;
  workspaceId?: string;
  apiKey?: string;
  /** Return built-in candidates without reading credentials or contacting a provider. */
  recommendationsOnly?: boolean;
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

export interface WorkspaceUnlockInput { password?: string | undefined; newPassword?: string | undefined; }
export interface WorkspacePasswordInput { currentPassword?: string | undefined; newPassword: string; }

export interface PrepareIntakeInput {
  requestId: string;
  text: string;
  files: File[];
}

export interface AssetMediaPreview {
  requestId: string;
  assetId: string;
  url: string;
  mimeType: string;
  byteSize: number;
}

export interface PatchRecordFieldsInput {
  recordId: string;
  expectedRevision: number;
  patch: Partial<Record<FieldOverride["fieldKey"], unknown>>;
}

export type LocalProcessorPathKind = "tesseract" | "poppler" | "ffmpeg" | "whisper" | "whisper_model";

export interface GrudgeVaultApi {
  external: {
    open(url: string): Promise<IpcResult<boolean>>;
  };
  workspace: {
    current(): Promise<IpcResult<Workspace | null>>;
    status(): Promise<IpcResult<WorkspaceLockState>>;
    create(name: string): Promise<IpcResult<Workspace | null>>;
    open(): Promise<IpcResult<Workspace | null>>;
    lock(): Promise<IpcResult<WorkspaceLockState>>;
    unlock(input?: WorkspaceUnlockInput): Promise<IpcResult<Workspace | null>>;
    passwordStatus(): Promise<IpcResult<{ configured: boolean }>>;
    setPassword(input: WorkspacePasswordInput): Promise<IpcResult<{ configured: boolean }>>;
    getSecuritySettings(): Promise<IpcResult<WorkspaceSecuritySettings>>;
    updateSecuritySettings(settings: WorkspaceSecuritySettings): Promise<IpcResult<WorkspaceSecuritySettings>>;
    exportRecovery(input: RecoveryExportInput): Promise<IpcResult<RecoveryPackageSummary | null>>;
    recover(input: RecoveryImportInput): Promise<IpcResult<Workspace | null>>;
    rotateKey(): Promise<IpcResult<WorkspaceCryptoStatus>>;
    cryptoStatus(): Promise<IpcResult<WorkspaceCryptoStatus>>;
    reveal(): Promise<IpcResult<boolean>>;
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
  };
  llm: {
    getSettings(): Promise<IpcResult<LlmSettings>>;
    listModels(input: LlmListModelsInput): Promise<IpcResult<LlmModelOption[]>>;
    save(input: LlmConnectInput): Promise<IpcResult<LlmSettings>>;
    connect(input: LlmConnectInput): Promise<IpcResult<LlmSettings>>;
    activate(provider: LlmProvider): Promise<IpcResult<LlmSettings>>;
    pause(): Promise<IpcResult<LlmSettings>>;
    disconnect(provider: LlmProvider): Promise<IpcResult<LlmSettings>>;
  };
  intake: {
    onMediaProgress(callback: (value: NativeMediaProgress & { sessionId: string }) => void): () => void;
    prepare(input: PrepareIntakeInput): Promise<IpcResult<PreparedIntake>>;
    abandonPreparation(requestId: string): Promise<IpcResult<void>>;
    abandon(sessionId: string): Promise<IpcResult<void>>;
    screenAndSave(sessionId: string, operationId: string): Promise<IpcResult<ScreenAndSaveResult>>;
    chooseDayOneZip(): Promise<IpcResult<ScreenedZipImportSummary | null>>;
    dayOneImportProgress(): Promise<IpcResult<ScreenedZipImportProgress | null>>;
    lastDayOneImportReceipt(): Promise<IpcResult<ScreenedZipImportReceipt | null>>;
    pauseDayOneZip(operationId: string): Promise<IpcResult<boolean>>;
    resumeDayOneZip(operationId: string): Promise<IpcResult<boolean>>;
    cancelDayOneZip(): Promise<IpcResult<boolean>>;
    chooseLegacyWorkspace(): Promise<IpcResult<LegacyMigrationSummary | null>>;
    cancelLegacyWorkspace(): Promise<IpcResult<boolean>>;
  };
  records: {
    onSearchMediaProgress(callback: (value: NativeMediaProgress & { sessionId: string }) => void): () => void;
    timeline(filter: TimelineFilter): Promise<IpcResult<TimelinePage>>;
    get(id: string): Promise<IpcResult<EventRecordDetail>>;
    patchFields(input: PatchRecordFieldsInput): Promise<IpcResult<EventRecordDetail>>;
    reanalyze(id: string, expectedRevision: number): Promise<IpcResult<string>>;
    search(query: RecordSearchQuery): Promise<IpcResult<RecordSearchPage>>;
    prepareSearch(input: { requestId: string; text: string; files: File[] }): Promise<IpcResult<PreparedSearchQuery>>;
    abandonSearchPreparation(requestId: string): Promise<IpcResult<void>>;
    executeSearch(sessionId: string, filters: Omit<RecordSearchQuery, "text">): Promise<IpcResult<RecordSearchPage>>;
    abandonSearch(sessionId: string): Promise<IpcResult<void>>;
    searchIndexStatus(): Promise<IpcResult<RecordSearchIndexStatus>>;
    rebuildSearchIndex(): Promise<IpcResult<RecordSearchIndexStatus>>;
    setSearchIndexEnabled(enabled: boolean): Promise<IpcResult<RecordSearchIndexStatus>>;
  };
  pending: {
    list(): Promise<IpcResult<PendingReview[]>>;
    resolve(id: string, action: "keep" | "ignore", operationId: string): Promise<IpcResult<ScreenAndSaveResult | null>>;
    rescreenManual(id: string, sessionId: string): Promise<IpcResult<ScreenAndSaveResult>>;
    chooseDayOneZip(id: string, operationId: string): Promise<IpcResult<ScreenAndSaveResult | null>>;
    chooseLegacyWorkspace(id: string, operationId: string): Promise<IpcResult<ScreenAndSaveResult | null>>;
  };
  legal: {
    getDefaultJurisdiction(): Promise<IpcResult<string>>;
    setDefaultJurisdiction(jurisdiction: string): Promise<IpcResult<string>>;
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
  localIntelligence: {
    status(): Promise<IpcResult<LocalProcessorStatus>>;
    choosePath(kind: LocalProcessorPathKind): Promise<IpcResult<LocalProcessorStatus | null>>;
    updateSettings(settings: MediaProcessingSettings): Promise<IpcResult<LocalProcessorStatus>>;
    probe(): Promise<IpcResult<LocalProcessorStatus>>;
    processAsset(assetId: string): Promise<IpcResult<Job>>;
    processHistorical(): Promise<IpcResult<Job[]>>;
    getArtifact(artifactId: string): Promise<IpcResult<DerivedArtifactDetail>>;
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
    openMediaPreview(input: { requestId: string; assetId: string }): Promise<IpcResult<AssetMediaPreview>>;
    closeMediaPreview(requestId: string): Promise<IpcResult<boolean>>;
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
  importFolder: {
    status(): Promise<IpcResult<ImportFolderStatus>>;
    choose(): Promise<IpcResult<ImportFolderStatus | null>>;
    setEnabled(enabled: boolean): Promise<IpcResult<ImportFolderStatus>>;
    scanNow(): Promise<IpcResult<ImportFolderStatus>>;
  };
  reminders: {
    list(): Promise<IpcResult<Reminder[]>>;
    getSettings(): Promise<IpcResult<ReviewAutomationSettings>>;
    updateSettings(settings: ReviewAutomationSettings): Promise<IpcResult<ReviewAutomationSettings>>;
    requestSystemNotifications(locale: "zh-CN" | "en"): Promise<IpcResult<boolean>>;
    markRead(id: string): Promise<IpcResult<Reminder>>;
    dismiss(id: string): Promise<IpcResult<Reminder>>;
    onDue(callback: (reminderId: string, shouldOpen: boolean) => void): () => void;
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
    cancel(jobId: string): Promise<IpcResult<Job>>;
    onChanged(callback: () => void): () => void;
  };
}

export function toSerializedError(error: unknown): SerializedAppError {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "INTERNAL_ERROR", message: "An unexpected local error occurred.", retryable: false };
}
