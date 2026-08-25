import type {
  Asset, DerivedArtifact, LocalProcessorStatus, MediaArtifactPayloadV1, MediaProcessingSettings,
  MediaProcessorKind, OcrArtifactV1, Reminder, ReminderKind, ReviewAutomationSettings, SearchDocument,
  TranscriptArtifactV1
} from "@grudge-vault/domain";

export interface ImportFolderEntry {
  id: string;
  archiveSha256: string;
  assetId: string;
  importRunId: string;
  fileName: string;
  createdAt: string;
}

export interface AutomationRun {
  scheduleKey: string;
  kind: ReminderKind;
  reviewId?: string;
  from?: string;
  to?: string;
  createdAt: string;
}

export interface PhaseSixRepositoryPort {
  findDerivedArtifact(sourceAssetId: string, kind: MediaProcessorKind, inputHash: string): DerivedArtifact | undefined;
  getDerivedArtifact(id: string): DerivedArtifact | undefined;
  getCurrentDerivedArtifact(sourceAssetId: string, kind: MediaProcessorKind): DerivedArtifact | undefined;
  activateDerivedArtifact(artifact: DerivedArtifact, document: SearchDocument, now: string): DerivedArtifact;
  hasImportFolderArchive(archiveSha256: string): boolean;
  saveImportFolderEntry(entry: ImportFolderEntry): ImportFolderEntry;
  countImportFolderEntries(): { imported: number; failed: number };
  getAutomationRun(scheduleKey: string): AutomationRun | undefined;
  saveAutomationRun(run: AutomationRun): AutomationRun;
  listReminders(): Reminder[];
  getReminder(id: string): Reminder | undefined;
  saveReminder(reminder: Reminder): Reminder;
  updateReminderStatus(id: string, status: Reminder["status"], now: string): Reminder;
}

export interface MediaPipelineProcessResult {
  kind: MediaProcessorKind;
  payload: MediaArtifactPayloadV1;
  processorIdentity: string;
  processorVersion: number;
  configHash: string;
  inputHash: string;
}

export interface MediaPipelineFingerprint {
  kind: MediaProcessorKind;
  processorIdentity: string;
  processorVersion: number;
  configHash: string;
  inputHash: string;
}

export interface OcrAdapterPort {
  readonly identity: string;
  readonly version: number;
  probe(): Promise<LocalProcessorStatus["ocr"]>;
  fingerprint(asset: Asset, settings: MediaProcessingSettings): Promise<MediaPipelineFingerprint>;
  process(input: {
    asset: Asset;
    inputPath: string;
    temporaryDirectory: string;
    settings: MediaProcessingSettings;
    signal: AbortSignal;
    reportProgress(progress: number): void;
  }): Promise<MediaPipelineProcessResult & { kind: "ocr"; payload: OcrArtifactV1 }>;
}

export interface AsrAdapterPort {
  readonly identity: string;
  readonly version: number;
  probe(): Promise<LocalProcessorStatus["asr"]>;
  fingerprint(asset: Asset, settings: MediaProcessingSettings): Promise<MediaPipelineFingerprint>;
  process(input: {
    asset: Asset;
    inputPath: string;
    temporaryDirectory: string;
    settings: MediaProcessingSettings;
    signal: AbortSignal;
    reportProgress(progress: number): void;
  }): Promise<MediaPipelineProcessResult & { kind: "transcript"; payload: TranscriptArtifactV1 }>;
}

export interface MediaPipelinePort {
  getSettings(): MediaProcessingSettings;
  updateSettings(settings: MediaProcessingSettings): Promise<LocalProcessorStatus>;
  getStatus(): Promise<LocalProcessorStatus>;
  probe(): Promise<LocalProcessorStatus>;
  kindFor(asset: Asset): MediaProcessorKind | undefined;
  fingerprint(asset: Asset): Promise<MediaPipelineFingerprint>;
  process(input: {
    asset: Asset;
    inputPath: string;
    temporaryDirectory: string;
    signal: AbortSignal;
    reportProgress(progress: number): void;
  }): Promise<MediaPipelineProcessResult>;
}

export const DEFAULT_MEDIA_PROCESSING_SETTINGS: MediaProcessingSettings = {
  autoProcessNew: true,
  ocrLanguages: ["eng"],
  resourceProfile: "balanced",
  whisperGpu: "auto"
};

export const DEFAULT_REVIEW_AUTOMATION_SETTINGS: ReviewAutomationSettings = {
  monthly: true,
  quarterly: true,
  clarificationWeekly: true,
  systemNotifications: false
};

function date(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function latestCompletedMonth(now: Date): { key: string; from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return { key: `review:month:${key}`, from: date(start), to: date(end) };
}

export function latestCompletedQuarter(now: Date): { key: string; from: string; to: string } {
  const currentQuarter = Math.floor(now.getMonth() / 3);
  const start = new Date(now.getFullYear(), currentQuarter * 3 - 3, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  const quarter = Math.floor(start.getMonth() / 3) + 1;
  return { key: `review:quarter:${start.getFullYear()}-Q${quarter}`, from: date(start), to: date(end) };
}

export function isoWeekScheduleKey(now: Date): string {
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = local.getDay() || 7;
  local.setDate(local.getDate() + 4 - day);
  const yearStart = new Date(local.getFullYear(), 0, 1);
  const week = Math.ceil((((local.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `clarifications:week:${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}
