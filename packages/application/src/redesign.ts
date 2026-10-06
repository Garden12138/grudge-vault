import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open as openFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { lookup as lookupMimeType } from "mime-types";
import { needsNativeImageConversion, prepareNativeImage } from "./native-image";
import { SearchVectorScorer } from "./search-vector-scoring";
import type {
  AnalysisReport,
  AnalysisReportContent,
  NativeMediaProgress,
  Asset,
  EventCategory,
  EventRecord,
  EventRecordDetail,
  FieldOverride,
  LegalCitation,
  Precision,
  ReportFieldSource,
  PendingReview,
  PreparedIntake,
  PreparedSearchQuery,
  RecordOrigin,
  RecordSearchFragment,
  RecordSearchGeneration,
  RecordSearchIndexStatus,
  RecordSearchHit,
  RecordSearchModality,
  RecordSearchPage,
  RecordSearchQuery,
  RetainedSource,
  ScreenAndSaveResult,
  LegacyMigrationSummary,
  ScreenedZipImportSummary,
  ScreenedZipImportCounters,
  ScreeningResult,
  TimelineFilter,
  TimelinePage
} from "@grudge-vault/domain";
import { AppError, codePointLength, projectRecordDate, recordDateMatches, resolveRecordDateFilter, reportContentSearchText,
  RECORD_QUERY_TEXT_LIMIT, RECORD_TEXT_LIMIT, type RecordDateProjection } from "@grudge-vault/shared";
import type { AssetRepositoryPort, JobRepositoryPort, ObjectVaultPort, VaultKey } from "./index";
import type { DayOneScreeningImporterPort, NormalizedDayOneEntry } from "./dayone";

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 64 * 1024 * 1024;
const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const EXCERPT_LIMIT = 160;
const REASON_LIMIT = 120;

const EXTENSION_MIME = new Map<string, string>([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"],
  [".webp", "image/webp"], [".heic", "image/heic"], [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"], [".wav", "audio/wav"], [".mp4", "video/mp4"], [".mov", "video/quicktime"]
]);

export interface InlineImageInput {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export type TransientMediaInput = {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  kind: "image" | "audio" | "video";
  screenedSha256?: string;
} & ({ path: string; bytes?: never; selectedSha256?: string; selectedFileStamp?: string }
  | { path?: never; bytes: Uint8Array; selectedSha256?: never; selectedFileStamp?: never });

export interface ScreeningInput {
  text: string;
  media: TransientMediaInput[];
  origin: RecordOrigin;
  sourceVersion: string;
}

export interface ScreeningPort {
  screen(input: ScreeningInput, signal?: AbortSignal, onProgress?: (value: NativeMediaProgress) => void): Promise<ScreeningResult>;
}

/** A streamed, authenticated source; adapters must not retain analysis copies after iteration. */
export interface NativeMediaSegmentInput {
  kind: "audio" | "video";
  mimeType: string;
  byteSize: number;
  sha256: string;
  open(signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

export interface OriginalMediaPreviewSource extends NativeMediaSegmentInput {
  assertCurrent(): void;
}

export interface NativeMediaSegment {
  index: number;
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  mimeType: "audio/wav" | "video/mp4";
  bytes: Uint8Array;
}

export interface NativeMediaSegmentPort {
  segments(input: NativeMediaSegmentInput, signal?: AbortSignal): AsyncIterable<NativeMediaSegment>;
}

export interface NativeImageRepresentation {
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Bounded, private display/analysis copies only; never replace the original attachment. */
export interface NativeImageConversionPort {
  convert(input: { mimeType: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<NativeImageRepresentation>;
}

export interface ReportAnalysisInput {
  record: EventRecord;
  source: RetainedSource;
  attachments: Asset[];
  overrides: FieldOverride[];
}

export interface ReportAnalysisResult {
  content: AnalysisReportContent;
  state: "complete" | "partial";
  promptVersion: string;
  modelProfile: string;
}

export interface ReportAnalysisPort {
  analyze(input: ReportAnalysisInput, signal?: AbortSignal, onProgress?: (value: NativeMediaProgress) => void): Promise<ReportAnalysisResult>;
}

export interface LegalResearchInput {
  jurisdiction: string;
  /** Current protected report time, never the previous record display projection. */
  occurredAt: EventRecord["occurredAt"];
  occurredAtSource: ReportFieldSource;
  occurredAtPrecision: Precision;
  /** Assertions from report synthesis are not independently confirmed facts. */
  reportedFacts: string[];
  confirmedFacts: string[];
  issues: string[];
  sourceVersion: string;
}

export interface LegalResearchResult {
  issues: string[];
  citations: Array<LegalCitation & {
    effectiveInfo: string;
    verificationEvidence?: {
      officialSource: boolean;
      excerptSupportsClaim: boolean;
      jurisdictionMatches: boolean;
      effectiveAtOccurredAt: boolean;
      factsSupportApplicability?: boolean | undefined;
      /** Binds a verification to this exact input; a hash is not legal evidence itself. */
      contextFingerprint?: string | undefined;
      /** Dates are inclusive at from, exclusive at toExclusive; absence of an end means still in force. */
      effectivePeriod?: { from: string; toExclusive?: string | undefined } | undefined;
    } | undefined;
  }>;
  coverageNotes: string[];
}

export interface LegalResearchPort {
  research(input: LegalResearchInput, signal?: AbortSignal): Promise<LegalResearchResult>;
}

export interface RecordEmbeddingInput {
  modality: RecordSearchModality;
  contentHash: string;
  text?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface RecordEmbeddingPort {
  readonly identity: string;
  readonly version: number;
  readonly dimensions: number;
  readonly inputModalities: readonly RecordSearchModality[];
  readonly normalization?: "none" | "l2";
  readonly minimumSimilarity?: number;
  readonly maxInputBytes?: number;
  readonly maxBatchSize?: number;
  isConfigured?(): boolean;
  embed(inputs: RecordEmbeddingInput[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface RecordMediaQueryDescriptionInput {
  id: string;
  modality: "audio" | "video";
  mimeType: string;
  bytes: Uint8Array;
}

export interface RecordMediaQueryDescriptionPort {
  readonly inputModalities: readonly ("audio" | "video")[];
  readonly maxInputBytes: number;
  readonly supportsStreamingInput?: boolean;
  isConfigured?(): boolean;
  describe(inputs: RecordMediaQueryDescriptionInput[], signal?: AbortSignal): Promise<Array<{ id: string; text: string }>>;
  describeStreamed?(inputs: Array<{ id: string; source: NativeMediaSegmentInput }>, signal?: AbortSignal, onProgress?: (value: NativeMediaProgress) => void): Promise<Array<{ id: string; text: string }>>;
}

export interface RecordCommitInput {
  operationId: string;
  record: EventRecord;
  source: RetainedSource;
  attachments: Asset[];
  screening: ScreeningResult;
  analysisJob: { id: string; createdAt: string };
  legacyMigration?: {
    sourceWorkspaceId: string;
    legacyEntityId: string;
    projectedTitle: string;
    projectedOccurredAt: EventRecord["occurredAt"];
    revisions: Array<{
      revision: number;
      snapshot: unknown;
      actor: string;
      reason: string;
      createdAt: string;
    }>;
  };
}

export interface LegacyMigrationEntry {
  legacyEntityId: string;
  sourceCollection?: "events" | "source_items";
  title: string;
  occurredAt: EventRecord["occurredAt"];
  text: string;
  paths: string[];
  fileNames: string[];
  incompleteMedia: boolean;
  sourceVersion: string;
  recordedAt: string;
  revisions: NonNullable<RecordCommitInput["legacyMigration"]>["revisions"];
}

export interface LegacyMigrationSourcePort {
  readonly sourceWorkspaceId: string;
  scan(
    consumer: (entry: LegacyMigrationEntry) => Promise<void>,
    signal: AbortSignal,
    selection?: { sourceCollection: "events" | "source_items"; legacyEntityId: string }
  ): Promise<number>;
  close(): Promise<void>;
}

export interface RecordRepositoryPort {
  findOperation(operationId: string): ScreenAndSaveResult | undefined;
  findRecordBySource(connectorId: string, journalId: string, entryId: string): EventRecordDetail | undefined;
  markSourceChanged(recordId: string, now: string): EventRecordDetail;
  commitRecord(input: RecordCommitInput): EventRecord;
  createPending(item: PendingReview, operationId: string): PendingReview;
  listPending(): PendingReview[];
  getPending(id: string): PendingReview | undefined;
  deletePending(id: string): void;
  reencryptPending(targetKeyId: string): void;
  listTimeline(filter: TimelineFilter): TimelinePage;
  getRecord(id: string): EventRecordDetail | undefined;
  patchFields(recordId: string, expectedRevision: number, patch: Partial<Record<FieldOverride["fieldKey"], unknown>>, now: string): EventRecordDetail;
  enqueueAnalysis(recordId: string, expectedRevision: number, jobId: string, now: string): string;
  markAnalysisRunning(recordId: string, expectedRevision: number, now: string): EventRecordDetail;
  saveReport(report: AnalysisReport): EventRecordDetail;
  failReport(recordId: string, expectedRevision: number, errorCode: string, now: string): EventRecordDetail;
  search(query: RecordSearchQuery): RecordSearchPage;
  getSearchRecords(ids: string[]): EventRecord[];
  isSearchIndexEnabled(): boolean;
  setSearchIndexEnabled(enabled: boolean, now: string): void;
  listIndexableRecords(): EventRecordDetail[];
  iterateIndexableRecordBatches(): Iterable<readonly EventRecordDetail[]>;
  getSearchProjectionVersion(): string;
  getSearchExternalVersion(): string;
  listSearchGenerations(): RecordSearchGeneration[];
  createSearchGeneration(generation: RecordSearchGeneration): void;
  prepareSearchGeneration(id: string): RecordSearchGeneration;
  putSearchEmbedding(generationId: string, fragment: RecordSearchFragment, vector: Float32Array): void;
  /** One bounded, atomic write. The synchronous scope/version fence runs under the writer lock. */
  putSearchEmbeddings(generationId: string, entries: readonly { fragment: RecordSearchFragment; vector: Float32Array }[], validateBeforeWrite: () => void): void;
  activateSearchGeneration(id: string, fragmentCount: number, now: string, expectedExternalVersion?: string, validateExternalChanges?: () => void): void;
  failSearchGeneration(id: string, error: string): void;
  listSearchFragmentKeys(generationId: string): Array<Omit<RecordSearchFragment, "text">>;
  iterateSearchFragmentKeyBatches(generationId: string): Iterable<readonly Omit<RecordSearchFragment, "text">[]>;
  listSearchEmbeddings(
    generationId: string,
    afterFragmentId?: string,
    limit?: number
  ): Array<{ fragment: RecordSearchFragment; vector: Float32Array }>;
}

export interface RedesignSession {
  key: Buffer;
  keyRing?: import("./index").WorkspaceKeyRing;
  assets: AssetRepositoryPort;
  jobs: JobRepositoryPort;
  records: RecordRepositoryPort;
  vault: ObjectVaultPort;
}

interface IntakeSession {
  id: string;
  /** Volatile ownership only; never serialize a prepared input or its repository into storage. */
  repository: RecordRepositoryPort;
  text: string;
  media: TransientMediaInput[];
  verifiedMediaHashes?: Map<string, string>;
  origin: RecordOrigin;
  sourceVersion: string;
  sourceLocator?: { connectorId: string; journalId: string; entryId: string };
  sourceRecordedAt?: string;
  incompleteMedia: boolean;
  legacyMigration?: NonNullable<RecordCommitInput["legacyMigration"]>;
  createdAt: string;
  expiresAt: string;
}

interface SearchQuerySession {
  id: string;
  /** Volatile ownership only; a prepared query cannot be reused in another workspace. */
  repository: RecordRepositoryPort;
  controller: AbortController;
  text: string;
  media: TransientMediaInput[];
  mediaHashes: Map<string, string>;
  createdAt: string;
  expiresAt: string;
  result?: {
    filterKey: string;
    hits: RecordSearchHit[];
    capabilities: RecordSearchPage["capabilities"];
    projectionRevision: number;
    assertConfiguration(): Promise<void>;
    assertProjectionStable(): void;
  };
}

function truncateCodePoints(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("");
}

function encodeSearchOffset(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeSearchOffset(cursor: string): number {
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError("INVALID_INPUT", "搜索分页游标无效。");
  return value;
}

function inputHash(text: string, media: Array<Pick<Asset, "sha256">>): string {
  return createHash("sha256").update(JSON.stringify({ text, media: media.map(({ sha256 }) => sha256) })).digest("hex");
}

async function fileHash(path: string, expectedByteSize?: number, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    const value = chunk as Buffer;
    byteSize += value.byteLength;
    if (expectedByteSize !== undefined && byteSize > expectedByteSize) {
      throw new AppError("SOURCE_UNAVAILABLE", "附件在选择后发生变化，请重新选择文件。", true);
    }
    hash.update(value);
  }
  throwIfAborted(signal);
  if (expectedByteSize !== undefined && byteSize !== expectedByteSize) {
    throw new AppError("SOURCE_UNAVAILABLE", "附件在选择后发生变化，请重新选择文件。", true);
  }
  return hash.digest("hex");
}

function fileStamp(metadata: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":");
}

async function currentFileStamp(path: string): Promise<string> {
  const metadata = await lstat(path, { bigint: true }).catch((cause) => {
    throw new AppError("SOURCE_UNAVAILABLE", "无法读取所选附件，请重新选择文件。", true, { cause });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AppError("SOURCE_UNAVAILABLE", "所选附件不再是普通本地文件，请重新选择。", true);
  }
  return fileStamp(metadata);
}

async function transientMediaHash(media: TransientMediaInput, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return media.bytes
    ? createHash("sha256").update(media.bytes).digest("hex")
    : fileHash(media.path!, media.byteSize, signal);
}

async function collectBytes(stream: AsyncIterable<unknown>, maxBytes: number, signal?: AbortSignal, assertCurrent?: () => void): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  const stop = () => { if (stream instanceof Readable) stream.destroy(); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted(); assertCurrent?.();
    for await (const chunk of stream) {
      signal?.throwIfAborted(); assertCurrent?.();
      const value = Buffer.isBuffer(chunk) ? chunk
        : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      byteSize += value.length;
      if (byteSize > maxBytes) throw new AppError("MODALITY_UNAVAILABLE", "媒体超过当前向量模型的单次输入限制。", true);
      chunks.push(value);
    }
    signal?.throwIfAborted(); assertCurrent?.();
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal?.removeEventListener("abort", stop); stop();
  }
}

async function collectVerifiedQueryMedia(
  media: TransientMediaInput, expectedHash: string | undefined, maxBytes: number, signal?: AbortSignal
): Promise<{ bytes: Uint8Array; contentHash: string }> {
  throwIfAborted(signal);
  if (!media.path) throw new AppError("INVALID_INPUT", "查询附件必须是本地文件。", true);
  const bytes = await collectBytes(createReadStream(media.path, { signal }), maxBytes).catch((cause) => {
    throwIfAborted(signal);
    if (cause instanceof AppError) throw cause;
    throw new AppError("SOURCE_UNAVAILABLE", "无法读取查询附件，请重新选择文件。", true, { cause });
  });
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  throwIfAborted(signal);
  if (bytes.byteLength !== media.byteSize || contentHash !== expectedHash) {
    throw new AppError("SOURCE_UNAVAILABLE", "查询附件在选择后发生变化，请重新选择文件。", true);
  }
  return { bytes, contentHash };
}

function matchesExpectedSignature(bytes: Uint8Array, extension: string): boolean {
  const buffer = Buffer.from(bytes);
  const ascii = buffer.toString("ascii");
  if (extension === ".jpg" || extension === ".jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (extension === ".png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".webp") return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP";
  if (extension === ".wav") return ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE";
  if (extension === ".mp3") return ascii.startsWith("ID3") || buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
  if ([".heic", ".m4a", ".mp4", ".mov"].includes(extension)) return ascii.slice(4, 8) === "ftyp";
  return false;
}

async function hasExpectedSignature(path: string, extension: string): Promise<boolean> {
  const handle = await openFile(path, "r");
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return matchesExpectedSignature(header.subarray(0, bytesRead), extension);
  } finally {
    await handle.close();
  }
}

function prepareInlineImages(inputs: InlineImageInput[]): TransientMediaInput[] {
  if (inputs.some(({ bytes }) => !(bytes instanceof Uint8Array))) {
    throw new AppError("INVALID_INPUT", "粘贴图片数据无效。", true);
  }
  if (inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0) > MAX_INLINE_IMAGE_TOTAL_BYTES) {
    throw new AppError("INVALID_INPUT", "粘贴图片总大小不能超过 64 MB，请改用文件选择。", true);
  }
  return inputs.map((input) => {
    const fileName = basename(input.fileName.trim());
    const extension = extname(fileName).toLocaleLowerCase("en-US");
    if (!fileName || !["image/jpeg", "image/png", "image/webp", "image/heic"].includes(input.mimeType) ||
      EXTENSION_MIME.get(extension) !== input.mimeType || input.bytes.byteLength === 0 ||
      input.bytes.byteLength > MAX_INLINE_IMAGE_BYTES || !matchesExpectedSignature(input.bytes.subarray(0, 32), extension)) {
      throw new AppError("INVALID_INPUT", "粘贴图片的格式、文件名或大小无效；单张最多 20 MB。", true);
    }
    const bytes = Uint8Array.from(input.bytes);
    return { id: randomUUID(), bytes, fileName, mimeType: input.mimeType, byteSize: bytes.byteLength, kind: "image" as const };
  });
}

function inferKind(mimeType: string): TransientMediaInput["kind"] | undefined {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return undefined;
}

async function prepareTransientMedia(
  paths: string[], fileNames: string[] | undefined, limit: number, signal?: AbortSignal
): Promise<TransientMediaInput[]> {
  throwIfAborted(signal);
  if (paths.length > limit) throw new AppError("INVALID_INPUT", `一次最多选择 ${limit} 个附件。`);
  const media: TransientMediaInput[] = [];
  for (const [index, path] of paths.entries()) {
    throwIfAborted(signal);
    if (!isAbsolute(path)) throw new AppError("INVALID_INPUT", "附件路径必须来自系统文件选择器。");
    const metadata = await lstat(path, { bigint: true }).catch((cause) => {
      throwIfAborted(signal);
      throw new AppError("SOURCE_UNAVAILABLE", "无法读取所选附件。", true, { cause });
    });
    throwIfAborted(signal);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AppError("INVALID_INPUT", "只能选择普通本地文件。");
    if (metadata.size > BigInt(MAX_ATTACHMENT_BYTES)) throw new AppError("INVALID_INPUT", "单个附件不能超过 500 MB。");
    const extension = extname(path).toLocaleLowerCase("en-US");
    const mimeType = EXTENSION_MIME.get(extension) ?? String(lookupMimeType(path) || "");
    const kind = inferKind(mimeType);
    if (!kind || !EXTENSION_MIME.has(extension)) throw new AppError("INVALID_INPUT", "暂不支持这个附件格式。");
    const signatureValid = await hasExpectedSignature(path, extension);
    throwIfAborted(signal);
    if (!signatureValid) throw new AppError("INVALID_INPUT", "附件内容与文件格式不匹配或文件已损坏。");
    const selectedSha256 = metadata.size <= BigInt(kind === "image" ? 20 * 1024 * 1024 : 7_000_000)
      ? await fileHash(path, Number(metadata.size), signal).catch((cause) => {
        throwIfAborted(signal);
        if (cause instanceof AppError) throw cause;
        throw new AppError("SOURCE_UNAVAILABLE", "无法核对所选附件，请重新选择文件。", true, { cause });
      })
      : undefined;
    const selectedFileStamp = fileStamp(metadata);
    const verifiedFileStamp = await currentFileStamp(path);
    throwIfAborted(signal);
    if (verifiedFileStamp !== selectedFileStamp) {
      throw new AppError("SOURCE_UNAVAILABLE", "附件在选择时发生变化，请重新选择文件。", true);
    }
    const requestedName = fileNames?.[index];
    media.push({
      id: randomUUID(), path, fileName: basename(requestedName?.trim() || path), mimeType,
      byteSize: Number(metadata.size), kind, selectedFileStamp,
      ...(selectedSha256 ? { selectedSha256 } : {})
    });
  }
  return media;
}

function normalizeEmbedding(vector: Float32Array, dimensions: number, normalization: "none" | "l2"): Float32Array {
  if (vector.length !== dimensions) {
    throw new AppError("EMBEDDING_UNAVAILABLE", "多模态向量服务返回了不兼容的向量维度。", true);
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new AppError("EMBEDDING_UNAVAILABLE", "多模态向量包含无效数值。", true);
    squaredNorm += value * value;
  }
  if (squaredNorm <= Number.EPSILON) throw new AppError("EMBEDDING_UNAVAILABLE", "多模态向量不能是零向量。", true);
  if (normalization === "none") return vector;
  const norm = Math.sqrt(squaredNorm);
  return Float32Array.from(vector, (value) => value / norm);
}

function embeddingMatchesGeneration(
  generation: Pick<RecordSearchGeneration, "adapterIdentity" | "adapterVersion" | "dimensions" | "normalization" | "inputModalities">,
  adapter: RecordEmbeddingPort
): boolean {
  return generation.adapterIdentity === adapter.identity && generation.adapterVersion === adapter.version &&
    generation.dimensions === adapter.dimensions && generation.normalization === (adapter.normalization ?? "l2") &&
    [...generation.inputModalities].sort().join(",") === [...adapter.inputModalities].sort().join(",");
}

function meanVector(vectors: Float32Array[], dimensions: number): Float32Array {
  if (!vectors.length || vectors.some(({ length }) => length !== dimensions)) {
    throw new AppError("EMBEDDING_UNAVAILABLE", "多模态向量服务返回了不兼容的结果。", true);
  }
  const output = new Float32Array(dimensions);
  for (const vector of vectors) for (let index = 0; index < dimensions; index += 1) {
    output[index] = (output[index] ?? 0) + vector[index]!;
  }
  for (let index = 0; index < dimensions; index += 1) output[index] = (output[index] ?? 0) / vectors.length;
  return output;
}

function searchAttachmentRetained(asset: Asset): boolean {
  return asset.availabilityStatus !== "deleted" && !asset.deletedAt;
}

function recordTextFragments(detail: EventRecordDetail): Array<{
  content: string; contentHash: string; anchor: import("@grudge-vault/domain").SourceAnchor; index: number;
}> {
  const chunkSize = 6_000;
  const fragments: Array<{
    content: string; contentHash: string; anchor: import("@grudge-vault/domain").SourceAnchor; index: number;
  }> = [];
  const surfaces: Array<{
    content: string;
    surface: NonNullable<import("@grudge-vault/domain").SourceAnchor["surface"]>;
    fieldKey?: FieldOverride["fieldKey"];
    anchor?: import("@grudge-vault/domain").SourceAnchor;
  }> = [
    { content: detail.source.text ?? "", surface: "source" },
    { content: `${detail.record.title}\n${detail.record.summary}`, surface: "record" },
    ...(detail.report && detail.report.recordRevision === detail.record.revision ? [
      {
        content: reportContentSearchText(detail.report.content, { includeAnchoredContent: false }),
        surface: "report" as const
      },
      ...detail.report.content.chronology.map((step) => ({
        content: step.text, surface: "report" as const,
        ...(step.anchor ? { anchor: step.anchor } : {})
      })),
      ...(detail.report.content.mediaSegments ?? []).map((segment) => ({
        content: segment.description, surface: "report" as const, anchor: segment.anchor
      }))
    ] : []),
    ...detail.overrides.map(({ fieldKey, value }) => ({
      content: `${fieldKey}=${JSON.stringify(value)}`, surface: "user" as const, fieldKey
    }))
  ];
  let index = 0;
  for (const surface of surfaces) {
    const points = Array.from(surface.content);
    for (let offset = 0; offset < points.length; offset += chunkSize, index += 1) {
      const chunk = points.slice(offset, offset + chunkSize).join("");
      fragments.push({
        content: chunk, contentHash: createHash("sha256").update(chunk).digest("hex"), index,
        anchor: surface.anchor ?? {
          sourceVersion: detail.source.sourceVersion,
          surface: surface.surface,
          ...(surface.fieldKey ? { fieldKey: surface.fieldKey } : {}),
          ...(surface.surface === "source"
            ? { textRange: [offset, Math.min(offset + chunkSize, points.length)] as [number, number] } : {})
        }
      });
    }
  }
  const retainedAssets = new Set(detail.attachments.filter(searchAttachmentRetained).map(({ id }) => id));
  // Preserve fragment positions/IDs for unaffected text, but never retain a playable anchor to a deleted original.
  return fragments.filter(({ anchor }) => !anchor.assetId || retainedAssets.has(anchor.assetId));
}

function searchFragmentSignature(fragment: Omit<RecordSearchFragment, "text">): string {
  const anchor = fragment.anchor;
  // Canonical field order includes positions even when the embedded text has not changed.
  return createHash("sha256").update(JSON.stringify([
    fragment.recordId, fragment.recordRevision, fragment.sourceVersion, fragment.modality, fragment.contentHash,
    fragment.assetId ?? null, anchor.sourceVersion, anchor.surface ?? null, anchor.fieldKey ?? null,
    anchor.assetId ?? null, anchor.temporaryMediaRef ?? null, anchor.textRange ?? null,
    anchor.intervalMs ?? null, anchor.frameTimeMs ?? null
  ])).digest("hex");
}

function currentSearchFragmentKeys(detail: EventRecordDetail, modalities: readonly RecordSearchModality[]): Array<Omit<RecordSearchFragment, "text">> {
  const { record, source } = detail;
  const common = { recordId: record.id, recordRevision: record.revision, sourceVersion: source.sourceVersion };
  return [
    ...(modalities.includes("text") ? recordTextFragments(detail).map(({ contentHash, anchor, index }) => ({
      ...common, id: deterministicUuid(`search:text:${record.id}:${record.revision}:${index}:${contentHash}`),
      modality: "text" as const, contentHash, anchor
    })) : []),
    ...detail.attachments.flatMap((asset) => {
      const modality = inferKind(asset.mimeType);
      return !searchAttachmentRetained(asset) || !modality || !modalities.includes(modality) ? [] : [{
        ...common, id: deterministicUuid(`search:${modality}:${record.id}:${record.revision}:${asset.sha256}`),
        modality, contentHash: asset.sha256, assetId: asset.id, anchor: { sourceVersion: source.sourceVersion, assetId: asset.id }
      }];
    })
  ];
}

function searchBuildFingerprintAccumulator(modalities: readonly RecordSearchModality[]) {
  const fingerprint = createHash("sha256");
  return {
    append(details: readonly EventRecordDetail[]) {
      for (const detail of details) {
        fingerprint.update(JSON.stringify(detail.record));
        for (const fragment of currentSearchFragmentKeys(detail, modalities)) {
          fingerprint.update(fragment.id).update(searchFragmentSignature(fragment));
        }
      }
    },
    finish() { return fingerprint.digest("hex"); }
  };
}

async function readSearchBuildFingerprint(
  workspace: RedesignSession, modalities: readonly RecordSearchModality[], assertActive: () => void
): Promise<{ fingerprint: string; version: string }> {
  assertActive();
  const version = workspace.records.getSearchProjectionVersion();
  const checkpoint = () => {
    assertActive();
    if (workspace.records.getSearchProjectionVersion() !== version) {
      throw new AppError("REVISION_CONFLICT", "记录、报告或索引在构建校验期间更新，请重新构建。", true);
    }
  };
  await yieldToEventLoop(); checkpoint();
  const accumulator = searchBuildFingerprintAccumulator(modalities);
  for (const details of workspace.records.iterateIndexableRecordBatches()) {
    checkpoint(); accumulator.append(details); checkpoint();
    await yieldToEventLoop(); checkpoint();
  }
  checkpoint();
  return { fingerprint: accumulator.finish(), version };
}

interface CurrentSearchProjection {
  current: Map<string, string>;
  coverage: NonNullable<RecordSearchPage["capabilities"]["indexCoverage"]>;
  fingerprint: string;
  version: string;
}

function searchProjectionAccumulator(modalities: readonly RecordSearchModality[]) {
  const current = new Map<string, string>(), fingerprint = createHash("sha256");
  let currentFragments = 0, indexedFragments = 0;
  return {
    appendDetails(details: readonly EventRecordDetail[]) {
      for (const detail of details) {
        fingerprint.update(JSON.stringify(detail.record));
        for (const fragment of currentSearchFragmentKeys(detail, modalities)) {
          const signature = searchFragmentSignature(fragment);
          current.set(fragment.id, signature); fingerprint.update(fragment.id).update(signature);
        }
      }
    },
    appendIndexed(fragments: readonly Omit<RecordSearchFragment, "text">[]) {
      for (const fragment of fragments) {
        const signature = searchFragmentSignature(fragment);
        currentFragments += Number(current.get(fragment.id) === signature);
        indexedFragments += 1; fingerprint.update(fragment.id).update(signature);
      }
    },
    finish(version: string): CurrentSearchProjection {
      return { current, coverage: { currentFragments, expectedFragments: current.size, outdatedFragments: indexedFragments - currentFragments },
        fingerprint: fingerprint.digest("hex"), version };
    }
  };
}

function assertScreeningResult(value: ScreeningResult, input: ScreeningInput): void {
  if (!value.policyVersion.trim() || !value.reason.trim()) {
    throw new AppError("SCREENING_FAILED", "The screening result was incomplete.", true);
  }
  if (value.reason.length > 2_000 || new Set(value.categories).size !== value.categories.length) {
    throw new AppError("SCREENING_FAILED", "The screening result did not match the required schema.", true);
  }
  if (value.decision === "include" && value.categories.length === 0) {
    throw new AppError("SCREENING_FAILED", "Included records require at least one supported category.", true);
  }
  if (value.decision === "skip" && value.coverage !== "complete") {
    throw new AppError("SCREENING_FAILED", "Partially inspected input cannot be classified as unrelated.", true);
  }
  const mediaIds = new Set(input.media.map(({ id }) => id));
  for (const anchor of value.anchors) {
    if (anchor.sourceVersion !== input.sourceVersion || anchor.temporaryMediaRef && !mediaIds.has(anchor.temporaryMediaRef)) {
      throw new AppError("SCREENING_FAILED", "The screening result referenced content outside this input session.", true);
    }
    if (anchor.textRange && (anchor.textRange[0] > anchor.textRange[1] || anchor.textRange[1] > codePointLength(input.text))) {
      throw new AppError("SCREENING_FAILED", "The screening result contained an invalid text anchor.", true);
    }
    if (anchor.intervalMs && anchor.intervalMs[0] > anchor.intervalMs[1]) {
      throw new AppError("SCREENING_FAILED", "The screening result contained an invalid media interval.", true);
    }
  }
  if (input.media.length && value.decision === "skip") {
    const covered = new Set(value.anchors.flatMap(({ temporaryMediaRef }) => temporaryMediaRef ? [temporaryMediaRef] : []));
    if (input.media.some(({ id }) => !covered.has(id))) {
      throw new AppError("SCREENING_FAILED", "Every media input requires coverage evidence before it can be skipped.", true);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new AppError("IMPORT_CANCELLED", "本次导入已停止。", true);
}

function titleFrom(session: IntakeSession): string {
  const sentence = session.text.trim().split(/[。！？.!?\n]/, 1)[0]?.trim();
  if (sentence) return truncateCodePoints(sentence, 80);
  return session.media[0] ? `媒体记录：${truncateCodePoints(session.media[0].fileName, 60)}` : "新记录";
}

export class RedesignService {
  private readonly sessions = new Map<string, IntakeSession>();
  private readonly pendingDraftPreparations = new Map<string, AbortController>();
  private readonly sessionInFlight = new Map<string, symbol>();
  private readonly pendingSessions = new Map<string, string>();
  private readonly pendingInFlight = new Map<string, symbol>();
  private readonly searchSessions = new Map<string, SearchQuerySession>();
  private readonly pendingSearchPreparations = new Map<string, AbortController>();
  private readonly activeIndexBuilds = new Map<string, AbortController>();
  private readonly activeIndexScheduling = new Map<AbortController, RecordRepositoryPort>();
  private transientEpoch = 0;
  private activeZipImports = new Set<AbortController>();
  private readonly activeLegacyMigrations = new Set<AbortController>();
  private searchProjectionRevision = 0;
  private searchProjectionCache: {
    repository: RecordRepositoryPort;
    generationId: string;
    modalities: string;
    version: string;
    projection: CurrentSearchProjection;
  } | undefined;

  constructor(
    private readonly current: () => RedesignSession,
    private readonly embedding?: RecordEmbeddingPort,
    private readonly mediaQueryDescription?: RecordMediaQueryDescriptionPort,
    private readonly createTransientDirectory?: (prefix: string) => Promise<string>,
    private readonly nativeImageConversion?: NativeImageConversionPort,
    private readonly beginModelOperation?: () => (() => void)
  ) {}

  private transientDirectory(prefix: string): Promise<string> {
    return this.createTransientDirectory?.(prefix) ?? mkdtemp(join(tmpdir(), `grudge-vault-${prefix}`));
  }

  clearTransientSessions(): void {
    this.transientEpoch += 1;
    for (const controller of this.activeZipImports) {
      controller.abort(new AppError("IMPORT_CANCELLED", "工作区会话已变化，本次导入已停止。", true));
    }
    for (const controller of this.activeLegacyMigrations) {
      controller.abort(new AppError("IMPORT_CANCELLED", "工作区会话已变化，本次旧工作区迁移已停止。", true));
    }
    for (const controller of this.activeIndexBuilds.values()) {
      controller.abort(new AppError("SOURCE_UNAVAILABLE", "工作区会话已变化，搜索索引任务已停止。", true));
    }
    for (const controller of this.activeIndexScheduling.keys()) {
      controller.abort(new AppError("SOURCE_UNAVAILABLE", "工作区会话已变化，搜索索引检查已停止。", true));
    }
    for (const controller of this.pendingDraftPreparations.values()) {
      controller.abort(new AppError("SOURCE_UNAVAILABLE", "输入会话已失效，请重新提供内容。", true));
    }
    this.pendingDraftPreparations.clear();
    for (const controller of this.pendingSearchPreparations.values()) {
      controller.abort(new AppError("SOURCE_UNAVAILABLE", "搜索会话已失效，请重新提供查询内容。", true));
    }
    this.pendingSearchPreparations.clear();
    this.sessions.clear();
    this.sessionInFlight.clear();
    this.pendingSessions.clear();
    this.pendingInFlight.clear();
    for (const session of this.searchSessions.values()) this.abortSearchSession(session);
    this.searchSessions.clear();
    this.searchProjectionCache = undefined;
  }

  async prepareDraft(input: {
    requestId?: string;
    text?: string;
    paths?: string[];
    fileNames?: string[];
    inlineMedia?: InlineImageInput[];
    origin?: RecordOrigin;
    sourceVersion?: string;
    sourceLocator?: { connectorId: string; journalId: string; entryId: string };
    sourceRecordedAt?: string;
    incompleteMedia?: boolean;
    legacyMigration?: NonNullable<RecordCommitInput["legacyMigration"]>;
  }, signal?: AbortSignal): Promise<PreparedIntake> {
    throwIfAborted(signal);
    const repository = this.current().records;
    const epoch = this.transientEpoch;
    this.pruneExpiredSessions();
    const text = input.text ?? "";
    const paths = input.paths ?? [];
    const inlineMedia = input.inlineMedia ?? [];
    if (!text.trim() && paths.length + inlineMedia.length === 0) throw new AppError("INVALID_INPUT", "请输入文字或选择至少一个媒体文件。");
    if (codePointLength(text) > RECORD_TEXT_LIMIT) throw new AppError("INVALID_INPUT", "文字不能超过 50,000 字。");
    if (paths.length + inlineMedia.length > MAX_ATTACHMENTS) throw new AppError("INVALID_INPUT", "一次最多选择 20 个附件。");
    const requestId = input.requestId ?? randomUUID();
    if (this.pendingDraftPreparations.has(requestId)) throw new AppError("INVALID_INPUT", "这份输入正在准备中。", true);
    const controller = new AbortController();
    const preparationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.pendingDraftPreparations.set(requestId, controller);
    try {
      const media = [...await prepareTransientMedia(paths, input.fileNames, MAX_ATTACHMENTS, preparationSignal),
        ...prepareInlineImages(inlineMedia)];
      throwIfAborted(preparationSignal);
      if (epoch !== this.transientEpoch || this.current().records !== repository) {
        throw new AppError("SOURCE_UNAVAILABLE", "输入会话已失效，请重新提供内容。", true);
      }
      const now = new Date();
      const session: IntakeSession = {
        id: randomUUID(), repository, text, media, origin: input.origin ?? "manual",
        sourceVersion: input.sourceVersion?.trim() || randomUUID(),
        ...(input.sourceLocator ? { sourceLocator: input.sourceLocator } : {}),
        ...(input.sourceRecordedAt ? { sourceRecordedAt: input.sourceRecordedAt } : {}),
        incompleteMedia: input.incompleteMedia ?? false,
        ...(input.legacyMigration ? { legacyMigration: input.legacyMigration } : {}),
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()
      };
      this.sessions.set(session.id, session);
      return {
        sessionId: session.id, textLength: codePointLength(text), expiresAt: session.expiresAt,
        attachments: media.map(({ id, fileName, mimeType, byteSize, kind }) => ({ id, fileName, mimeType, byteSize, kind }))
      };
    } finally {
      if (this.pendingDraftPreparations.get(requestId) === controller) this.pendingDraftPreparations.delete(requestId);
    }
  }

  abandonDraftPreparation(requestId: string): void {
    this.pendingDraftPreparations.get(requestId)?.abort(
      new AppError("SOURCE_UNAVAILABLE", "输入准备已取消，未建立正式记录。", true)
    );
  }

  abandonDraft(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [pendingId, mappedSessionId] of this.pendingSessions) {
      if (mappedSessionId === sessionId) this.pendingSessions.delete(pendingId);
    }
  }

  async prepareSearchQuery(input: { text?: string; paths?: string[]; fileNames?: string[]; requestId?: string }): Promise<PreparedSearchQuery> {
    const repository = this.current().records;
    const epoch = this.transientEpoch;
    this.pruneExpiredSessions();
    const text = input.text ?? "";
    const paths = input.paths ?? [];
    if (!text.trim() && paths.length === 0) throw new AppError("INVALID_INPUT", "请输入搜索文字或选择查询媒体。");
    if (codePointLength(text) > RECORD_QUERY_TEXT_LIMIT) throw new AppError("INVALID_INPUT", "搜索文字不能超过 500 字。");
    const requestId = input.requestId ?? randomUUID();
    if (this.pendingSearchPreparations.has(requestId)) throw new AppError("INVALID_INPUT", "这次搜索正在准备中。", true);
    const controller = new AbortController();
    this.pendingSearchPreparations.set(requestId, controller);
    try {
      const signal = controller.signal;
      const media = await prepareTransientMedia(paths, input.fileNames, 4, signal);
      const mediaHashes = new Map<string, string>();
      for (const item of media) {
        throwIfAborted(signal);
        mediaHashes.set(item.id, item.selectedSha256 ?? await fileHash(item.path!, item.byteSize, signal).catch((cause) => {
          throwIfAborted(signal);
          throw new AppError("SOURCE_UNAVAILABLE", "无法读取查询附件，请重新选择文件。", true, { cause });
        }));
      }
      throwIfAborted(signal);
      if (epoch !== this.transientEpoch || !this.isSearchWorkspaceCurrent(repository)) {
        throw new AppError("SOURCE_UNAVAILABLE", "搜索会话已失效，请重新提供查询内容。", true);
      }
      const now = new Date();
      const session: SearchQuerySession = {
        id: randomUUID(), repository, controller: new AbortController(), text, media, mediaHashes, createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()
      };
      this.searchSessions.set(session.id, session);
      return {
        sessionId: session.id, textLength: codePointLength(text), expiresAt: session.expiresAt,
        attachments: media.map(({ id, fileName, mimeType, byteSize, kind }) => ({ id, fileName, mimeType, byteSize, kind }))
      };
    } finally {
      if (this.pendingSearchPreparations.get(requestId) === controller) this.pendingSearchPreparations.delete(requestId);
    }
  }

  abandonSearchPreparation(requestId: string): void {
    this.pendingSearchPreparations.get(requestId)?.abort(
      new AppError("SOURCE_UNAVAILABLE", "搜索准备已取消，请重新提供查询内容。", true)
    );
  }

  abandonSearchQuery(sessionId: string): void {
    const session = this.searchSessions.get(sessionId);
    if (session) this.abortSearchSession(session);
    this.searchSessions.delete(sessionId);
  }

  getSearchIndexStatus(): RecordSearchIndexStatus {
    const workspace = this.current();
    const enabled = workspace.records.isSearchIndexEnabled();
    if (!this.embedding || this.embedding.isConfigured?.() === false) return {
      available: false, enabled, state: "unavailable", inputModalities: [], queryModalities: [], fragmentCount: 0
    };
    const adapter = this.embedding;
    const compatible = (generation: RecordSearchGeneration): boolean =>
      embeddingMatchesGeneration(generation, adapter);
    const generations = workspace.records.listSearchGenerations();
    const active = generations.find((generation) => generation.state === "active" && compatible(generation));
    const building = generations.find((generation) => generation.state === "building" && compatible(generation));
    const failed = generations.find((generation) => generation.state === "failed" && compatible(generation));
    const jobs = workspace.jobs.list();
    const queued = jobs.some((job) =>
      job.type === "record.search-index-rebuild" && job.state === "queued");
    const checking = [...this.activeIndexScheduling].some(([controller, records]) =>
      records === workspace.records && !controller.signal.aborted) || jobs.some((job) =>
      job.type === "record.search-index-check" && (job.state === "queued" || job.state === "running"));
    const failedCheck = jobs.find((job) => job.type === "record.search-index-check" && job.state === "failed" &&
      (!active?.activatedAt || job.updatedAt > active.activatedAt));
    return {
      available: true, enabled,
      state: !enabled ? "paused" : building || queued ? "building" : checking ? "checking" : active ? "ready" : failed || failedCheck ? "failed" : "empty",
      inputModalities: [...adapter.inputModalities],
      queryModalities: [...new Set([
        ...adapter.inputModalities,
        ...(adapter.inputModalities.includes("text") && this.mediaQueryDescription &&
          this.mediaQueryDescription.isConfigured?.() !== false ? this.mediaQueryDescription.inputModalities : [])
      ])],
      ...(active ? { activeGenerationId: active.id } : {}),
      fragmentCount: active?.fragmentCount ?? 0,
      ...(failed?.lastError || failedCheck?.lastError ? { lastError: failed?.lastError ?? failedCheck!.lastError! } : {})
    };
  }

  async ensureSearchIndexJob(
    signal: AbortSignal = new AbortController().signal, deferOnContention = true
  ): Promise<string | undefined> {
    signal.throwIfAborted();
    const adapter = this.embedding;
    if (!adapter || adapter.isConfigured?.() === false) return undefined;
    const workspace = this.current(), epoch = this.transientEpoch;
    const assertConfiguration = this.beginModelOperation?.();
    const shape = { adapterIdentity: adapter.identity, adapterVersion: adapter.version, dimensions: adapter.dimensions,
      normalization: adapter.normalization ?? "l2", inputModalities: [...adapter.inputModalities] };
    const controller = new AbortController(), operationSignal = AbortSignal.any([signal, controller.signal]);
    const paused = new AppError("JOB_STATE_CONFLICT", "多模态搜索索引已暂停。", true);
    const assertActive = () => {
      operationSignal.throwIfAborted();
      let same = false;
      try { const current = this.current(); same = current.records === workspace.records && current.vault === workspace.vault; }
      catch { /* Treat a closed workspace as an expired scheduling scope. */ }
      if (epoch !== this.transientEpoch || !same) throw new AppError("SOURCE_UNAVAILABLE", "工作区会话已变化，搜索索引检查已停止。", true);
      assertConfiguration?.();
      if (adapter.isConfigured?.() === false) throw new AppError("EMBEDDING_UNAVAILABLE", "向量模型配置已不可用，搜索索引检查已停止。", true);
      if (!embeddingMatchesGeneration(shape, adapter)) throw new AppError("REVISION_CONFLICT", "向量模型已变化，搜索索引检查已停止。", true);
      if (!workspace.records.isSearchIndexEnabled()) throw paused;
    };
    this.activeIndexScheduling.set(controller, workspace.records);
    try {
      // A full-coverage result is not authoritative if metadata or content changed while it was read.
      // Retry the whole decision, including pause, jobs and vector space, rather than the old generation alone.
      for (let attempt = 0; attempt < 2; attempt++) {
        assertActive();
        const version = workspace.records.getSearchProjectionVersion();
        const generations = workspace.records.listSearchGenerations();
        const inFlight = workspace.jobs.list().find((job) =>
          (job.type === "record.search-index-rebuild" || deferOnContention && job.type === "record.search-index-check") &&
          (job.state === "queued" || job.state === "running"));
        const building = generations.find((generation) => generation.state === "building" &&
          embeddingMatchesGeneration(generation, adapter));
        const active = generations.find((generation) =>
          generation.state === "active" && embeddingMatchesGeneration(generation, adapter));
        if (workspace.records.getSearchProjectionVersion() !== version) continue;
        if (generations.length === 0) return undefined;
        if (inFlight) return inFlight.id;
        if (building) return this.enqueueSearchGeneration(workspace, building);
        if (active) {
          let projection: CurrentSearchProjection;
          try { projection = await this.currentSearchProjectionAsync(workspace, active, shape.inputModalities, assertActive); }
          catch (error) {
            assertActive();
            if (error instanceof AppError && error.code === "REVISION_CONFLICT") continue;
            throw error;
          }
          assertActive();
          if (projection.version !== version || workspace.records.getSearchProjectionVersion() !== version) continue;
          const { coverage } = projection;
          if (coverage.currentFragments === coverage.expectedFragments && coverage.outdatedFragments === 0) return undefined;
        }
        return this.enqueueSearchGeneration(workspace, this.createSearchGeneration(workspace, adapter));
      }
      // Version churn may be unrelated jobs/settings. Defer a read-only decision, not a paid rebuild.
      // The check worker retries with backoff and cannot recursively enqueue itself.
      assertActive();
      const generations = workspace.records.listSearchGenerations();
      if (generations.length === 0) return undefined;
      const inFlight = workspace.jobs.list().find((job) =>
        job.type === "record.search-index-rebuild" && (job.state === "queued" || job.state === "running"));
      if (inFlight) return inFlight.id;
      const building = generations.find((generation) => generation.state === "building" &&
        embeddingMatchesGeneration(generation, adapter));
      if (building) return this.enqueueSearchGeneration(workspace, building);
      if (!deferOnContention) throw new AppError("REVISION_CONFLICT", "索引覆盖检查期间数据发生变化，稍后重试。", true);
      const pendingCheck = workspace.jobs.list().find((job) => job.type === "record.search-index-check" &&
        (job.state === "queued" || job.state === "running"));
      return pendingCheck?.id ?? workspace.jobs.enqueue("record.search-index-check", {}, new Date().toISOString(), 3).id;
    } catch (error) {
      if (!signal.aborted && (error === paused || controller.signal.aborted &&
        controller.signal.reason instanceof AppError && controller.signal.reason.code === "JOB_STATE_CONFLICT")) return undefined;
      throw error;
    } finally {
      this.activeIndexScheduling.delete(controller);
    }
  }

  private async currentSearchProjectionAsync(
    workspace: RedesignSession, generation: RecordSearchGeneration, modalities: readonly RecordSearchModality[], assertActive: () => void
  ): Promise<CurrentSearchProjection> {
    assertActive();
    const version = workspace.records.getSearchProjectionVersion(), modalityKey = [...modalities].sort().join(",");
    const cached = this.searchProjectionCache;
    if (cached?.repository === workspace.records && cached.generationId === generation.id &&
      cached.modalities === modalityKey && cached.version === version) return cached.projection;
    const checkpoint = () => {
      assertActive();
      if (workspace.records.getSearchProjectionVersion() !== version) {
        throw new AppError("REVISION_CONFLICT", "记录、报告或索引在校验期间更新，请重新搜索。", true);
      }
    };
    // Allow already queued cancellation/lock/configuration events before the first potentially expensive read.
    await yieldToEventLoop(); checkpoint();
    const accumulator = searchProjectionAccumulator(modalities);
    for (const details of workspace.records.iterateIndexableRecordBatches()) {
      checkpoint(); accumulator.appendDetails(details); checkpoint();
      await yieldToEventLoop(); checkpoint();
    }
    for (const fragments of workspace.records.iterateSearchFragmentKeyBatches(generation.id)) {
      checkpoint(); accumulator.appendIndexed(fragments); checkpoint();
      await yieldToEventLoop(); checkpoint();
    }
    checkpoint();
    const projection = accumulator.finish(version);
    // Publish only complete metadata, never a partial projection or raw source/report text.
    this.searchProjectionCache = { repository: workspace.records, generationId: generation.id, modalities: modalityKey, version, projection };
    return projection;
  }

  requestSearchIndexRebuild(): RecordSearchIndexStatus {
    const adapter = this.embedding;
    if (!adapter || adapter.isConfigured?.() === false) {
      throw new AppError("EMBEDDING_UNAVAILABLE", "尚未配置经过验证的百炼多模态向量适配器。", true);
    }
    const workspace = this.current();
    workspace.records.setSearchIndexEnabled(true, new Date().toISOString());
    const inFlight = workspace.jobs.list().some((job) =>
      job.type === "record.search-index-rebuild" && (job.state === "queued" || job.state === "running"));
    if (inFlight) return this.getSearchIndexStatus();
    const building = workspace.records.listSearchGenerations().find((generation) =>
      generation.state === "building" && embeddingMatchesGeneration(generation, adapter));
    const generation = building ?? this.createSearchGeneration(workspace, adapter);
    this.enqueueSearchGeneration(workspace, generation);
    return this.getSearchIndexStatus();
  }

  setSearchIndexEnabled(enabled: boolean): { status: RecordSearchIndexStatus; jobIds: string[] } {
    const workspace = this.current();
    workspace.records.setSearchIndexEnabled(enabled, new Date().toISOString());
    if (!enabled) for (const controller of this.activeIndexBuilds.values()) {
      controller.abort(new AppError("JOB_STATE_CONFLICT", "多模态搜索索引已暂停。", true));
    }
    if (!enabled) for (const controller of this.activeIndexScheduling.keys()) {
      controller.abort(new AppError("JOB_STATE_CONFLICT", "多模态搜索索引检查已暂停。", true));
    }
    this.searchProjectionRevision += 1;
    const jobIds = workspace.jobs.list().filter((job) =>
      (job.type === "record.search-index-rebuild" || job.type === "record.search-index-check") &&
      (job.state === "queued" || job.state === "running"))
      .map(({ id }) => id);
    return { status: this.getSearchIndexStatus(), jobIds };
  }

  private enqueueSearchGeneration(workspace: RedesignSession, generation: RecordSearchGeneration): string {
    try {
      return workspace.jobs.enqueue(
        "record.search-index-rebuild", { generationId: generation.id }, new Date().toISOString(), 3
      ).id;
    } catch (error) {
      workspace.records.failSearchGeneration(generation.id, "无法创建搜索索引后台任务。");
      throw error;
    }
  }

  async rebuildSearchIndex(
    generationId?: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<RecordSearchIndexStatus> {
    signal.throwIfAborted();
    const assertConfiguration = this.beginModelOperation?.();
    assertConfiguration?.();
    const adapter = this.embedding;
    if (!adapter || adapter.isConfigured?.() === false) {
      throw new AppError("EMBEDDING_UNAVAILABLE", "尚未配置经过验证的百炼多模态向量适配器。", true);
    }
    const workspace = this.current();
    const epoch = this.transientEpoch, projectionRevision = this.searchProjectionRevision;
    const sameWorkspace = () => {
      try {
        const current = this.current();
        return current.records === workspace.records && current.vault === workspace.vault;
      }
      catch { return false; }
    };
    if (generationId && this.activeIndexBuilds.has(generationId)) {
      throw new AppError("REVISION_CONFLICT", "这个搜索索引代际仍有任务在退出，请等待后重试。", true);
    }
    if (!workspace.records.isSearchIndexEnabled()) {
      throw new AppError("JOB_STATE_CONFLICT", "多模态搜索索引已暂停。", true);
    }
    if (!generationId && workspace.records.listSearchGenerations().some(({ state }) => state === "building")) {
      throw new AppError("REVISION_CONFLICT", "已有搜索索引代际正在构建。", true);
    }
    const generation = generationId
      ? workspace.records.prepareSearchGeneration(generationId)
      : this.createSearchGeneration(workspace, adapter);
    const compatible = () => embeddingMatchesGeneration(generation, adapter);
    if (!compatible()) {
      workspace.records.failSearchGeneration(generation.id, "搜索索引任务的向量模型已变化。");
      throw new AppError("REVISION_CONFLICT", "搜索索引任务与当前向量模型不一致。", true);
    }
    const controller = new AbortController(), operationSignal = AbortSignal.any([signal, controller.signal]);
    this.activeIndexBuilds.set(generation.id, controller);
    let externalVersion: string | undefined;
    let inputFingerprint: string | undefined;
    const assertBuildScope = () => {
      operationSignal.throwIfAborted();
      if (this.transientEpoch !== epoch || !sameWorkspace()) throw new AppError("SOURCE_UNAVAILABLE", "工作区会话已变化，搜索索引任务已停止。", true);
      assertConfiguration?.();
      if (!workspace.records.isSearchIndexEnabled()) throw new AppError("JOB_STATE_CONFLICT", "多模态搜索索引已暂停。", true);
      if (adapter.isConfigured?.() === false) throw new AppError("EMBEDDING_UNAVAILABLE", "向量模型配置已不可用，请重新配置后构建索引。", true);
      if (!compatible()) throw new AppError("REVISION_CONFLICT", "搜索索引任务与当前向量模型不一致。", true);
      if (this.searchProjectionRevision !== projectionRevision) throw new AppError("REVISION_CONFLICT", "记录或报告在索引构建期间更新，请重新构建。", true);
    };
    const revisionConflict = () => new AppError("REVISION_CONFLICT", "记录、报告或索引在构建校验期间更新，请重新构建。", true);
    const checkedBuild = async <T>(action: () => T | Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        assertBuildScope();
        const observed = workspace.records.getSearchExternalVersion();
        if (inputFingerprint !== undefined && observed !== externalVersion) {
          const candidate = await readSearchBuildFingerprint(workspace, generation.inputModalities, assertBuildScope);
          assertBuildScope();
          if (candidate.fingerprint !== inputFingerprint) throw revisionConflict();
          // Close the await/microtask gap before accepting an unrelated external commit.
          if (candidate.version !== workspace.records.getSearchProjectionVersion() ||
            workspace.records.getSearchExternalVersion() !== observed) continue;
          externalVersion = observed;
        }
        assertBuildScope();
        if (workspace.records.getSearchExternalVersion() !== externalVersion) continue;
        // Invoke the outbound/write action in this same continuation, not after another await.
        return action();
      }
      throw revisionConflict();
    };
    try {
      assertBuildScope();
      externalVersion = workspace.records.getSearchExternalVersion();
      // Keep only a complete fingerprint, not the entire raw corpus, while checking admission to paid work.
      const initial = await readSearchBuildFingerprint(workspace, generation.inputModalities, assertBuildScope);
      assertBuildScope();
      if (workspace.records.getSearchProjectionVersion() !== initial.version) {
        throw new AppError("REVISION_CONFLICT", "记录、报告或索引在构建校验期间更新，请重新构建。", true);
      }
      inputFingerprint = initial.fingerprint;
      await checkedBuild(() => {});
      const maxBytes = adapter.maxInputBytes ?? 20 * 1024 * 1024;
      const batchSize = Math.max(1, Math.min(adapter.maxBatchSize ?? 16, 64));
      const batch: Array<{ fragment: RecordSearchFragment; input: RecordEmbeddingInput }> = [];
      let fragmentCount = 0;
      const flush = async (): Promise<void> => {
        assertBuildScope();
        if (batch.length === 0) { await checkedBuild(() => {}); return; }
        const vectors = await checkedBuild(() => adapter.embed(batch.map(({ input }) => input), operationSignal));
        // A foreign writer can commit after the last admission read but before BEGIN IMMEDIATE.
        // Roll back that attempt, then recheck cooperatively outside the lock. Reuse this response,
        // never repeat the model call, and keep both the write size and contention attempts bounded.
        const writeRace = new Error("Internal search batch admission retry");
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await checkedBuild(() => {
              if (vectors.length !== batch.length || vectors.some(({ length }) => length !== adapter.dimensions)) {
                throw new AppError("EMBEDDING_UNAVAILABLE", "多模态向量服务返回了不兼容的索引结果。", true);
              }
              const entries = batch.map(({ fragment }, index) => ({ fragment,
                vector: normalizeEmbedding(vectors[index]!, generation.dimensions, generation.normalization) }));
              workspace.records.putSearchEmbeddings(generation.id, entries, () => {
                assertBuildScope();
                if (workspace.records.getSearchExternalVersion() !== externalVersion) throw writeRace;
              });
              fragmentCount += batch.length;
              batch.length = 0;
            });
            break;
          } catch (error) {
            if (error !== writeRace) throw error;
            if (attempt === 1) throw revisionConflict();
            await yieldToEventLoop(); assertBuildScope();
          }
        }
      };
      const append = async (value: { fragment: RecordSearchFragment; input: RecordEmbeddingInput }): Promise<void> => {
        assertBuildScope();
        batch.push(value);
        if (batch.length >= batchSize) await flush();
      };
      // Re-read in bounded batches only after validating the full input. Original bytes stay in one
      // detail batch at a time; the same scope/version guards still fence every outbound request.
      for (const details of workspace.records.iterateIndexableRecordBatches()) {
        assertBuildScope();
        for (const detail of details) {
          assertBuildScope();
          if (adapter.inputModalities.includes("text")) {
            for (const { content, contentHash, anchor, index } of recordTextFragments(detail)) {
              const fragment: RecordSearchFragment = {
                id: deterministicUuid(`search:text:${detail.record.id}:${detail.record.revision}:${index}:${contentHash}`),
                recordId: detail.record.id, recordRevision: detail.record.revision,
                sourceVersion: detail.source.sourceVersion, modality: "text", contentHash, text: content, anchor
              };
              await append({ fragment, input: { modality: "text", contentHash, text: content } });
            }
          }
          for (const asset of detail.attachments) {
            assertBuildScope();
            if (!searchAttachmentRetained(asset)) continue;
            const modality = inferKind(asset.mimeType);
            if (!modality || !adapter.inputModalities.includes(modality)) continue;
            const sourceLimit = needsNativeImageConversion(asset.mimeType) ? 20 * 1024 * 1024 : maxBytes;
            if (asset.byteSize > sourceLimit) {
              throw new AppError("MODALITY_UNAVAILABLE", "原件超过当前向量适配器限制。", true);
            }
            const bytes = await collectBytes(await workspace.vault.open(asset.sha256, workspace.keyRing ?? workspace.key), sourceLimit, operationSignal, assertBuildScope);
            assertBuildScope();
            if (bytes.length !== asset.byteSize || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
              throw new AppError("ASSET_CORRUPT", "索引原件校验失败。", false);
            }
            const image = modality === "image" ? await prepareNativeImage({ mimeType: asset.mimeType, bytes }, this.nativeImageConversion, operationSignal) : undefined;
            assertBuildScope();
            if (image && image.bytes.length > maxBytes) throw new AppError("MODALITY_UNAVAILABLE", "转换图片仍超过向量模型限制。", true);
            const fragment: RecordSearchFragment = {
              id: deterministicUuid(`search:${modality}:${detail.record.id}:${detail.record.revision}:${asset.sha256}`),
              recordId: detail.record.id, recordRevision: detail.record.revision,
              sourceVersion: detail.source.sourceVersion, modality, contentHash: asset.sha256, assetId: asset.id,
              anchor: { sourceVersion: detail.source.sourceVersion, assetId: asset.id }
            };
            await append({
              fragment,
              input: { modality, contentHash: asset.sha256, bytes: image?.bytes ?? bytes, mimeType: image?.mimeType ?? asset.mimeType }
            });
          }
        }
        await yieldToEventLoop(); await checkedBuild(() => {});
      }
      await flush();
      // A late foreign commit rolls the immediate transaction back. Recheck outside the writer
      // lock, then reacquire it for a cheap version fence; never await or scan raw input under it.
      const activationRace = new Error("Internal search activation retry");
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await checkedBuild(() => workspace.records.activateSearchGeneration(
            generation.id, fragmentCount, new Date().toISOString(), externalVersion,
            () => { assertBuildScope(); throw activationRace; }
          ));
          break;
        } catch (error) {
          if (error !== activationRace) throw error;
          if (attempt === 1) throw revisionConflict();
          await yieldToEventLoop(); assertBuildScope();
        }
      }
      this.searchProjectionRevision += 1;
      return this.getSearchIndexStatus();
    } catch (error) {
      const failure = operationSignal.aborted ? operationSignal.reason : error;
      if (sameWorkspace()) {
        workspace.records.failSearchGeneration(generation.id, failure instanceof AppError ? failure.code : operationSignal.aborted ? "JOB_STATE_CONFLICT" : "INTERNAL_ERROR");
      }
      throw failure;
    } finally {
      if (this.activeIndexBuilds.get(generation.id) === controller) this.activeIndexBuilds.delete(generation.id);
    }
  }

  private createSearchGeneration(workspace: RedesignSession, adapter: RecordEmbeddingPort): RecordSearchGeneration {
    const generation: RecordSearchGeneration = {
      id: randomUUID(), adapterIdentity: adapter.identity, adapterVersion: adapter.version,
      dimensions: adapter.dimensions, normalization: adapter.normalization ?? "l2",
      inputModalities: [...adapter.inputModalities], state: "building",
      fragmentCount: 0, createdAt: new Date().toISOString()
    };
    workspace.records.createSearchGeneration(generation);
    return generation;
  }

  async executeSearchQuery(
    sessionId: string,
    filters: Omit<RecordSearchQuery, "text" | "cursor"> & { cursor?: string },
    onProgress?: (value: NativeMediaProgress) => void
  ): Promise<RecordSearchPage> {
    this.pruneExpiredSessions();
    const session = this.searchSessions.get(sessionId);
    if (!session) throw new AppError("SOURCE_UNAVAILABLE", "搜索会话已失效，请重新提供查询内容。", true);
    this.assertSearchStillActive(session);
    const signal = session.controller.signal;
    const { cursor, ...requestedFilters } = filters;
    const dates = resolveRecordDateFilter(requestedFilters);
    if (!dates) throw new AppError("INVALID_INPUT", "日期范围或时区无效。");
    const pageFilters = { ...requestedFilters, timeZone: dates.timeZone };
    const limit = Math.max(1, Math.min(pageFilters.limit ?? 30, 100));
    const filterKey = JSON.stringify({
      limit,
      from: pageFilters.from ?? null,
      to: pageFilters.to ?? null,
      timeZone: dates.timeZone,
      category: pageFilters.category ?? null,
      origin: pageFilters.origin ?? null
    });
    if (session.result) {
      const result = session.result;
      try { await result.assertConfiguration(); result.assertProjectionStable(); this.assertSearchStillActive(session); }
      catch (error) { this.abandonSearchQuery(sessionId); throw error; }
      if (result.projectionRevision !== this.searchProjectionRevision || session.result !== result) {
        this.abandonSearchQuery(sessionId);
        throw new AppError("REVISION_CONFLICT", "记录或报告已更新，请重新搜索。", true);
      }
      if (!cursor || result.filterKey !== filterKey) {
        throw new AppError("INVALID_INPUT", "搜索分页条件已变化，请重新搜索。");
      }
      const offset = decodeSearchOffset(cursor);
      if (offset >= result.hits.length) throw new AppError("INVALID_INPUT", "搜索分页游标已超出结果范围。");
      const nextOffset = offset + limit;
      const page: RecordSearchPage = {
        hits: result.hits.slice(offset, nextOffset),
        capabilities: result.capabilities,
        ...(nextOffset < result.hits.length ? { nextCursor: encodeSearchOffset(nextOffset) } : {})
      };
      if (!page.nextCursor) this.searchSessions.delete(sessionId);
      return page;
    }
    if (cursor) throw new AppError("INVALID_INPUT", "搜索分页会话尚未建立。");
    const projectionRevision = this.searchProjectionRevision;
    let localFallback: (() => RecordSearchPage) | undefined;
    let assertConfiguration: (() => void) | undefined;
    let assertProjectionCurrent: (() => Promise<void>) | undefined;
    let assertProjectionStable: (() => void) | undefined;
    let vectorScorer: SearchVectorScorer | undefined;
    const closeScoring = async () => {
      if (vectorScorer) {
        try { await vectorScorer.close(); }
        catch (error) { this.abandonSearchQuery(sessionId); throw error; }
        vectorScorer = undefined;
      }
    };
    try {
      const workspace = this.current();
      const adapter = workspace.records.isSearchIndexEnabled() ? this.embedding : undefined;
      const active = workspace.records.listSearchGenerations().find(({ state }) => state === "active");
      if (!adapter || adapter.isConfigured?.() === false || !active || !embeddingMatchesGeneration(active, adapter)) {
        if (session.media.length) throw new AppError("EMBEDDING_UNAVAILABLE", "媒体语义检索尚未建立可用索引。", true);
        const keywordPage = workspace.records.search({ ...pageFilters, text: session.text, limit });
        this.assertSearchStillActive(session);
        const page: RecordSearchPage = {
          ...keywordPage,
          capabilities: {
            keyword: "ready", semantic: adapter ? "building" : "unavailable",
            media: adapter ? "building" : "unavailable"
          }
        };
        this.searchSessions.delete(sessionId);
        return page;
      }
      // Capture configuration before the first cooperative read, not after a potentially long cold scan.
      assertConfiguration = this.beginModelOperation?.();
      const assertModelCurrent = () => {
        assertConfiguration?.();
        if (adapter.isConfigured?.() === false) throw new AppError("EMBEDDING_UNAVAILABLE", "语义模型配置已不可用，请重新搜索。", true);
        if (!embeddingMatchesGeneration(active, adapter)) throw new AppError("REVISION_CONFLICT", "向量模型已变化，请重新搜索。", true);
      };
      const assertCurrent = () => {
        this.assertSearchStillActive(session); assertModelCurrent();
        if (projectionRevision !== this.searchProjectionRevision) throw new AppError("REVISION_CONFLICT", "记录或报告已更新，请重新搜索。", true);
      };
      const projection = await this.currentSearchProjectionAsync(workspace, active, adapter.inputModalities, assertCurrent);
      assertCurrent();
      const projectionFingerprint = projection.fingerprint;
      let verifiedVersion = projection.version;
      const assertSnapshotStable = () => {
        assertCurrent();
        if (workspace.records.getSearchProjectionVersion() !== verifiedVersion) {
          throw new AppError("REVISION_CONFLICT", "记录、报告或索引已更新，请重新搜索。", true);
        }
      };
      const assertSnapshotCurrent = async () => {
        assertCurrent();
        const version = workspace.records.getSearchProjectionVersion();
        if (version === verifiedVersion) return;
        const currentActive = workspace.records.listSearchGenerations().find(({ state }) => state === "active");
        const currentProjection = await this.currentSearchProjectionAsync(workspace, active, adapter.inputModalities, assertCurrent);
        assertCurrent();
        if (currentActive?.id !== active.id || currentProjection.fingerprint !== projectionFingerprint ||
          currentProjection.version !== workspace.records.getSearchProjectionVersion()) {
          throw new AppError("REVISION_CONFLICT", "记录、报告或索引已更新，请重新搜索。", true);
        }
        // Unrelated writes (for example job state) can invalidate the cache without changing search results.
        verifiedVersion = currentProjection.version;
      };
      assertProjectionCurrent = assertSnapshotCurrent;
      assertProjectionStable = assertSnapshotStable;
      await assertSnapshotCurrent();
      assertSnapshotStable();
      if (projection.coverage.currentFragments === 0 && (projection.coverage.expectedFragments > 0 || projection.coverage.outdatedFragments > 0)) {
        if (session.media.length) throw new AppError("EMBEDDING_UNAVAILABLE", "当前正式记录的媒体语义索引尚未就绪，请更新索引后重试。", true);
        const page: RecordSearchPage = {
          ...workspace.records.search({ ...pageFilters, text: session.text, limit }),
          capabilities: { keyword: "ready", semantic: "building", media: "building", indexCoverage: projection.coverage }
        };
        this.assertSearchStillActive(session);
        this.searchSessions.delete(sessionId);
        return page;
      }
      assertCurrent();
      const keyword = session.text.trim()
        ? workspace.records.search({ ...pageFilters, text: session.text, limit: Math.max(limit, 100) })
        : { hits: [], capabilities: { keyword: "ready" as const, semantic: "unavailable" as const, media: "unavailable" as const } };
      if (session.media.length === 0) {
        localFallback = () => ({
          ...workspace.records.search({ ...pageFilters, text: session.text, limit }),
          capabilities: { keyword: "ready", semantic: "unavailable", media: "unavailable" }
        });
      }
      const queryInputs: RecordEmbeddingInput[] = [];
      const mediaDescriptionInputs: RecordMediaQueryDescriptionInput[] = [];
      const streamedDescriptionInputs: Array<{ id: string; source: NativeMediaSegmentInput }> = [];
      if (session.text.trim()) {
        queryInputs.push({
          modality: "text", text: session.text,
          contentHash: createHash("sha256").update(session.text).digest("hex")
        });
      }
      const maxBytes = adapter.maxInputBytes ?? 20 * 1024 * 1024;
      for (const media of session.media) {
        assertCurrent();
        if (!adapter.inputModalities.includes(media.kind)) {
          if ((media.kind === "audio" || media.kind === "video") && adapter.inputModalities.includes("text") &&
            this.mediaQueryDescription?.inputModalities.includes(media.kind) &&
            this.mediaQueryDescription.isConfigured?.() !== false) {
            if (this.mediaQueryDescription.supportsStreamingInput && this.mediaQueryDescription.describeStreamed &&
              (media.byteSize > this.mediaQueryDescription.maxInputBytes || media.mimeType === "audio/mp4" || media.mimeType === "audio/x-m4a")) {
              const sourceHash = session.mediaHashes.get(media.id);
              if (!media.path || !sourceHash) throw new AppError("SOURCE_UNAVAILABLE", "查询附件缺少来源校验，请重新选择文件。", true);
              const sourcePath = media.path;
              streamedDescriptionInputs.push({ id: media.id, source: {
                kind: media.kind, mimeType: media.mimeType, byteSize: media.byteSize, sha256: sourceHash,
                async open(sourceSignal) {
                  assertCurrent(); sourceSignal?.throwIfAborted();
                  return (async function* () {
                    for await (const chunk of createReadStream(sourcePath, { signal: sourceSignal })) {
                      assertCurrent(); yield Buffer.from(chunk);
                    }
                    assertCurrent();
                  })();
                }
              } });
              continue;
            }
            const verified = await collectVerifiedQueryMedia(
              media, session.mediaHashes.get(media.id), this.mediaQueryDescription.maxInputBytes, signal
            );
            mediaDescriptionInputs.push({
              id: media.id, modality: media.kind, mimeType: media.mimeType,
              bytes: verified.bytes
            });
            assertCurrent();
            continue;
          }
          throw new AppError("MODALITY_UNAVAILABLE", `当前模型接入未验证${media.kind === "image" ? "图片" : media.kind === "audio" ? "音频" : "视频"}查询。`, true);
        }
        const verified = await collectVerifiedQueryMedia(media, session.mediaHashes.get(media.id),
          needsNativeImageConversion(media.mimeType) ? 20 * 1024 * 1024 : maxBytes, signal);
        assertCurrent();
        const image = media.kind === "image" ? await prepareNativeImage({ mimeType: media.mimeType, bytes: verified.bytes }, this.nativeImageConversion, signal) : undefined;
        assertCurrent();
        if (image && image.bytes.length > maxBytes) throw new AppError("MODALITY_UNAVAILABLE", "转换图片仍超过查询模型限制。", true);
        queryInputs.push({
          modality: media.kind, contentHash: verified.contentHash, mimeType: image?.mimeType ?? media.mimeType,
          bytes: image?.bytes ?? verified.bytes
        });
        assertCurrent();
      }
      const describedIds = [...mediaDescriptionInputs, ...streamedDescriptionInputs].map(({ id }) => id);
      if (describedIds.length > 0) {
        assertCurrent();
        const descriptions = mediaDescriptionInputs.length
          ? await this.mediaQueryDescription!.describe(mediaDescriptionInputs, signal) : [];
        assertCurrent();
        if (streamedDescriptionInputs.length) {
          descriptions.push(...await this.mediaQueryDescription!.describeStreamed!(streamedDescriptionInputs, signal, (value) => {
            assertCurrent();
            const index = session.media.findIndex(({ id }) => id === value.mediaId);
            if (index >= 0) onProgress?.({ ...value, mediaNumber: index + 1, mediaCount: session.media.length });
          }));
        }
        assertCurrent();
        const byId = new Map(descriptions.map((item) => [item.id, item.text.trim()]));
        if (descriptions.length !== describedIds.length || byId.size !== descriptions.length ||
          describedIds.some((id) => !byId.get(id))) {
          throw new AppError("MODALITY_UNAVAILABLE", "音视频查询模型没有返回完整的临时语义描述。", true);
        }
        for (const id of describedIds) {
          const text = byId.get(id)!;
          queryInputs.push({ modality: "text", text, contentHash: createHash("sha256").update(text).digest("hex") });
        }
      }
      if (queryInputs.some(({ modality }) => !adapter.inputModalities.includes(modality))) {
        throw new AppError("MODALITY_UNAVAILABLE", "当前向量适配器不能处理全部查询模态。", true);
      }
      assertCurrent();
      const vectors = await adapter.embed(queryInputs, signal);
      assertCurrent();
      await assertSnapshotCurrent();
      assertSnapshotStable();
      const queryVector = normalizeEmbedding(
        meanVector(vectors, adapter.dimensions), adapter.dimensions, active.normalization
      );
      assertCurrent();
      const matchesByRecord = new Map<string, Array<{ score: number; fragment: RecordSearchFragment }>>();
      const minimumSimilarity = adapter.minimumSimilarity ?? 0.2;
      const recordCache = new Map<string, EventRecord | undefined>();
      const dateCache = new Map<string, RecordDateProjection>();
      let afterFragmentId: string | undefined;
      while (true) {
        assertCurrent();
        const items = workspace.records.listSearchEmbeddings(active.id, afterFragmentId, 512);
        const missingRecordIds = [...new Set(items.map(({ fragment }) => fragment.recordId))]
          .filter((recordId) => !recordCache.has(recordId));
        const loadedRecords = new Map(workspace.records.getSearchRecords(missingRecordIds).map((record) => [record.id, record]));
        missingRecordIds.forEach((recordId) => recordCache.set(recordId, loadedRecords.get(recordId)));
        const eligible: typeof items = [];
        for (const item of items) {
          const record = recordCache.get(item.fragment.recordId);
          if (!record || record.revision !== item.fragment.recordRevision) continue;
          if (projection.current.get(item.fragment.id) !== searchFragmentSignature(item.fragment)) continue;
          if (pageFilters.category && !record.categories.includes(pageFilters.category)) continue;
          if (pageFilters.origin && record.origin !== pageFilters.origin) continue;
          let date = dateCache.get(record.id);
          if (!date) {
            date = projectRecordDate(record, dates.timeZone);
            if (!date) throw new AppError("WORKSPACE_INVALID", "无法读取记录日期，请检查工作区。");
            dateCache.set(record.id, date);
          }
          if (!recordDateMatches(date, dates)) continue;
          if (item.vector.length !== active.dimensions) {
            throw new AppError("EMBEDDING_UNAVAILABLE", "本地语义索引的向量维度不正确，请重建索引。", true);
          }
          eligible.push(item);
        }
        let scores: Float64Array = new Float64Array();
        if (eligible.length) {
          vectorScorer ??= new SearchVectorScorer(queryVector, active.normalization, signal);
          scores = await vectorScorer.score(eligible.map(({ vector }) => vector));
          assertCurrent();
        }
        for (const [index, item] of eligible.entries()) {
          const score = scores[index]!;
          if (score < minimumSimilarity) continue;
          const matches = matchesByRecord.get(item.fragment.recordId) ?? [];
          matches.push({ score, fragment: item.fragment });
          matches.sort((left, right) => right.score - left.score);
          if (matches.length > 3) matches.length = 3;
          matchesByRecord.set(item.fragment.recordId, matches);
        }
        if (items.length < 512) break;
        afterFragmentId = items.at(-1)!.fragment.id;
        await yieldToEventLoop();
        assertCurrent();
      }
      // Finish owned-thread cleanup before publishing, then revalidate the asynchronous boundary.
      await closeScoring();
      assertCurrent();
      await assertSnapshotCurrent();
      assertSnapshotStable();
      const semantic = [...matchesByRecord.entries()].sort((left, right) => right[1][0]!.score - left[1][0]!.score);
      const descriptionQuery = describedIds.length > 0;
      const merged = new Map<string, { hit: import("@grudge-vault/domain").RecordSearchHit; score: number }>();
      keyword.hits.forEach((hit, index) => merged.set(hit.record.id, { hit, score: 0.7 / (61 + index) }));
      semantic.forEach(([recordId, matches], index) => {
        const record = recordCache.get(recordId);
        if (!record) return;
        const current = merged.get(recordId);
        const semanticMatches = matches.map((match) => ({
          explanation: `${descriptionQuery ? "音视频模型描述匹配" : match.fragment.modality === "text" ? "语义" : "跨模态"}相似度 ${(match.score * 100).toFixed(1)}%`,
          anchor: match.fragment.anchor
        }));
        const best = semanticMatches[0]!;
        merged.set(recordId, {
          hit: current?.hit ?? {
            record,
            explanation: best.explanation,
            anchor: best.anchor,
            matches: semanticMatches
          },
          score: (current?.score ?? 0) + 0.3 / (61 + index)
        });
        if (current) current.hit.matches = [
          { explanation: current.hit.explanation, ...(current.hit.anchor ? { anchor: current.hit.anchor } : {}) },
          ...semanticMatches
        ].slice(0, 3);
      });
      const hits = [...merged.values()].sort((left, right) => right.score - left.score).map(({ hit }) => hit);
      const capabilities: RecordSearchPage["capabilities"] = {
        keyword: "ready", semantic: "ready",
        indexCoverage: projection.coverage,
        media: adapter.inputModalities.some((value) => value !== "text") || Boolean(this.mediaQueryDescription &&
          this.mediaQueryDescription.isConfigured?.() !== false) ? "ready" : "unavailable"
      };
      assertCurrent();
      await assertSnapshotCurrent();
      assertSnapshotStable();
      if (hits.length > limit) {
        session.result = { filterKey, hits, capabilities, projectionRevision,
          assertConfiguration: async () => { assertCurrent(); await assertSnapshotCurrent(); assertSnapshotStable(); },
          assertProjectionStable: assertSnapshotStable };
        // Pagination only needs the ranked hits. Do not retain the original query,
        // selected file paths or their hashes for the lifetime of the cursor.
        session.text = "";
        session.media = [];
        session.mediaHashes.clear();
        return { hits: hits.slice(0, limit), nextCursor: encodeSearchOffset(limit), capabilities };
      }
      this.searchSessions.delete(sessionId);
      return { hits, capabilities };
    } catch (error) {
      await closeScoring();
      // An obsolete request may neither publish old results nor disguise them as a local fallback.
      this.assertSearchStillActive(session);
      const fallback = error instanceof AppError && (error.code === "REVISION_CONFLICT" || error.code === "LLM_CONFIGURATION_CHANGED")
        ? undefined : this.searchSessions.get(sessionId) === session ? localFallback : undefined;
      try {
        throwIfAborted(signal);
        // A failed old request must not conceal a concurrent change as a successful local fallback.
        assertConfiguration?.();
        if (fallback) {
          await assertProjectionCurrent?.(); assertProjectionStable?.(); this.assertSearchStillActive(session); return fallback();
        }
        if (session.media.length && !(error instanceof AppError)) {
          throw new AppError("EMBEDDING_UNAVAILABLE", "媒体语义检索暂不可用，请检查模型或索引后重试。", true, { cause: error });
        }
        throw error;
      } finally {
        // Even a failed asynchronous fallback recheck releases only this query's ownership.
        if (this.searchSessions.get(sessionId) === session) this.searchSessions.delete(sessionId);
      }
    } finally {
      if (vectorScorer) await closeScoring();
    }
  }

  async screenAndSave(sessionId: string, operationId: string, screening: ScreeningPort, signal?: AbortSignal): Promise<ScreenAndSaveResult> {
    throwIfAborted(signal);
    const workspace = this.current();
    const scopedManualOperationId = manualIntakeOperationId(sessionId, operationId);
    const manualReplay = workspace.records.findOperation(scopedManualOperationId);
    if (manualReplay) return manualReplay;
    const session = this.requireSession(sessionId);
    const release = this.claimSession(sessionId);
    const commitOperationId = session.origin === "manual" ? scopedManualOperationId : operationId;
    try {
      if (session.origin !== "manual") {
        const existing = workspace.records.findOperation(commitOperationId);
        if (existing) return existing;
      }
      delete session.verifiedMediaHashes;
      const mediaHashes = new Map<string, string>();
      for (const media of session.media) {
        throwIfAborted(signal);
        if (media.path && media.selectedFileStamp && await currentFileStamp(media.path) !== media.selectedFileStamp) {
          throw new AppError("SOURCE_UNAVAILABLE", "附件在选择后发生变化，请重新选择文件。", true);
        }
        const selectedHash = media.selectedSha256;
        mediaHashes.set(media.id, await transientMediaHash(media, signal).catch((cause) => {
          throwIfAborted(signal);
          throw new AppError("SOURCE_UNAVAILABLE", "无法读取待筛选附件，请重新选择文件。", true, { cause });
        }));
        if (selectedHash && mediaHashes.get(media.id) !== selectedHash || media.path && media.selectedFileStamp &&
          await currentFileStamp(media.path) !== media.selectedFileStamp) {
          throw new AppError("SOURCE_UNAVAILABLE", "附件在选择后发生变化，请重新选择文件。", true);
        }
      }
      this.assertDraftStillActive(session);
      const input: ScreeningInput = {
        text: session.text, origin: session.origin, sourceVersion: session.sourceVersion,
        media: session.media.map((media) => ({ ...media, screenedSha256: mediaHashes.get(media.id)! }))
      };
      let result: ScreeningResult;
      try {
        result = await screening.screen(input, signal);
        throwIfAborted(signal);
      } catch (error) {
        if (error instanceof AppError && error.code === "MODALITY_UNAVAILABLE" && session.origin !== "manual") {
          result = {
            decision: "review", categories: [], reason: "存在当前模型无法完整检查的媒体，需要人工确认。",
            anchors: [], coverage: "partial", policyVersion: "capability-fallback-v1"
          };
        } else {
          throw error;
        }
      }
      for (const media of session.media) {
        throwIfAborted(signal);
        const currentHash = await transientMediaHash(media, signal).catch((cause) => {
          throwIfAborted(signal);
          throw new AppError("SOURCE_UNAVAILABLE", "无法复核已筛选附件，请重新选择文件。", true, { cause });
        });
        if (currentHash !== mediaHashes.get(media.id)) {
          throw new AppError("SOURCE_UNAVAILABLE", "附件在筛选期间发生变化，请重新选择后再试。", true);
        }
        if (media.path && media.selectedFileStamp && await currentFileStamp(media.path) !== media.selectedFileStamp) {
          throw new AppError("SOURCE_UNAVAILABLE", "附件在筛选期间发生变化，请重新选择后再试。", true);
        }
      }
      session.verifiedMediaHashes = mediaHashes;
      if (session.incompleteMedia) {
        result = {
          ...result,
          decision: "review",
          reason: `${result.reason}；部分媒体缺失或当前不支持，不能判定为无关。`,
          coverage: "partial"
        };
      }
      throwIfAborted(signal);
      this.assertDraftStillActive(session);
      assertScreeningResult(result, input);
      const prior = session.sourceLocator
        ? workspace.records.findRecordBySource(
          session.sourceLocator.connectorId,
          session.sourceLocator.journalId,
          session.sourceLocator.entryId
        )
        : undefined;
      const changedPrior = prior && prior.source.sourceVersion !== session.sourceVersion ? prior : undefined;
      if (result.decision === "skip") {
        if (changedPrior) {
          workspace.records.markSourceChanged(changedPrior.record.id, new Date().toISOString());
          await this.refreshSearchIndexAfterCommit();
        }
        throwIfAborted(signal);
        this.assertDraftStillActive(session);
        this.sessions.delete(sessionId);
        return { kind: "skipped", message: "不属于收录范围" };
      }
      if (result.decision === "review") {
        const now = new Date().toISOString();
        const pending: PendingReview = {
          id: randomUUID(), origin: session.origin, sourceVersion: session.sourceVersion,
          ...(session.sourceLocator ? { originLocator: JSON.stringify(session.sourceLocator) } : {}),
          excerpt: truncateCodePoints(session.text || session.media.map(({ fileName }) => fileName).join("、"), EXCERPT_LIMIT),
          reason: truncateCodePoints(result.reason, REASON_LIMIT), categories: result.categories,
          coverage: result.coverage, sessionAvailable: true, createdAt: now, updatedAt: now
        };
        const retained = workspace.records.createPending(pending, commitOperationId);
        if (retained.id === pending.id) this.pendingSessions.set(pending.id, session.id);
        if (changedPrior) workspace.records.markSourceChanged(changedPrior.record.id, now);
        return { kind: "needs_review", pendingId: pending.id };
      }
      return await this.commitIncluded(session, commitOperationId, result, signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof AppError) return { kind: "failed", code: error.code, retryable: error.retryable };
      return { kind: "failed", code: "INTERNAL_ERROR", retryable: false };
    } finally {
      release();
    }
  }

  async screenManualAndSave(
    sessionId: string, operationId: string, screening: ScreeningPort, signal?: AbortSignal
  ): Promise<ScreenAndSaveResult> {
    throwIfAborted(signal);
    const existing = this.current().records.findOperation(manualIntakeOperationId(sessionId, operationId));
    if (existing) return existing;
    if (this.requireSession(sessionId).origin !== "manual") {
      throw new AppError("INVALID_INPUT", "手动新建入口不能提交导入来源。", true);
    }
    return this.screenAndSave(sessionId, operationId, screening, signal);
  }

  listPending(): PendingReview[] {
    this.pruneExpiredSessions();
    return this.current().records.listPending().map((item) => ({
      ...item,
      sessionAvailable: this.sessions.has(this.pendingSessions.get(item.id) ?? "")
    }));
  }

  async resolvePending(id: string, action: "keep" | "ignore", operationId: string): Promise<ScreenAndSaveResult | null> {
    const release = this.claimPending(id);
    try {
      const workspace = this.current();
      const commitOperationId = deterministicUuid(`pending-confirm:${id}:${operationId}`);
      if (action === "keep") {
        const existing = workspace.records.findOperation(commitOperationId);
        if (existing?.kind === "saved") {
          if (workspace.records.getPending(id)) workspace.records.deletePending(id);
          this.pendingSessions.delete(id);
          return existing;
        }
      }
      const pending = workspace.records.getPending(id);
      if (!pending) throw new AppError("ENTITY_NOT_FOUND", "待确认项不存在。");
      if (action === "ignore") {
        workspace.records.deletePending(id);
        const sessionId = this.pendingSessions.get(id);
        if (sessionId) this.sessions.delete(sessionId);
        this.pendingSessions.delete(id);
        return null;
      }
      const session = this.sessions.get(this.pendingSessions.get(id) ?? "");
      if (!session) throw new AppError("SOURCE_UNAVAILABLE", "原始输入会话已失效，请重新提供完整内容。");
      const categories: EventCategory[] = pending.categories.length ? pending.categories : ["grudge"];
      const result: ScreeningResult = {
        decision: "include", categories, reason: `用户确认保留：${pending.reason}`,
        anchors: [], coverage: pending.coverage, policyVersion: "user-review-v1"
      };
      const saved = await this.commitIncluded(session, commitOperationId, result);
      workspace.records.deletePending(id);
      this.pendingSessions.delete(id);
      return saved;
    } finally {
      release();
    }
  }

  async rescreenPendingFromManual(
    id: string, sessionId: string, screening: ScreeningPort, signal?: AbortSignal
  ): Promise<ScreenAndSaveResult> {
    const release = this.claimPending(id);
    try {
      const workspace = this.current();
      const operationId = deterministicUuid(`pending-manual-rescreen:${id}:${sessionId}`);
      const previousResult = workspace.records.findOperation(manualIntakeOperationId(sessionId, operationId));
      if (previousResult) {
        if (workspace.records.getPending(id)) workspace.records.deletePending(id);
        this.pendingSessions.delete(id);
        return previousResult;
      }
      const pending = workspace.records.getPending(id);
      if (!pending || !["manual", "migration", "zip", "dayone"].includes(pending.origin)) {
        throw new AppError("ENTITY_NOT_FOUND", "请选择一条可重新提供完整内容的待确认项。");
      }
      const session = this.requireSession(sessionId);
      if (session.origin !== "manual") throw new AppError("INVALID_INPUT", "请重新提供完整的手动输入。", true);
      const oldSessionId = this.pendingSessions.get(id);
      const result = await this.screenAndSave(sessionId, operationId, screening, signal);
      if (result.kind !== "failed") {
        workspace.records.deletePending(id);
        this.pendingSessions.delete(id);
        if (oldSessionId && oldSessionId !== sessionId) this.sessions.delete(oldSessionId);
      }
      return result;
    } finally {
      release();
    }
  }

  async resolvePendingFromDayOneZip(
    id: string,
    archivePath: string,
    importer: DayOneScreeningImporterPort,
    screening: ScreeningPort,
    operationId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ScreenAndSaveResult> {
    const release = this.claimPending(id);
    try {
      return await this.resolvePendingFromDayOneZipUnlocked(id, archivePath, importer, screening, operationId, signal);
    } finally {
      release();
    }
  }

  private async resolvePendingFromDayOneZipUnlocked(
    id: string, archivePath: string, importer: DayOneScreeningImporterPort,
    screening: ScreeningPort, operationId: string, signal: AbortSignal
  ): Promise<ScreenAndSaveResult> {
    if (!isAbsolute(archivePath)) throw new AppError("INVALID_INPUT", "Day One ZIP 路径无效。");
    const records = this.current().records;
    const commitOperationId = deterministicUuid(`pending-zip:${id}:${operationId}`);
    const existing = records.findOperation(commitOperationId);
    if (existing) {
      const stillPending = records.getPending(id);
      if (existing.kind !== "failed" && stillPending?.origin === "zip") records.deletePending(id);
      return existing;
    }
    const pending = records.getPending(id);
    if (!pending || pending.origin !== "zip" || !pending.originLocator) {
      throw new AppError("ENTITY_NOT_FOUND", "请选择一条来自 Day One ZIP 的待确认项。");
    }
    let locator: { connectorId: string; journalId: string; entryId: string };
    try {
      const parsed = JSON.parse(pending.originLocator) as Record<string, unknown>;
      if (parsed.connectorId !== "dayone-zip" || typeof parsed.journalId !== "string" || typeof parsed.entryId !== "string") {
        throw new Error("Invalid Day One source locator.");
      }
      locator = { connectorId: parsed.connectorId, journalId: parsed.journalId, entryId: parsed.entryId };
    } catch (cause) {
      throw new AppError("WORKSPACE_INVALID", "待确认项的 Day One 来源定位已损坏。", false, { cause });
    }

    const root = await this.transientDirectory("pending-zip-");
    const selectedRoot = join(root, "selected");
    let sessionId: string | undefined;
    try {
      await mkdir(selectedRoot, { mode: 0o700 });
      let matches = 0;
      let targetInvalid = false;
      let selected: {
        entry: NormalizedDayOneEntry;
        paths: string[];
        fileNames: string[];
        incompleteMedia: boolean;
      } | undefined;
      await importer.scanArchive(archivePath, root, {
        onIssue: async (issue) => {
          if (issue.code === "DAYONE_ENTRY_INVALID" &&
            (issue.entryExternalId === locator.entryId ||
              issue.entryExternalId === dayOneInvalidEntryDiagnosticId(locator.entryId))) targetInvalid = true;
        },
        onProgress: () => undefined,
        onEntry: async (entry, media, incompleteMedia) => {
          throwIfAborted(signal);
          if (dayOneJournalId(entry) !== locator.journalId || entry.externalId !== locator.entryId) return;
          matches += 1;
          if (matches > 1) return;
          if (media.length > MAX_ATTACHMENTS) {
            throw new AppError("INVALID_INPUT", "这条日记的附件超过 20 个，请先在导出包中缩小范围。", true);
          }
          const paths: string[] = [];
          for (const [index, item] of media.entries()) {
            const path = join(selectedRoot, `${index}${extname(item.fileName).toLocaleLowerCase("en-US")}`);
            await link(item.path, path);
            paths.push(path);
          }
          selected = { entry, paths, fileNames: media.map(({ fileName }) => fileName), incompleteMedia };
        }
      }, signal, undefined, (entry) => dayOneJournalId(entry) === locator.journalId && entry.externalId === locator.entryId);
      throwIfAborted(signal);
      if (targetInvalid) throw new AppError("IMPORT_INVALID_ARCHIVE", "这条待确认日记在所选 ZIP 中已损坏，无法核对。", true);
      if (matches === 0 || !selected) throw new AppError("SOURCE_UNAVAILABLE", "所选 ZIP 不含这条待确认日记，请选择原导出包。", true);
      if (matches !== 1) throw new AppError("IMPORT_INVALID_ARCHIVE", "所选 ZIP 中这条日记出现多次，无法安全确认。", false);
      if (selected.entry.contentHash === pending.sourceVersion && selected.incompleteMedia) {
        throw new AppError("SOURCE_UNAVAILABLE", "这条日记的媒体仍不完整，请重新导出包含媒体的 ZIP 后再确认。", true);
      }
      const draft = await this.prepareDraft({
        text: selected.entry.text, paths: selected.paths, fileNames: selected.fileNames,
        origin: "zip", sourceVersion: selected.entry.contentHash, sourceLocator: locator,
        sourceRecordedAt: selected.entry.creationDate, incompleteMedia: selected.incompleteMedia
      });
      sessionId = draft.sessionId;
      const changed = selected.entry.contentHash !== pending.sourceVersion;
      const result = await this.screenAndSave(draft.sessionId, commitOperationId, changed ? screening : {
        async screen() {
          return {
            decision: "include", categories: pending.categories.length ? pending.categories : ["grudge"],
            reason: `用户确认保留：${pending.reason}`, anchors: [], coverage: pending.coverage,
            policyVersion: "user-review-v1"
          };
        }
      }, signal);
      if (result.kind !== "failed") this.current().records.deletePending(id);
      return result;
    } finally {
      if (sessionId) this.abandonDraft(sessionId);
      await rm(root, { recursive: true, force: true }).catch((cause) => {
        throw new AppError("CLEANUP_FAILED", "Day One 待确认临时文件清理失败。", true, { cause });
      });
    }
  }

  async resolvePendingFromLegacyWorkspace(
    id: string,
    source: LegacyMigrationSourcePort,
    screening: ScreeningPort,
    operationId: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ScreenAndSaveResult> {
    let release: (() => void) | undefined;
    try {
      release = this.claimPending(id);
      return await this.resolvePendingFromLegacyWorkspaceUnlocked(id, source, screening, operationId, signal);
    } finally {
      if (release) release();
      else await source.close();
    }
  }

  private async resolvePendingFromLegacyWorkspaceUnlocked(
    id: string, source: LegacyMigrationSourcePort, screening: ScreeningPort,
    operationId: string, signal: AbortSignal
  ): Promise<ScreenAndSaveResult> {
    let temporaryRoot: string | undefined;
    let sessionId: string | undefined;
    try {
      const records = this.current().records;
      const commitOperationId = deterministicUuid(`pending-legacy:${id}:${operationId}`);
      const existing = records.findOperation(commitOperationId);
      if (existing) {
        const stillPending = records.getPending(id);
        if (existing.kind !== "failed" && stillPending?.origin === "migration") records.deletePending(id);
        return existing;
      }
      const pending = records.getPending(id);
      if (!pending || pending.origin !== "migration" || !pending.originLocator) {
        throw new AppError("ENTITY_NOT_FOUND", "请选择一条来自旧工作区的待确认项。");
      }
      let locator: { connectorId: string; journalId: "events" | "source_items"; entryId: string };
      try {
        const parsed = JSON.parse(pending.originLocator) as Record<string, unknown>;
        if (parsed.connectorId !== `legacy:${source.sourceWorkspaceId}`
          || (parsed.journalId !== "events" && parsed.journalId !== "source_items")
          || typeof parsed.entryId !== "string") throw new Error("Invalid legacy source locator.");
        locator = { connectorId: parsed.connectorId, journalId: parsed.journalId, entryId: parsed.entryId };
      } catch (cause) {
        throw new AppError("SOURCE_UNAVAILABLE", "所选旧工作区不是这条待确认项的来源。", true, { cause });
      }

      temporaryRoot = await this.transientDirectory("pending-legacy-");
      let matches = 0;
      let selected: LegacyMigrationEntry | undefined;
      await source.scan(async (entry) => {
        throwIfAborted(signal);
        if ((entry.sourceCollection ?? "events") !== locator.journalId || entry.legacyEntityId !== locator.entryId) return;
        matches += 1;
        if (matches > 1) return;
        if (entry.paths.length > MAX_ATTACHMENTS) {
          throw new AppError("INVALID_INPUT", "旧记录的附件超过 20 个，无法安全确认。", true);
        }
        const retainedPaths: string[] = [];
        for (const [index, path] of entry.paths.entries()) {
          const fileName = entry.fileNames[index] ?? basename(path);
          const retainedPath = join(temporaryRoot!, `${index}${extname(fileName).toLocaleLowerCase("en-US")}`);
          await link(path, retainedPath);
          retainedPaths.push(retainedPath);
        }
        selected = { ...entry, paths: retainedPaths };
      }, signal, { sourceCollection: locator.journalId, legacyEntityId: locator.entryId });
      throwIfAborted(signal);
      if (matches === 0 || !selected) {
        throw new AppError("SOURCE_UNAVAILABLE", "所选旧工作区不含这条待确认记录。", true);
      }
      if (matches !== 1) {
        throw new AppError("WORKSPACE_INVALID", "旧工作区中这条来源出现多次，无法安全确认。", false);
      }
      if (selected.sourceVersion === pending.sourceVersion && selected.incompleteMedia) {
        throw new AppError("SOURCE_UNAVAILABLE", "旧记录的媒体仍不完整；请先修复旧来源，或重新提供完整内容作为手动记录。", true);
      }
      const draft = await this.prepareDraft({
        text: selected.text, paths: selected.paths, fileNames: selected.fileNames,
        origin: "migration", sourceVersion: selected.sourceVersion, sourceLocator: locator,
        sourceRecordedAt: selected.recordedAt, incompleteMedia: selected.incompleteMedia,
        legacyMigration: {
          sourceWorkspaceId: source.sourceWorkspaceId,
          legacyEntityId: selected.legacyEntityId,
          projectedTitle: selected.title,
          projectedOccurredAt: selected.occurredAt,
          revisions: selected.revisions
        }
      });
      sessionId = draft.sessionId;
      const changed = selected.sourceVersion !== pending.sourceVersion;
      const result = await this.screenAndSave(draft.sessionId, commitOperationId, changed ? screening : {
        async screen() {
          return {
            decision: "include", categories: pending.categories.length ? pending.categories : ["grudge"],
            reason: `用户确认保留：${pending.reason}`, anchors: [], coverage: pending.coverage,
            policyVersion: "user-review-v1"
          };
        }
      }, signal);
      if (result.kind !== "failed") records.deletePending(id);
      return result;
    } finally {
      if (sessionId) this.abandonDraft(sessionId);
      try { await source.close(); }
      finally {
        if (temporaryRoot) {
          await rm(temporaryRoot, { recursive: true, force: true }).catch((cause) => {
            throw new AppError("CLEANUP_FAILED", "旧工作区待确认临时文件清理失败。", true, { cause });
          });
        }
      }
    }
  }

  listTimeline(filter: TimelineFilter): TimelinePage { return this.current().records.listTimeline(filter); }

  getRecord(id: string): EventRecordDetail {
    const detail = this.current().records.getRecord(id);
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "记录不存在。");
    return detail;
  }

  async patchFields(recordId: string, expectedRevision: number, patch: Partial<Record<FieldOverride["fieldKey"], unknown>>): Promise<EventRecordDetail> {
    const workspace = this.current(), epoch = this.transientEpoch;
    const detail = workspace.records.patchFields(recordId, expectedRevision, patch, new Date().toISOString());
    this.searchProjectionRevision += 1;
    await this.refreshSearchIndexAfterCommit();
    this.assertWorkspaceStillActive(workspace, epoch);
    return detail;
  }

  reanalyze(recordId: string, expectedRevision: number): string {
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const result = this.current().records.enqueueAnalysis(recordId, expectedRevision, jobId, now);
    this.searchProjectionRevision += 1;
    return result;
  }

  search(query: RecordSearchQuery): RecordSearchPage { return this.current().records.search(query); }

  async importDayOneZip(
    archivePath: string,
    importer: DayOneScreeningImporterPort,
    screening: ScreeningPort,
    signal: AbortSignal = new AbortController().signal,
    onProgress?: (value: ScreenedZipImportCounters) => void,
    beforeItem?: (signal: AbortSignal) => Promise<void>
  ): Promise<ScreenedZipImportSummary> {
    if (!isAbsolute(archivePath)) throw new AppError("INVALID_INPUT", "Day One ZIP 路径无效。");
    this.current();
    const epoch = this.transientEpoch;
    const controller = new AbortController();
    this.activeZipImports.add(controller);
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    const waitBeforeItem = async () => {
      throwIfAborted(operationSignal);
      await beforeItem?.(operationSignal);
      throwIfAborted(operationSignal);
      if (epoch !== this.transientEpoch) throw new AppError("IMPORT_CANCELLED", "工作区会话已变化，本次导入已停止。", true);
    };
    let root: string | undefined;
    const counts = { included: 0, skipped: 0, review: 0, failed: 0, issueCount: 0 };
    const notifyProgress = () => {
      // Aggregate observers must not change admission decisions or retain inputs.
      try { onProgress?.({ ...counts }); } catch { /* Progress is best-effort, not a write prerequisite. */ }
    };
    try {
      throwIfAborted(operationSignal);
      root = await this.transientDirectory("screened-zip-");
      notifyProgress();
      const report = await importer.scanArchive(archivePath, root, {
        onIssue: async (issue) => {
          await waitBeforeItem();
          counts.issueCount += 1;
          if (issue.code === "DAYONE_ENTRY_INVALID") counts.failed += 1;
          notifyProgress();
        },
        onProgress: () => undefined,
        onEntry: async (entry, media, incompleteMedia) => {
          await waitBeforeItem();
          const locator = {
            connectorId: "dayone-zip",
            journalId: dayOneJournalId(entry),
            entryId: entry.externalId
          };
          const operationId = deterministicUuid(`zip:${locator.journalId}:${entry.externalId}:${entry.contentHash}`);
          let sessionId: string | undefined;
          try {
            const draft = await this.prepareDraft({
              text: entry.text,
              paths: media.map(({ path }) => path),
              fileNames: media.map(({ fileName }) => fileName),
              origin: "zip",
              sourceVersion: entry.contentHash,
              sourceLocator: locator,
              sourceRecordedAt: entry.creationDate,
              incompleteMedia
            });
            sessionId = draft.sessionId;
            const result = await this.screenAndSave(draft.sessionId, operationId, screening, operationSignal);
            throwIfAborted(operationSignal);
            if (result.kind === "saved") counts.included += 1;
            else if (result.kind === "skipped") counts.skipped += 1;
            else if (result.kind === "needs_review") counts.review += 1;
            else counts.failed += 1;
          } catch (error) {
            throwIfAborted(operationSignal);
            if (error instanceof AppError && error.code === "INVALID_INPUT") {
              if (!incompleteMedia) counts.issueCount += 1;
              if (incompleteMedia || entry.media.length > 0) {
                await this.createSourceOnlyPending(entry, locator, operationId);
                counts.review += 1;
              } else {
                counts.failed += 1;
              }
            } else {
              throw error;
            }
          } finally {
            notifyProgress();
            if (sessionId) this.abandonDraft(sessionId);
          }
        }
      }, operationSignal);
      throwIfAborted(operationSignal);
      return { ...counts, ...report };
    } catch (error) {
      if (operationSignal.aborted) {
        throw new AppError("IMPORT_CANCELLED", "已停止本次导入；此前完成筛选的正式记录仍保留，重新选择同一 ZIP 可继续检查。", true);
      }
      throw error;
    } finally {
      this.activeZipImports.delete(controller);
      if (root) await rm(root, { recursive: true, force: true }).catch((cause) => {
        throw new AppError("CLEANUP_FAILED", "Day One 临时筛选文件清理失败。", true, { cause });
      });
    }
  }

  async migrateLegacyWorkspace(
    source: LegacyMigrationSourcePort,
    screening: ScreeningPort,
    signal: AbortSignal = new AbortController().signal
  ): Promise<LegacyMigrationSummary> {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    const epoch = this.transientEpoch;
    this.activeLegacyMigrations.add(controller);
    const counts = { included: 0, skipped: 0, review: 0, failed: 0 };
    let total = 0;
    try {
      throwIfAborted(operationSignal);
      const workspace = this.current();
      const assertCurrent = () => {
        throwIfAborted(operationSignal);
        if (epoch !== this.transientEpoch || this.current().records !== workspace.records) {
          throw new AppError("IMPORT_CANCELLED", "工作区会话已变化，本次旧工作区迁移已停止。", true);
        }
      };
      assertCurrent();
      total = await source.scan(async (entry) => {
        assertCurrent();
        let sessionId: string | undefined;
        const operationId = deterministicUuid(
          `migration:${source.sourceWorkspaceId}:${entry.legacyEntityId}:${entry.sourceVersion}`
        );
        const journalId = entry.sourceCollection ?? "events";
        try {
          const draft = await this.prepareDraft({
            text: entry.text,
            paths: entry.paths,
            fileNames: entry.fileNames,
            origin: "migration",
            sourceVersion: entry.sourceVersion,
            sourceLocator: {
              connectorId: `legacy:${source.sourceWorkspaceId}`,
              journalId,
              entryId: entry.legacyEntityId
            },
            sourceRecordedAt: entry.recordedAt,
            incompleteMedia: entry.incompleteMedia,
            legacyMigration: {
              sourceWorkspaceId: source.sourceWorkspaceId,
              legacyEntityId: entry.legacyEntityId,
              projectedTitle: entry.title,
              projectedOccurredAt: entry.occurredAt,
              revisions: entry.revisions
            }
          }, operationSignal);
          sessionId = draft.sessionId;
          assertCurrent();
          const result = await this.screenAndSave(
            draft.sessionId,
            operationId,
            screening,
            operationSignal
          );
          assertCurrent();
          if (result.kind === "saved") counts.included += 1;
          else if (result.kind === "skipped") counts.skipped += 1;
          else if (result.kind === "needs_review") counts.review += 1;
          else counts.failed += 1;
        } catch (error) {
          // Cancelled or superseded input is not an unreadable old source to preserve for review.
          assertCurrent();
          if (error instanceof AppError && ["INVALID_INPUT", "SOURCE_UNAVAILABLE"].includes(error.code)) {
            const now = new Date().toISOString();
            workspace.records.createPending({
              id: randomUUID(), origin: "migration", originLocator: JSON.stringify({
                connectorId: `legacy:${source.sourceWorkspaceId}`,
                journalId,
                entryId: entry.legacyEntityId
              }), sourceVersion: entry.sourceVersion,
              excerpt: truncateCodePoints(entry.text || entry.title || "旧记录的媒体无法完整检查", EXCERPT_LIMIT),
              reason: "旧记录含无法完整检查或安全迁移的内容，需要重新提供原件后人工确认。",
              categories: [], coverage: "partial", sessionAvailable: false, createdAt: now, updatedAt: now
            }, operationId);
            counts.review += 1;
          } else {
            throw error;
          }
        } finally {
          if (sessionId) this.abandonDraft(sessionId);
        }
      }, operationSignal);
      assertCurrent();
      return { total, ...counts };
    } finally {
      this.activeLegacyMigrations.delete(controller);
      await source.close();
    }
  }

  async runAnalysis(
    recordId: string,
    expectedRevision: number,
    analyzer: ReportAnalysisPort,
    deferFailure = false,
    analysisRunId?: string,
    signal?: AbortSignal,
    onProgress?: (value: NativeMediaProgress) => void
  ): Promise<EventRecordDetail> {
    throwIfAborted(signal);
    const workspace = this.current(), epoch = this.transientEpoch;
    const detail = workspace.records.markAnalysisRunning(recordId, expectedRevision, new Date().toISOString());
    this.searchProjectionRevision += 1;
    let saved: EventRecordDetail;
    try {
      const result = await analyzer.analyze({
        record: detail.record, source: detail.source, attachments: detail.attachments, overrides: detail.overrides
      }, signal, onProgress);
      throwIfAborted(signal);
      this.assertWorkspaceStillActive(workspace, epoch);
      const now = new Date().toISOString();
      const report: AnalysisReport = {
        id: randomUUID(), recordId, recordRevision: expectedRevision,
        ...(analysisRunId ? { analysisRunId } : {}),
        inputHash: inputHash(detail.source.text ?? "", detail.attachments),
        promptVersion: result.promptVersion, modelProfile: result.modelProfile,
        content: result.content, state: result.state, createdAt: now, updatedAt: now
      };
      saved = workspace.records.saveReport(report);
      this.searchProjectionRevision += 1;
    } catch (error) {
      const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      if (!deferFailure) {
        this.assertWorkspaceStillActive(workspace, epoch);
        workspace.records.failReport(recordId, expectedRevision, code, new Date().toISOString());
        this.searchProjectionRevision += 1;
      }
      throw error;
    }
    await this.refreshSearchIndexAfterCommit();
    this.assertWorkspaceStillActive(workspace, epoch);
    return saved;
  }

  failAnalysis(recordId: string, expectedRevision: number, errorCode: string): EventRecordDetail {
    return this.current().records.failReport(recordId, expectedRevision, errorCode, new Date().toISOString());
  }

  private async commitIncluded(
    session: IntakeSession, operationId: string, screening: ScreeningResult, signal?: AbortSignal
  ): Promise<ScreenAndSaveResult> {
    throwIfAborted(signal);
    this.assertDraftStillActive(session);
    const workspace = this.current();
    if (session.sourceLocator) {
      const existing = workspace.records.findRecordBySource(
        session.sourceLocator.connectorId,
        session.sourceLocator.journalId,
        session.sourceLocator.entryId
      );
      if (existing?.source.sourceVersion === session.sourceVersion) {
        this.sessions.delete(session.id);
        return { kind: "saved", recordId: existing.record.id, reportState: "queued" };
      }
    }
    const key: VaultKey = workspace.keyRing ?? workspace.key;
    const attachments: Asset[] = [];
    const assetIdByTemporaryRef = new Map<string, string>();
    const assetIdByHash = new Map<string, string>();
    const newlyStored: string[] = [];
    let committed: EventRecord;
    try {
      for (const media of session.media) {
        throwIfAborted(signal);
        this.assertDraftStillActive(session);
        const expectedHash = session.verifiedMediaHashes?.get(media.id);
        if (!expectedHash) throw new AppError("SOURCE_UNAVAILABLE", "附件尚未完成一致性检查，请重新筛选。", true);
        const stored = media.bytes
          ? await workspace.vault.putStream(Readable.from([Buffer.from(media.bytes)]), key, media.byteSize)
          : await workspace.vault.put(media.path!, key);
        if (!stored.deduplicated) newlyStored.push(stored.sha256);
        if (stored.sha256 !== expectedHash || stored.byteSize !== media.byteSize) {
          throw new AppError("SOURCE_UNAVAILABLE", "附件在筛选后发生变化，请重新选择后再试。", true);
        }
        const assetId = assetIdByHash.get(stored.sha256)
          ?? workspace.assets.findBySha256(stored.sha256)?.id ?? randomUUID();
        assetIdByHash.set(stored.sha256, assetId);
        assetIdByTemporaryRef.set(media.id, assetId);
        if (!attachments.some(({ sha256 }) => sha256 === stored.sha256)) {
          attachments.push({
            id: assetId, sha256: stored.sha256, byteSize: stored.byteSize, mimeType: media.mimeType,
            originalFileName: media.fileName, vaultFormat: stored.vaultFormat, integrityStatus: "pending",
            availabilityStatus: "available", createdAt: new Date().toISOString()
          });
        }
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const record: EventRecord = {
        id, origin: session.origin, categories: screening.categories,
        title: session.legacyMigration?.projectedTitle || titleFrom(session),
        summary: truncateCodePoints(session.text.trim() || screening.reason, 180), revision: 1,
        // A date mentioned in the source may concern a contract, citation or another event.
        // Only a contextual report or explicit user field may supply new occurrence time.
        occurredAt: session.legacyMigration?.projectedOccurredAt ?? { kind: "unknown" },
        recordedAt: session.sourceRecordedAt ?? now,
        reportState: "queued", sourceUpdated: false, sourceReviewRequired: false,
        attachmentCount: attachments.length,
        createdAt: now, updatedAt: now
      };
      const source: RetainedSource = {
        id: randomUUID(), recordId: id, origin: session.origin, sourceVersion: session.sourceVersion,
        contentHash: inputHash(session.text, attachments),
        ...(session.sourceLocator ?? {}),
        ...(session.text ? { text: session.text } : {}),
        recordedAt: session.sourceRecordedAt ?? session.createdAt, createdAt: now
      };
      const retainedScreening: ScreeningResult = {
        ...screening,
        anchors: screening.anchors.map(({ temporaryMediaRef, ...anchor }) => ({
          ...anchor,
          ...(temporaryMediaRef ? { assetId: assetIdByTemporaryRef.get(temporaryMediaRef)! } : {})
        }))
      };
      throwIfAborted(signal);
      this.assertDraftStillActive(session);
      committed = workspace.records.commitRecord({
        operationId, record, source, attachments, screening: retainedScreening,
        analysisJob: { id: randomUUID(), createdAt: now },
        ...(session.legacyMigration ? { legacyMigration: session.legacyMigration } : {})
      });
      this.searchProjectionRevision += 1;
    } catch (error) {
      const cleanup = await Promise.allSettled(newlyStored.map(async (sha256) => {
        // Another commit may have started referencing an object after our upload.
        if (!workspace.assets.findBySha256(sha256)) await workspace.vault.remove(sha256);
      }));
      if (cleanup.some(({ status }) => status === "rejected")) {
        throw new AppError("CLEANUP_FAILED", "正式写入失败，且未能清理全部孤立加密对象。", true, { cause: error });
      }
      throw error;
    }
    try {
      await this.ensureSearchIndexJob();
    } catch {
      // The formal record is already committed; a derived index can be queued again on startup or by the user.
    }
    this.assertDraftStillActive(session);
    this.sessions.delete(session.id);
    return { kind: "saved", recordId: committed.id, reportState: "queued" };
  }

  private requireSession(id: string): IntakeSession {
    this.pruneExpiredSessions();
    const session = this.sessions.get(id);
    if (!session) throw new AppError("SOURCE_UNAVAILABLE", "输入会话已失效，请重新提供内容。");
    this.assertDraftStillActive(session);
    return session;
  }

  private async refreshSearchIndexAfterCommit(): Promise<void> {
    try { await this.ensureSearchIndexJob(); }
    catch {
      // A committed record/report/override is not a failed save because derived queueing failed.
      // Index generations or check jobs carry their own state and can be checked again on startup.
    }
  }

  private assertWorkspaceStillActive(workspace: RedesignSession, epoch: number): void {
    let same = false;
    try { const current = this.current(); same = current.records === workspace.records && current.vault === workspace.vault; }
    catch { /* Closed workspaces cannot publish late record/report replies. */ }
    if (!same || epoch !== this.transientEpoch) throw new AppError("SOURCE_UNAVAILABLE", "工作区会话已变化，请在当前工作区重新查看。", true);
  }

  private claimPending(id: string): () => void {
    if (this.pendingInFlight.has(id)) {
      throw new AppError("REVISION_CONFLICT", "这条待确认内容正在处理，请等待完成后再操作。", true);
    }
    const claim = Symbol(id);
    this.pendingInFlight.set(id, claim);
    return () => { if (this.pendingInFlight.get(id) === claim) this.pendingInFlight.delete(id); };
  }

  private claimSession(id: string): () => void {
    if (this.sessionInFlight.has(id)) {
      throw new AppError("REVISION_CONFLICT", "这份输入正在筛选，请等待完成后再操作。", true);
    }
    const claim = Symbol(id);
    this.sessionInFlight.set(id, claim);
    return () => { if (this.sessionInFlight.get(id) === claim) this.sessionInFlight.delete(id); };
  }

  private assertDraftStillActive(session: IntakeSession): void {
    if (this.sessions.get(session.id) !== session || this.current().records !== session.repository) {
      throw new AppError("SOURCE_UNAVAILABLE", "输入会话已失效，请重新提供内容。", true);
    }
  }

  private assertSearchStillActive(session: SearchQuerySession): void {
    if (this.searchSessions.get(session.id) !== session || session.controller.signal.aborted ||
      !this.isSearchWorkspaceCurrent(session.repository)) {
      if (this.searchSessions.get(session.id) === session) this.searchSessions.delete(session.id);
      this.abortSearchSession(session);
      throw new AppError("SOURCE_UNAVAILABLE", "搜索会话已失效，请重新提供查询内容。", true);
    }
  }

  private isSearchWorkspaceCurrent(repository: RecordRepositoryPort): boolean {
    try { return this.current().records === repository; }
    catch { return false; } // A locked or unavailable workspace cannot own a live query.
  }

  private abortSearchSession(session: SearchQuerySession): void {
    session.text = "";
    session.media = [];
    session.mediaHashes.clear();
    delete session.result;
    session.controller.abort(new AppError("SOURCE_UNAVAILABLE", "搜索会话已失效，请重新提供查询内容。", true));
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
    for (const [pendingId, sessionId] of this.pendingSessions) {
      if (!this.sessions.has(sessionId)) this.pendingSessions.delete(pendingId);
    }
    for (const [id, session] of this.searchSessions) if (Date.parse(session.expiresAt) <= now) this.abandonSearchQuery(id);
  }

  private async createSourceOnlyPending(
    entry: NormalizedDayOneEntry,
    locator: { connectorId: string; journalId: string; entryId: string },
    operationId: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const records = this.current().records;
    const prior = records.findRecordBySource(locator.connectorId, locator.journalId, locator.entryId);
    records.createPending({
      id: randomUUID(), origin: "zip", originLocator: JSON.stringify(locator), sourceVersion: entry.contentHash,
      excerpt: truncateCodePoints(entry.text || "仅含当前无法检查的媒体", EXCERPT_LIMIT),
      reason: "来源内容或媒体未能完整检查，需要重新提供可检查的原件。", categories: [], coverage: "partial",
      sessionAvailable: false, createdAt: now, updatedAt: now
    }, operationId);
    if (prior && prior.source.sourceVersion !== entry.contentHash) {
      records.markSourceChanged(prior.record.id, now);
      await this.refreshSearchIndexAfterCommit();
    }
  }
}

function manualIntakeOperationId(sessionId: string, operationId: string): string {
  return deterministicUuid(`manual-intake:${sessionId}:${operationId}`);
}

function deterministicUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function dayOneInvalidEntryDiagnosticId(entryId: string): string | undefined {
  return entryId.startsWith("uuid:")
    ? `uuid-hash:${createHash("sha256").update(entryId.slice(5)).digest("hex")}`
    : undefined;
}

function dayOneJournalId(entry: NormalizedDayOneEntry): string {
  const raw = entry.raw && typeof entry.raw === "object" ? entry.raw as Record<string, unknown> : undefined;
  const journal = raw?.journal;
  if (typeof journal === "string" && journal.trim()) return journal.trim().toLocaleLowerCase("en-US");
  if (journal && typeof journal === "object") {
    const item = journal as Record<string, unknown>;
    const id = typeof item.uuid === "string" ? item.uuid : typeof item.id === "string" ? item.id : undefined;
    if (id?.trim()) return id.trim().toLocaleLowerCase("en-US");
  }
  return "default";
}
