import type { Readable } from "node:stream";
import type {
  BackfillRun,
  CandidateDetail,
  CandidateExtraction,
  CandidateSummary,
  Event,
  ImportIssue,
  ImportRun,
  ImportRunDetail,
  JournalEntry,
  JournalLocation,
  SourceVersion
} from "@grudge-vault/domain";
import type { CandidateMergeInput, CandidateMergeResult, StartBackfillInput } from "@grudge-vault/shared";
import type { EventRevision } from "@grudge-vault/domain";

export type DayOneMediaKind = "photo" | "video" | "audio" | "pdf";

export interface DayOneMediaReference {
  kind: DayOneMediaKind;
  identifier?: string;
  fileName?: string;
  type?: string;
}

export interface NormalizedDayOneEntry {
  externalId: string;
  entryUuid?: string;
  fingerprint: string;
  creationDate: string;
  journalDate: string;
  modifiedDate?: string;
  timeZone?: string;
  text: string;
  tags: string[];
  location?: JournalLocation;
  media: DayOneMediaReference[];
  contentHash: string;
  raw: unknown;
}

export interface NormalizedDayOneMedia {
  kind: DayOneMediaKind;
  archivePath: string;
  fileName: string;
  referencedByExternalIds: string[];
  byteSize: number;
  stream: Readable;
}

export interface DayOneImportLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_DAYONE_IMPORT_LIMITS: DayOneImportLimits = {
  maxArchiveBytes: 20 * 1024 ** 3,
  maxEntries: 100_000,
  maxEntryBytes: 20 * 1024 ** 3,
  maxUncompressedBytes: 100 * 1024 ** 3,
  maxCompressionRatio: 200
};

export interface DayOneImportConsumer {
  onEntry(entry: NormalizedDayOneEntry): Promise<void>;
  onMedia(media: NormalizedDayOneMedia): Promise<void>;
  onIssue(issue: Omit<ImportIssue, "id" | "importRunId" | "createdAt">): Promise<void>;
  onProgress(progress: number): void;
}

export interface DayOneImportReport {
  totalEntries: number;
  mediaEntries: number;
  missingMedia: number;
}

export interface DayOneImporterPort {
  importArchive(
    archivePath: string,
    consumer: DayOneImportConsumer,
    signal: AbortSignal,
    limits?: DayOneImportLimits
  ): Promise<DayOneImportReport>;
}

export interface DayOneEntryUpsertResult {
  outcome: "new" | "updated" | "skipped";
  journalEntry: JournalEntry;
  sourceVersion: SourceVersion;
}

export interface DayOneRepositoryPort {
  createImportRun(run: ImportRun): ImportRun;
  listImportRuns(): ImportRun[];
  getImportRun(id: string): ImportRun | undefined;
  getImportRunDetail(id: string): ImportRunDetail | undefined;
  startImportRun(id: string, now: string): ImportRun;
  updateImportRun(run: ImportRun): ImportRun;
  addImportIssue(issue: ImportIssue): ImportIssue;
  upsertEntry(importRunId: string, entry: NormalizedDayOneEntry, now: string): DayOneEntryUpsertResult;
  linkMedia(importRunId: string, externalIds: string[], assetId: string, archivePath: string, now: string): void;

  createBackfillRun(run: BackfillRun): BackfillRun;
  listBackfillRuns(): BackfillRun[];
  getBackfillRun(id: string): BackfillRun | undefined;
  updateBackfillRun(run: BackfillRun): BackfillRun;
  listBackfillSourceVersions(run: BackfillRun): Array<{ journalEntry: JournalEntry; sourceVersion: SourceVersion; assetRefs: string[] }>;
  findExtraction(sourceVersionId: string, detectorIdentity: string, detectorVersion: number, ordinal: number): CandidateExtraction | undefined;
  listCandidates(memoryGetEvent: (id: string) => Event | undefined): CandidateSummary[];
  getCandidate(eventId: string, memoryGetDetail: (id: string) => CandidateDetail["detail"] | undefined): CandidateDetail | undefined;
  commitCandidate(event: Event, extraction: CandidateExtraction, clarification: import("@grudge-vault/domain").Clarification | undefined): Event;
  commitCandidateReview(event: Event, revision: EventRevision, state: "confirmed" | "ignored"): Event;
  setCandidateReview(eventId: string, state: CandidateExtraction["reviewState"], now: string, mergedIntoEventId?: string): void;
  mergeCandidate(input: CandidateMergeInput, now: string): CandidateMergeResult;
}

export interface PhaseTwoApplicationPort {
  listImportRuns(): ImportRun[];
  getImportRun(id: string): ImportRunDetail;
  listBackfillRuns(): BackfillRun[];
  startBackfill(input: StartBackfillInput): BackfillRun;
  pauseBackfill(id: string): BackfillRun;
  resumeBackfill(id: string): BackfillRun;
  cancelBackfill(id: string): BackfillRun;
  listCandidates(): CandidateSummary[];
  getCandidate(eventId: string): CandidateDetail;
}
