import type {
  Asset,
  BackfillRun,
  CandidateDetail,
  CandidateSummary,
  Clarification,
  Conversation,
  Emotion,
  Event,
  EventDetail,
  EventParticipant,
  EventRevision,
  EventSearchQuery,
  Interest,
  Job,
  ImportRun,
  ImportRunDetail,
  Message,
  Person,
  Statement,
  TemporalValue,
  Workspace
} from "@grudge-vault/domain";

export const APP_ERROR_CODES = [
  "NO_ACTIVE_WORKSPACE",
  "WORKSPACE_INVALID",
  "WORKSPACE_EXISTS",
  "WORKSPACE_KEY_UNAVAILABLE",
  "INSECURE_KEY_BACKEND",
  "FILE_NOT_REGULAR",
  "ASSET_IMPORT_FAILED",
  "ASSET_NOT_FOUND",
  "ASSET_CORRUPT",
  "ASSET_PREVIEW_UNAVAILABLE",
  "ASSET_EXPORT_FAILED",
  "ENTITY_NOT_FOUND",
  "EVENT_REVISION_CONFLICT",
  "BACKUP_INVALID",
  "BACKUP_EXISTS",
  "IMPORT_INVALID_ARCHIVE",
  "IMPORT_LIMIT_EXCEEDED",
  "IMPORT_RUN_STATE_CONFLICT",
  "BACKFILL_STATE_CONFLICT",
  "CANDIDATE_STATE_CONFLICT",
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

export interface GrudgeVaultApi {
  workspace: {
    current(): Promise<IpcResult<Workspace | null>>;
    create(name: string): Promise<IpcResult<Workspace | null>>;
    open(): Promise<IpcResult<Workspace | null>>;
  };
  conversations: {
    list(): Promise<IpcResult<Conversation[]>>;
    create(title: string): Promise<IpcResult<Conversation>>;
    rename(id: string, title: string): Promise<IpcResult<Conversation>>;
    delete(id: string): Promise<IpcResult<Conversation>>;
    listMessages(id: string): Promise<IpcResult<Message[]>>;
    send(input: SendMessageInput): Promise<IpcResult<SendMessageResult>>;
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
    create(displayName: string, notes?: string): Promise<IpcResult<Person>>;
    update(person: Pick<Person, "id" | "displayName" | "notes">): Promise<IpcResult<Person>>;
    archive(id: string): Promise<IpcResult<Person>>;
  };
  clarifications: {
    list(eventId?: string): Promise<IpcResult<Clarification[]>>;
    answer(input: ClarificationAnswerInput): Promise<IpcResult<Event>>;
    dismiss(id: string, expectedRevision: number): Promise<IpcResult<Event>>;
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
