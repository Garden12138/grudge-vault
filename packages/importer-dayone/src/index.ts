import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import parserStream from "stream-json";
import pick from "stream-json/filters/pick.js";
import streamArray from "stream-json/streamers/stream-array.js";
import * as yauzl from "yauzl";
import { z } from "zod";
import {
  DEFAULT_DAYONE_IMPORT_LIMITS,
  type DayOneImporterPort,
  type DayOneImportConsumer,
  type DayOneImportLimits,
  type DayOneImportReport,
  type DayOneImportPreview,
  type DayOneMediaKind,
  type DayOneMediaReference,
  type DayOneScreeningConsumer,
  type DayOneScreeningImporterPort,
  type NormalizedDayOneEntry
} from "@grudge-vault/application";
import { AppError } from "@grudge-vault/shared";

interface ArchiveEntryInfo {
  path: string;
  canonicalPath: string;
  compressedSize: number;
  uncompressedSize: number;
  directory: boolean;
}

const rawEntrySchema = z.object({
  uuid: z.string().trim().min(1).optional(),
  creationDate: z.union([z.string(), z.number()]),
  modifiedDate: z.union([z.string(), z.number()]).optional(),
  timeZone: z.string().trim().min(1).optional(),
  text: z.string().optional(),
  tags: z.array(z.string()).optional(),
  location: z.unknown().optional(),
  photos: z.array(z.unknown()).optional(),
  videos: z.array(z.unknown()).optional(),
  audios: z.array(z.unknown()).optional(),
  pdfs: z.array(z.unknown()).optional(),
  pdfAttachments: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional()
}).passthrough();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidEntryDiagnosticId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const uuid = (value as Record<string, unknown>).uuid;
  return typeof uuid === "string" && uuid.trim()
    ? `uuid-hash:${sha256(uuid.trim().toLocaleLowerCase("en-US"))}`
    : undefined;
}

function canonicalArchivePath(value: string): string {
  if (value.includes("\0")) {
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The archive contains an unsafe absolute path.");
  }
  const normalized = value.normalize("NFC").replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The archive contains an unsafe absolute path.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The archive contains a path traversal entry.");
  }
  return posix.normalize(normalized).replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function isSymbolicLink(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function asIsoDate(value: string | number, field: string): string {
  const date = typeof value === "number"
    ? new Date(value > 10_000_000_000 ? value : value * 1_000)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} is not a valid date.`);
  return date.toISOString();
}

function journalDateFor(creationDate: string | number, instant: string, timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date(instant));
      const year = parts.find(({ type }) => type === "year")?.value;
      const month = parts.find(({ type }) => type === "month")?.value;
      const day = parts.find(({ type }) => type === "day")?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // Preserve the exported value below when a future Day One version contains an unknown zone.
    }
  }
  if (typeof creationDate === "string") {
    const exported = /^(\d{4}-\d{2}-\d{2})/.exec(creationDate)?.[1];
    if (exported) return exported;
  }
  return instant.slice(0, 10);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLocation(value: unknown): NormalizedDayOneEntry["location"] {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const location = {
    name: optionalText(item.placeName) ?? optionalText(item.name),
    locality: optionalText(item.localityName) ?? optionalText(item.locality),
    administrativeArea: optionalText(item.administrativeArea),
    country: optionalText(item.country) ?? optionalText(item.countryCode),
    latitude: optionalNumber(item.latitude),
    longitude: optionalNumber(item.longitude)
  };
  const compact = Object.fromEntries(Object.entries(location).filter(([, field]) => field !== undefined));
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function mediaObject(value: unknown, fallbackKind: DayOneMediaKind): DayOneMediaReference {
  if (typeof value === "string") return { kind: fallbackKind, fileName: value };
  // An invalid reference still represents media that was not screened. Keep it
  // so the entry is routed to review instead of being treated as text-only.
  if (!value || typeof value !== "object") return { kind: fallbackKind };
  const item = value as Record<string, unknown>;
  const rawKind = optionalText(item.kind) ?? optionalText(item.type);
  let kind = fallbackKind;
  if (rawKind && /video/i.test(rawKind)) kind = "video";
  else if (rawKind && /audio/i.test(rawKind)) kind = "audio";
  else if (rawKind && /pdf/i.test(rawKind)) kind = "pdf";
  else if (rawKind && /photo|image/i.test(rawKind)) kind = "photo";
  const reference: DayOneMediaReference = { kind };
  const identifier = optionalText(item.identifier) ?? optionalText(item.md5) ?? optionalText(item.uuid);
  const fileName = optionalText(item.fileName) ?? optionalText(item.filename) ?? optionalText(item.path);
  const type = optionalText(item.type) ?? optionalText(item.extension);
  if (identifier) reference.identifier = identifier;
  if (fileName) reference.fileName = fileName;
  if (type) reference.type = type;
  return reference;
}

function normalizeMedia(raw: z.infer<typeof rawEntrySchema>): DayOneMediaReference[] {
  const groups: Array<[unknown[] | undefined, DayOneMediaKind]> = [
    [raw.photos, "photo"], [raw.videos, "video"], [raw.audios, "audio"],
    [raw.pdfs, "pdf"], [raw.pdfAttachments, "pdf"], [raw.attachments, "photo"]
  ];
  const output: DayOneMediaReference[] = [];
  for (const [items, kind] of groups) {
    for (const item of items ?? []) {
      output.push(mediaObject(item, kind));
    }
  }
  return output;
}

function normalizeEntry(value: unknown): NormalizedDayOneEntry {
  const raw = rawEntrySchema.parse(value);
  const creationDate = asIsoDate(raw.creationDate, "creationDate");
  const modifiedDate = raw.modifiedDate === undefined ? undefined : asIsoDate(raw.modifiedDate, "modifiedDate");
  const text = raw.text ?? "";
  const tags = [...new Set((raw.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort();
  const media = normalizeMedia(raw);
  const fingerprint = sha256(stableJson({ creationDate, text, media }));
  const entryUuid = raw.uuid?.trim();
  const externalId = entryUuid ? `uuid:${entryUuid.toLocaleLowerCase("en-US")}` : `fingerprint:${fingerprint}`;
  const normalized: NormalizedDayOneEntry = {
    externalId,
    fingerprint,
    creationDate,
    journalDate: journalDateFor(raw.creationDate, creationDate, raw.timeZone),
    text,
    tags,
    media,
    contentHash: sha256(stableJson({ creationDate, modifiedDate, timeZone: raw.timeZone, text, tags, location: raw.location, media })),
    raw
  };
  if (entryUuid) normalized.entryUuid = entryUuid;
  if (modifiedDate) normalized.modifiedDate = modifiedDate;
  if (raw.timeZone) normalized.timeZone = raw.timeZone;
  const location = normalizeLocation(raw.location);
  if (location) normalized.location = location;
  return normalized;
}

function folderFor(kind: DayOneMediaKind): string {
  return kind === "photo" ? "photos" : kind === "video" ? "videos" : kind === "audio" ? "audios" : "pdfs";
}

class ArchiveMediaIndex {
  private readonly byPath = new Map<string, ArchiveEntryInfo>();
  private readonly byBasename = new Map<string, ArchiveEntryInfo[]>();
  private readonly byIdentifier = new Map<string, ArchiveEntryInfo | null>();
  private readonly suffixCache = new Map<string, ArchiveEntryInfo | "ambiguous" | null>();

  constructor(files: ArchiveEntryInfo[]) {
    const kinds: DayOneMediaKind[] = ["photo", "video", "audio", "pdf"];
    for (const file of files) {
      this.byPath.set(file.canonicalPath, file);
      const name = basename(file.canonicalPath);
      const namesakes = this.byBasename.get(name) ?? [];
      namesakes.push(file);
      this.byBasename.set(name, namesakes);
      const stem = name.replace(/\.[^.]+$/, "");
      const identifiers = new Set([stem]);
      for (let index = 1; index < stem.length; index += 1) {
        if (stem[index] === "." || stem[index] === "_") identifiers.add(stem.slice(0, index));
      }
      for (const kind of kinds) {
        if (!`/${file.canonicalPath}`.includes(`/${folderFor(kind)}/`)) continue;
        for (const identifier of identifiers) {
          const key = `${kind}\0${identifier}`;
          const previous = this.byIdentifier.get(key);
          if (previous === undefined) this.byIdentifier.set(key, file);
          else if (previous !== file) this.byIdentifier.set(key, null);
        }
      }
    }
  }

  resolve(reference: DayOneMediaReference): ArchiveEntryInfo | "ambiguous" | undefined {
    const explicit = reference.fileName ? canonicalArchivePath(reference.fileName) : undefined;
    if (explicit) {
      const exact = this.byPath.get(explicit);
      if (exact && explicit.includes("/")) return exact;
      let match = this.suffixCache.get(explicit);
      if (match === undefined) {
        match = null;
        for (const candidate of this.byBasename.get(basename(explicit)) ?? []) {
          if (candidate.canonicalPath !== explicit && !candidate.canonicalPath.endsWith(`/${explicit}`)) continue;
          if (match) { match = "ambiguous"; break; }
          match = candidate;
        }
        this.suffixCache.set(explicit, match);
      }
      if (match) return match;
    }
    const identifier = reference.identifier?.toLocaleLowerCase("en-US");
    if (!identifier) return undefined;
    return this.byIdentifier.get(`${reference.kind}\0${identifier}`) ?? undefined;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Day One import interrupted.");
}

function verifiedEntryStream(source: Readable, entry: yauzl.Entry): Readable {
  let checksum = 0;
  let byteSize = 0;
  const verified = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      byteSize += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (byteSize !== entry.uncompressedSize || (checksum >>> 0) !== (entry.crc32 >>> 0)) {
        callback(new AppError("IMPORT_INVALID_ARCHIVE", "A Day One ZIP entry failed its integrity check."));
      } else {
        callback();
      }
    }
  });
  source.on("error", (error) => verified.destroy(error));
  verified.on("close", () => source.destroy());
  return source.pipe(verified);
}

async function inspectArchive(path: string, limits: DayOneImportLimits, signal?: AbortSignal): Promise<ArchiveEntryInfo[]> {
  throwIfAborted(signal);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new AppError("IMPORT_INVALID_ARCHIVE", "The selected Day One export is not a regular file.");
  if (metadata.size > limits.maxArchiveBytes) throw new AppError("IMPORT_LIMIT_EXCEEDED", "The Day One ZIP exceeds the archive size limit.");
  let archive: yauzl.ZipFile;
  try {
    archive = await yauzl.openPromise(path, { strictFileNames: true, validateEntrySizes: true });
  } catch (cause) {
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The selected file is not a valid ZIP archive.", false, { cause });
  }
  const entries: ArchiveEntryInfo[] = [];
  const seen = new Set<string>();
  let total = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      throwIfAborted(signal);
      if (entries.length >= limits.maxEntries) throw new AppError("IMPORT_LIMIT_EXCEEDED", "The Day One ZIP has too many entries.");
      const canonicalPath = canonicalArchivePath(entry.fileName);
      if (seen.has(canonicalPath)) throw new AppError("IMPORT_INVALID_ARCHIVE", "The archive contains duplicate normalized paths.");
      seen.add(canonicalPath);
      if (entry.isEncrypted()) throw new AppError("IMPORT_INVALID_ARCHIVE", "Encrypted ZIP entries are not supported.");
      if (!entry.canDecodeFileData() || ![0, 8].includes(entry.compressionMethod)) {
        throw new AppError("IMPORT_INVALID_ARCHIVE", "The archive uses an unsupported compression method.");
      }
      if (isSymbolicLink(entry)) throw new AppError("IMPORT_INVALID_ARCHIVE", "Symbolic links are not allowed in Day One exports.");
      if (entry.uncompressedSize > limits.maxEntryBytes) throw new AppError("IMPORT_LIMIT_EXCEEDED", "An archive entry exceeds the size limit.");
      const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
      if (entry.uncompressedSize > 1_048_576 && ratio > limits.maxCompressionRatio) {
        throw new AppError("IMPORT_LIMIT_EXCEEDED", "An archive entry exceeds the compression ratio limit.");
      }
      total += entry.uncompressedSize;
      if (total > limits.maxUncompressedBytes) throw new AppError("IMPORT_LIMIT_EXCEEDED", "The archive exceeds the total expanded size limit.");
      entries.push({
        path: entry.fileName,
        canonicalPath,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        directory: entry.fileName.endsWith("/")
      });
    }
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    if (cause instanceof AppError) throw cause;
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The ZIP directory is malformed or contains an unsafe path.", false, { cause });
  } finally {
    archive.close();
  }
  return entries;
}

async function withArchiveEntry<T>(
  archivePath: string, target: string, consume: (stream: Readable) => Promise<T>, signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  const archive = await yauzl.openPromise(archivePath, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
  try {
    for await (const entry of archive.eachEntry()) {
      throwIfAborted(signal);
      if (canonicalArchivePath(entry.fileName) !== target) continue;
      const verified = verifiedEntryStream(await archive.openReadStreamPromise(entry), entry);
      try {
        return await consume(verified);
      } finally {
        verified.destroy();
      }
    }
    throw new AppError("IMPORT_INVALID_ARCHIVE", "The Day One JSON entry disappeared while reading the archive.");
  } finally {
    archive.close();
  }
}

async function verifyArchiveEntry(archivePath: string, target: string, signal: AbortSignal): Promise<void> {
  await withArchiveEntry(archivePath, target, async (source) => {
    for await (const chunk of source) {
      void chunk;
      throwIfAborted(signal);
    }
  }, signal);
}

function journalDocument(files: ArchiveEntryInfo[]): ArchiveEntryInfo {
  const jsonFiles = files.filter((entry) => entry.canonicalPath.endsWith(".json") &&
    !entry.canonicalPath.split("/").includes("__macosx"));
  if (jsonFiles.length !== 1 || !jsonFiles[0]) {
    throw new AppError("IMPORT_INVALID_ARCHIVE", "A Day One ZIP must contain exactly one journal JSON document.");
  }
  return jsonFiles[0];
}

function supportedScreeningMedia(kind: DayOneMediaKind, archivePath: string): boolean {
  const extension = extname(archivePath).toLocaleLowerCase("en-US");
  if (kind === "photo") return [".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(extension);
  if (kind === "audio") return [".mp3", ".m4a", ".wav"].includes(extension);
  if (kind === "video") return [".mp4", ".mov"].includes(extension);
  return false;
}

export class DayOneZipImporter implements DayOneImporterPort, DayOneScreeningImporterPort {
  async previewArchive(
    archivePath: string,
    signal: AbortSignal,
    limits: DayOneImportLimits = DEFAULT_DAYONE_IMPORT_LIMITS
  ): Promise<DayOneImportPreview> {
    const entries = await inspectArchive(archivePath, limits, signal);
    const files = entries.filter((entry) => !entry.directory);
    const mediaLookup = new ArchiveMediaIndex(files);
    const journal = journalDocument(files);
    await verifyArchiveEntry(archivePath, journal.canonicalPath, signal);
    const preview: DayOneImportPreview = {
      totalEntries: 0, validEntries: 0, invalidEntries: 0, mediaReferences: 0,
      matchedMediaFiles: 0, mediaBytes: 0, missingOrUnsupportedMedia: 0
    };
    const matchedFiles = new Set<string>();
    await withArchiveEntry(archivePath, journal.canonicalPath, async (source) => {
      let foundEntriesValue = false;
      const observeEntriesValue = new Transform({
        objectMode: true,
        transform(chunk: unknown, _encoding, callback) {
          foundEntriesValue = true;
          callback(null, chunk);
        }
      });
      try {
        await pipeline(
          source,
          parserStream(),
          pick.asStream({ filter: "entries", once: true }),
          observeEntriesValue,
          streamArray.asStream(),
          async (tokens: AsyncIterable<{ key: number; value: unknown }>) => {
            for await (const item of tokens) {
              throwIfAborted(signal);
              preview.totalEntries += 1;
              let normalized: NormalizedDayOneEntry;
              try {
                normalized = normalizeEntry(item.value);
              } catch {
                preview.invalidEntries += 1;
                continue;
              }
              preview.validEntries += 1;
              for (const reference of normalized.media) {
                preview.mediaReferences += 1;
                const info = mediaLookup.resolve(reference);
                if (!info || info === "ambiguous" || !supportedScreeningMedia(reference.kind, info.path)) {
                  preview.missingOrUnsupportedMedia += 1;
                  continue;
                }
                if (!matchedFiles.has(info.canonicalPath)) {
                  matchedFiles.add(info.canonicalPath);
                  preview.mediaBytes += info.uncompressedSize;
                }
              }
            }
          },
          { signal }
        );
        if (!foundEntriesValue) throw new Error("The journal JSON does not contain an entries array.");
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new AppError("IMPORT_INVALID_ARCHIVE", "The journal JSON is malformed or does not contain an entries array.", false, { cause });
      }
    }, signal);
    preview.matchedMediaFiles = matchedFiles.size;
    return preview;
  }

  async importArchive(
    archivePath: string,
    consumer: DayOneImportConsumer,
    signal: AbortSignal,
    limits: DayOneImportLimits = DEFAULT_DAYONE_IMPORT_LIMITS
  ): Promise<DayOneImportReport> {
    throwIfAborted(signal);
    const entries = await inspectArchive(archivePath, limits, signal);
    const files = entries.filter((entry) => !entry.directory);
    const mediaLookup = new ArchiveMediaIndex(files);
    const journal = journalDocument(files);
    await verifyArchiveEntry(archivePath, journal.canonicalPath, signal);
    consumer.onProgress(0.05);

    const references: Array<{ externalId: string; reference: DayOneMediaReference }> = [];
    let totalEntries = 0;
    let callbackFailure: unknown;
    await withArchiveEntry(archivePath, journal.canonicalPath, async (source) => {
      let foundEntriesValue = false;
      const observeEntriesValue = new Transform({
        objectMode: true,
        transform(chunk: unknown, _encoding, callback) {
          foundEntriesValue = true;
          callback(null, chunk);
        }
      });
      try {
        await pipeline(
          source,
          parserStream(),
          pick.asStream({ filter: "entries", once: true }),
          observeEntriesValue,
          streamArray.asStream(),
          async (tokens: AsyncIterable<{ key: number; value: unknown }>) => {
            for await (const item of tokens) {
              throwIfAborted(signal);
              totalEntries += 1;
              let normalized: NormalizedDayOneEntry;
              try {
                normalized = normalizeEntry(item.value);
              } catch {
                const diagnosticId = invalidEntryDiagnosticId(item.value);
                await consumer.onIssue({
                  severity: "error",
                  code: "DAYONE_ENTRY_INVALID",
                  ...(diagnosticId ? { entryExternalId: diagnosticId } : {}),
                  message: "The journal entry is invalid or uses unsupported fields."
                });
                consumer.onProgress(Math.min(0.55, 0.08 + totalEntries / Math.max(1_000, totalEntries + 100)));
                continue;
              }
              try {
                await consumer.onEntry(normalized);
                if (!normalized.entryUuid) {
                  await consumer.onIssue({
                    severity: "warning",
                    code: "DAYONE_UUID_MISSING",
                    entryExternalId: normalized.externalId,
                    message: "This entry has no UUID. Exact re-imports use a stable fingerprint; changed copies are imported conservatively as new entries."
                  });
                }
                for (const reference of normalized.media) references.push({ externalId: normalized.externalId, reference });
              } catch (error) {
                callbackFailure = error;
                throw error;
              }
              consumer.onProgress(Math.min(0.55, 0.08 + totalEntries / Math.max(1_000, totalEntries + 100)));
            }
          },
          { signal }
        );
        if (!foundEntriesValue) throw new Error("The journal JSON does not contain an entries array.");
      } catch (cause) {
        if (callbackFailure !== undefined) throw callbackFailure;
        if (signal.aborted) throw cause;
        throw new AppError("IMPORT_INVALID_ARCHIVE", "The journal JSON is malformed or does not contain an entries array.", false, { cause });
      }
    }, signal);

    const referencedByPath = new Map<string, { info: ArchiveEntryInfo; kind: DayOneMediaKind; externalIds: Set<string> }>();
    let missingMedia = 0;
    for (const { externalId, reference } of references) {
      const info = mediaLookup.resolve(reference);
      if (!info || info === "ambiguous") {
        missingMedia += 1;
        await consumer.onIssue({
          severity: "warning",
          code: info === "ambiguous" ? "DAYONE_MEDIA_AMBIGUOUS" : "DAYONE_MEDIA_MISSING",
          entryExternalId: externalId,
          message: info === "ambiguous"
            ? "Several archive files match one media reference; none was selected automatically."
            : "A media reference could not be matched to a file in the archive."
        });
        continue;
      }
      const current = referencedByPath.get(info.canonicalPath) ?? { info, kind: reference.kind, externalIds: new Set<string>() };
      current.externalIds.add(externalId);
      referencedByPath.set(info.canonicalPath, current);
    }

    if (referencedByPath.size > 0) {
      const archive = await yauzl.openPromise(archivePath, { strictFileNames: true, validateEntrySizes: true });
      let imported = 0;
      try {
        for await (const entry of archive.eachEntry()) {
          throwIfAborted(signal);
          const selected = referencedByPath.get(canonicalArchivePath(entry.fileName));
          if (!selected) continue;
          await consumer.onMedia({
            kind: selected.kind,
            archivePath: selected.info.path,
            fileName: basename(selected.info.path),
            referencedByExternalIds: [...selected.externalIds],
            byteSize: selected.info.uncompressedSize,
            stream: await archive.openReadStreamPromise(entry)
          });
          imported += 1;
          consumer.onProgress(0.55 + 0.45 * imported / referencedByPath.size);
        }
      } finally {
        archive.close();
      }
    }
    consumer.onProgress(1);
    return { totalEntries, mediaEntries: referencedByPath.size, missingMedia };
  }

  async scanArchive(
    archivePath: string,
    temporaryRoot: string,
    consumer: DayOneScreeningConsumer,
    signal: AbortSignal,
    limits: DayOneImportLimits = DEFAULT_DAYONE_IMPORT_LIMITS,
    filterEntry?: (entry: NormalizedDayOneEntry) => boolean
  ): Promise<DayOneImportReport> {
    throwIfAborted(signal);
    const entries = await inspectArchive(archivePath, limits, signal);
    const files = entries.filter((entry) => !entry.directory);
    const mediaLookup = new ArchiveMediaIndex(files);
    const journal = journalDocument(files);
    await verifyArchiveEntry(archivePath, journal.canonicalPath, signal);
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });

    const mediaArchive = await yauzl.openPromise(archivePath, {
      strictFileNames: true,
      validateEntrySizes: true,
      autoClose: false
    });
    const archiveEntries = new Map<string, yauzl.Entry>();
    try {
      for await (const entry of mediaArchive.eachEntry()) {
        throwIfAborted(signal);
        archiveEntries.set(canonicalArchivePath(entry.fileName), entry);
      }

      let totalEntries = 0;
      let missingMedia = 0;
      const extractedPaths = new Set<string>();
      let callbackFailure: unknown;
      consumer.onProgress(0.05);

      await withArchiveEntry(archivePath, journal.canonicalPath, async (source) => {
        let foundEntriesValue = false;
        const observeEntriesValue = new Transform({
          objectMode: true,
          transform(chunk: unknown, _encoding, callback) {
            foundEntriesValue = true;
            callback(null, chunk);
          }
        });
        try {
          await pipeline(
            source,
            parserStream(),
            pick.asStream({ filter: "entries", once: true }),
            observeEntriesValue,
            streamArray.asStream(),
            async (tokens: AsyncIterable<{ key: number; value: unknown }>) => {
              for await (const item of tokens) {
                throwIfAborted(signal);
                totalEntries += 1;
                let normalized: NormalizedDayOneEntry;
                try {
                  normalized = normalizeEntry(item.value);
                } catch {
                  const diagnosticId = invalidEntryDiagnosticId(item.value);
                  await consumer.onIssue({
                    severity: "error",
                    code: "DAYONE_ENTRY_INVALID",
                    ...(diagnosticId ? { entryExternalId: diagnosticId } : {}),
                    message: "The journal entry is invalid or uses unsupported fields."
                  });
                  continue;
                }

                if (!normalized.entryUuid) {
                  await consumer.onIssue({
                    severity: "warning",
                    code: "DAYONE_UUID_MISSING",
                    entryExternalId: normalized.externalId,
                    message: "This entry has no UUID. Exact re-imports use a stable fingerprint; changed copies are imported conservatively as new entries."
                  });
                }

                if (filterEntry && !filterEntry(normalized)) continue;

                const entryRoot = await mkdtemp(join(temporaryRoot, "entry-"));
                const transientMedia: Array<{
                  path: string;
                  fileName: string;
                  kind: DayOneMediaKind;
                  byteSize: number;
                }> = [];
                let incompleteMedia = false;
                const mediaAvailability: string[] = [];
                const mediaDigests: Array<{ path: string; sha256: string }> = [];
                const selected = new Map<string, { info: ArchiveEntryInfo; kind: DayOneMediaKind }>();
                try {
                  for (const reference of normalized.media) {
                    const info = mediaLookup.resolve(reference);
                    if (!info || info === "ambiguous") {
                      mediaAvailability.push(info === "ambiguous" ? "ambiguous" : "missing");
                      missingMedia += 1;
                      incompleteMedia = true;
                      await consumer.onIssue({
                        severity: "warning",
                        code: info === "ambiguous" ? "DAYONE_MEDIA_AMBIGUOUS" : "DAYONE_MEDIA_MISSING",
                        entryExternalId: normalized.externalId,
                        message: info === "ambiguous"
                          ? "Several archive files match one media reference; none was selected for screening."
                          : "A media reference could not be matched to a file in the archive."
                      });
                      continue;
                    }
                    if (!supportedScreeningMedia(reference.kind, info.path)) {
                      mediaAvailability.push(`unsupported:${info.canonicalPath}`);
                      missingMedia += 1;
                      incompleteMedia = true;
                      await consumer.onIssue({
                        severity: "warning",
                        code: "DAYONE_MEDIA_UNSUPPORTED",
                        entryExternalId: normalized.externalId,
                        message: "A referenced media file cannot be screened by this version and was not extracted."
                      });
                      continue;
                    }
                    mediaAvailability.push(`selected:${info.canonicalPath}`);
                    selected.set(info.canonicalPath, { info, kind: reference.kind });
                  }

                  let mediaIndex = 0;
                  for (const [canonicalPath, media] of selected) {
                    throwIfAborted(signal);
                    const archiveEntry = archiveEntries.get(canonicalPath);
                    if (!archiveEntry) {
                      missingMedia += 1;
                      incompleteMedia = true;
                      await consumer.onIssue({
                        severity: "warning",
                        code: "DAYONE_MEDIA_MISSING",
                        entryExternalId: normalized.externalId,
                        message: "A referenced media file disappeared while reading the archive."
                      });
                      continue;
                    }
                    const extension = extname(media.info.path).toLocaleLowerCase("en-US");
                    const target = join(entryRoot, `media-${mediaIndex}${extension}`);
                    mediaIndex += 1;
                    const digest = createHash("sha256");
                    const hashBytes = new Transform({
                      transform(chunk: Buffer, _encoding, callback) {
                        digest.update(chunk);
                        callback(null, chunk);
                      }
                    });
                    try {
                      await pipeline(
                        verifiedEntryStream(await mediaArchive.openReadStreamPromise(archiveEntry), archiveEntry),
                        hashBytes,
                        createWriteStream(target, { flags: "wx", mode: 0o600 }),
                        { signal }
                      );
                    } catch (error) {
                      if (signal.aborted) throw error;
                      await rm(target, { force: true });
                      missingMedia += 1;
                      incompleteMedia = true;
                      await consumer.onIssue({
                        severity: "warning",
                        code: "DAYONE_MEDIA_CORRUPT",
                        entryExternalId: normalized.externalId,
                        message: "A referenced media file failed to decompress or pass its ZIP integrity check."
                      });
                      continue;
                    }
                    mediaDigests.push({ path: canonicalPath, sha256: digest.digest("hex") });
                    extractedPaths.add(canonicalPath);
                    transientMedia.push({
                      path: target,
                      fileName: basename(media.info.path),
                      kind: media.kind,
                      byteSize: media.info.uncompressedSize
                    });
                  }

                  if (normalized.media.length > 0) {
                    normalized.contentHash = sha256(stableJson({
                      entry: normalized.contentHash,
                      availability: mediaAvailability,
                      extracted: mediaDigests.sort((left, right) => left.path.localeCompare(right.path))
                    }));
                  }

                  try {
                    await consumer.onEntry(normalized, transientMedia, incompleteMedia);
                  } catch (error) {
                    callbackFailure = error;
                    throw error;
                  }
                } finally {
                  await rm(entryRoot, { recursive: true, force: true });
                }
                consumer.onProgress(Math.min(0.98, 0.08 + totalEntries / Math.max(1_000, totalEntries + 100)));
              }
            },
            { signal }
          );
          if (!foundEntriesValue) throw new Error("The journal JSON does not contain an entries array.");
        } catch (cause) {
          if (callbackFailure !== undefined) throw callbackFailure;
          if (signal.aborted) throw cause;
          throw new AppError(
            "IMPORT_INVALID_ARCHIVE",
            "The journal JSON is malformed or does not contain an entries array.",
            false,
            { cause }
          );
        }
      }, signal);

      consumer.onProgress(1);
      return { totalEntries, mediaEntries: extractedPaths.size, missingMedia };
    } finally {
      mediaArchive.close();
    }
  }
}
