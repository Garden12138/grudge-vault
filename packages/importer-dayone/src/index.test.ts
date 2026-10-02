import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import type {
  DayOneImportConsumer, NormalizedDayOneEntry, NormalizedDayOneMedia
} from "@grudge-vault/application";
import { DayOneZipImporter } from "./index";

async function createZip(path: string, entries: Array<{ path: string; bytes: Buffer; mode?: number }>): Promise<void> {
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(entry.bytes, entry.path, entry.mode ? { mode: entry.mode } : undefined);
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function replaceZipEntryName(path: string, from: string, to: string): Promise<void> {
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  if (source.length !== replacement.length) throw new Error("ZIP test names must have equal byte lengths.");
  const bytes = await readFile(path);
  let offset = 0;
  let replacements = 0;
  while ((offset = bytes.indexOf(source, offset)) >= 0) {
    replacement.copy(bytes, offset);
    offset += replacement.length;
    replacements += 1;
  }
  if (replacements < 2) throw new Error("The ZIP entry name was not present in both headers.");
  await writeFile(path, bytes);
}

async function markZipEntryEncrypted(path: string): Promise<void> {
  const bytes = await readFile(path);
  for (let offset = 0; offset <= bytes.length - 10; offset += 1) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6);
    if (signature === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
  }
  await writeFile(path, bytes);
}

function collector() {
  const entries: NormalizedDayOneEntry[] = [];
  const media: Array<Omit<NormalizedDayOneMedia, "stream"> & { content: Buffer }> = [];
  const issues: Array<{ code: string; severity: string }> = [];
  const consumer: DayOneImportConsumer = {
    async onEntry(entry) { entries.push(entry); },
    async onMedia(item) {
      const chunks: Buffer[] = [];
      for await (const chunk of item.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const { stream: _stream, ...metadata } = item;
      void _stream;
      media.push({ ...metadata, content: Buffer.concat(chunks) });
    },
    async onIssue(issue) { issues.push(issue); },
    onProgress() {}
  };
  return { consumer, entries, media, issues };
}

describe("Day One ZIP importer", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("streams the existing synthetic fixture without claiming extra fields", async () => {
    const collected = collector();
    const report = await new DayOneZipImporter().importArchive(
      resolve("fixtures/dayone/synthetic-minimal.zip"), collected.consumer, new AbortController().signal
    );
    expect(report).toEqual({ totalEntries: 1, mediaEntries: 0, missingMedia: 0 });
    expect(collected.entries[0]).toMatchObject({
      externalId: "uuid:11111111-2222-4333-8444-555555555555",
      creationDate: "2025-09-15T10:30:00.000Z", journalDate: "2025-09-15",
      timeZone: "Asia/Shanghai", tags: ["synthetic"]
    });
  });

  it("imports referenced media and reports one malformed entry plus missing media without aborting", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-")); roots.push(root);
    const archive = join(root, "journal.zip");
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [
        {
          creationDate: "2025-01-02T23:04:05Z", timeZone: "Asia/Shanghai", text: "A documented event",
          photos: [{ identifier: "PHOTO-1", type: "jpeg" }, { identifier: "MISSING", type: "jpeg" }],
          unknownFutureField: { preserved: true }
        },
        { uuid: "BROKEN", creationDate: "not-a-date", text: "bad" }
      ] })) },
      { path: "photos/PHOTO-1.jpeg", bytes: Buffer.from("photo-bytes") }
    ]);
    const collected = collector();
    const report = await new DayOneZipImporter().importArchive(archive, collected.consumer, new AbortController().signal);
    expect(report).toEqual({ totalEntries: 2, mediaEntries: 1, missingMedia: 1 });
    expect(collected.entries).toHaveLength(1);
    expect(collected.entries[0]?.journalDate).toBe("2025-01-03");
    expect((collected.entries[0]?.raw as Record<string, unknown>).unknownFutureField).toEqual({ preserved: true });
    expect(collected.media[0]?.content.toString()).toBe("photo-bytes");
    expect(collected.entries[0]?.externalId).toMatch(/^fingerprint:[a-f0-9]{64}$/);
    expect(collected.issues.map(({ code }) => code).sort()).toEqual([
      "DAYONE_ENTRY_INVALID", "DAYONE_MEDIA_MISSING", "DAYONE_UUID_MISSING"
    ]);
  });

  it("does not misreport a consumer failure as a malformed Day One entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-consumer-failure-")); roots.push(root);
    const archive = join(root, "consumer-failure.zip");
    await createZip(archive, [{
      path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [{
        uuid: "VALID", creationDate: "2026-01-01T00:00:00Z", text: "valid entry"
      }] }))
    }]);
    const collected = collector();
    const failure = new Error("consumer interrupted before commit");
    await expect(new DayOneZipImporter().importArchive(archive, {
      ...collected.consumer,
      async onEntry() { throw failure; }
    }, new AbortController().signal)).rejects.toBe(failure);
    expect(collected.issues).toEqual([]);
  });

  it("reports invalid JSON entries without copying their body or UUID into diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-safe-issue-")); roots.push(root);
    const archive = join(root, "invalid-entry.zip");
    const privateUuid = "synthetic-private-entry-id-marker";
    const privateBody = "synthetic-private-entry-body-marker";
    await createZip(archive, [{
      path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [{
        uuid: privateUuid, creationDate: "not-a-date", text: privateBody
      }] }))
    }]);
    const importer = new DayOneZipImporter();
    const issues: unknown[] = [];
    await importer.importArchive(archive, {
      async onEntry() { throw new Error("invalid entry must not be consumed"); },
      async onMedia() {},
      async onIssue(issue) { issues.push(issue); },
      onProgress() {}
    }, new AbortController().signal);
    await importer.scanArchive(archive, join(root, "transient"), {
      async onEntry() { throw new Error("invalid entry must not be screened"); },
      async onIssue(issue) { issues.push(issue); },
      onProgress() {}
    }, new AbortController().signal);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual([
      expect.objectContaining({ code: "DAYONE_ENTRY_INVALID", entryExternalId: expect.stringMatching(/^uuid-hash:[a-f0-9]{64}$/) }),
      expect.objectContaining({ code: "DAYONE_ENTRY_INVALID", entryExternalId: expect.stringMatching(/^uuid-hash:[a-f0-9]{64}$/) })
    ]);
    expect(JSON.stringify(issues)).not.toContain(privateUuid);
    expect(JSON.stringify(issues)).not.toContain(privateBody);
  });

  it("previews a selected ZIP without extracting files or calling a screening consumer", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-preview-")); roots.push(root);
    const archive = join(root, "preview.zip");
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [
        { uuid: "ONE", creationDate: "2026-01-01T00:00:00Z", text: "synthetic one",
          photos: [{ identifier: "SHARED", type: "jpeg" }, { identifier: "MISSING", type: "jpeg" }],
          pdfs: [{ identifier: "DOCUMENT", type: "pdf" }] },
        { uuid: "TWO", creationDate: "2026-01-02T00:00:00Z", text: "synthetic two",
          photos: [{ identifier: "SHARED", type: "jpeg" }] },
        { uuid: "INVALID", text: "synthetic invalid" }
      ] })) },
      { path: "photos/SHARED.jpeg", bytes: Buffer.from("photo-bytes") },
      { path: "pdfs/DOCUMENT.pdf", bytes: Buffer.from("pdf-bytes") }
    ]);
    const preview = await new DayOneZipImporter().previewArchive(archive, new AbortController().signal);
    expect(preview).toEqual({
      totalEntries: 3, validEntries: 2, invalidEntries: 1, mediaReferences: 4,
      matchedMediaFiles: 1, mediaBytes: Buffer.byteLength("photo-bytes"), missingOrUnsupportedMedia: 2
    });
    expect(await readdir(root)).toEqual(["preview.zip"]);
  });

  it("counts malformed media references as uninspected instead of silently dropping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-malformed-media-")); roots.push(root);
    const archive = join(root, "malformed-media.zip");
    await createZip(archive, [{
      path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [{
        uuid: "MALFORMED-MEDIA", creationDate: "2026-01-01T00:00:00Z", text: "ordinary text",
        photos: [{}], audios: [null], attachments: [42]
      }] }))
    }]);
    const importer = new DayOneZipImporter();
    expect(await importer.previewArchive(archive, new AbortController().signal)).toMatchObject({
      totalEntries: 1, validEntries: 1, mediaReferences: 3, missingOrUnsupportedMedia: 3
    });
    const issues: string[] = [];
    let uninspected = false;
    const report = await importer.scanArchive(archive, join(root, "transient"), {
      async onEntry(entry, media, incompleteMedia) {
        expect(entry.media).toHaveLength(3);
        expect(media).toHaveLength(0);
        uninspected = incompleteMedia;
      },
      async onIssue(issue) { issues.push(issue.code); },
      onProgress() {}
    }, new AbortController().signal);
    expect(report).toMatchObject({ totalEntries: 1, mediaEntries: 0, missingMedia: 3 });
    expect(uninspected).toBe(true);
    expect(issues).toEqual(["DAYONE_MEDIA_MISSING", "DAYONE_MEDIA_MISSING", "DAYONE_MEDIA_MISSING"]);
  });

  it("extracts screening media only for the duration of each entry callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-screening-")); roots.push(root);
    const temporaryRoot = join(root, "transient");
    const archive = join(root, "journal.zip");
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [{
        uuid: "SCREEN-ME",
        creationDate: "2025-03-04T05:06:07Z",
        text: "screened before persistence",
        photos: [{ identifier: "PHOTO-1", type: "jpeg" }, { identifier: "MISSING", type: "jpeg" }],
        pdfs: [{ identifier: "DOCUMENT-1", type: "pdf" }]
      }] })) },
      { path: "photos/PHOTO-1.jpeg", bytes: Buffer.from("ephemeral-photo") },
      { path: "pdfs/DOCUMENT-1.pdf", bytes: Buffer.from("unsupported-pdf") }
    ]);

    const paths: string[] = [];
    const issues: string[] = [];
    let incompleteMedia = false;
    const report = await new DayOneZipImporter().scanArchive(archive, temporaryRoot, {
      async onEntry(entry, media, incomplete) {
        expect(entry.externalId).toBe("uuid:screen-me");
        expect(media).toHaveLength(1);
        expect(await readFile(media[0]!.path, "utf8")).toBe("ephemeral-photo");
        paths.push(media[0]!.path);
        incompleteMedia = incomplete;
      },
      async onIssue(issue) { issues.push(issue.code); },
      onProgress() {}
    }, new AbortController().signal);

    expect(report).toEqual({ totalEntries: 1, mediaEntries: 1, missingMedia: 2 });
    expect(incompleteMedia).toBe(true);
    expect(issues.sort()).toEqual(["DAYONE_MEDIA_MISSING", "DAYONE_MEDIA_UNSUPPORTED"]);
    await expect(readFile(paths[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  it("reads only the selected entry's media when reopening a reviewed ZIP source", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-selected-")); roots.push(root);
    const archive = join(root, "selected.zip");
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [
        { uuid: "UNRELATED", creationDate: "2025-03-04T05:06:07Z", text: "ordinary",
          photos: [{ identifier: "OTHER", type: "jpeg" }] },
        { uuid: "REVIEWED", creationDate: "2025-03-05T05:06:07Z", text: "reviewed",
          photos: [{ identifier: "TARGET", type: "jpeg" }] }
      ] })) },
      { path: "photos/OTHER.jpeg", bytes: Buffer.from("other-private-photo") },
      { path: "photos/TARGET.jpeg", bytes: Buffer.from("selected-photo") }
    ]);
    const seen: string[] = [];
    const report = await new DayOneZipImporter().scanArchive(archive, join(root, "transient"), {
      async onEntry(entry, media) {
        seen.push(entry.externalId);
        expect(await readFile(media[0]!.path, "utf8")).toBe("selected-photo");
      },
      async onIssue() {},
      onProgress() {}
    }, new AbortController().signal, undefined, (entry) => entry.externalId === "uuid:reviewed");
    expect(seen).toEqual(["uuid:reviewed"]);
    expect(report).toEqual({ totalEntries: 2, mediaEntries: 1, missingMedia: 0 });
  });

  it("does not guess which same-named media file belongs to a Day One entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-ambiguous-")); roots.push(root);
    const archive = join(root, "ambiguous.zip");
    const firstImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]);
    const secondImage = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x02]);
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [
        { uuid: "AMBIGUOUS", creationDate: "2025-03-04T05:06:07Z", text: "ambiguous image",
          photos: [{ fileName: "photo.jpeg" }] },
        { uuid: "EXACT", creationDate: "2025-03-05T05:06:07Z", text: "exact image",
          photos: [{ fileName: "journal-b/photos/photo.jpeg" }] }
      ] })) },
      { path: "photo.jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x03]) },
      { path: "journal-a/photos/photo.jpeg", bytes: firstImage },
      { path: "journal-b/photos/photo.jpeg", bytes: secondImage }
    ]);
    const seen: Array<{ id: string; incomplete: boolean; media: Buffer[] }> = [];
    const issues: string[] = [];
    const report = await new DayOneZipImporter().scanArchive(archive, join(root, "transient"), {
      async onEntry(entry, media, incomplete) {
        seen.push({ id: entry.externalId, incomplete,
          media: await Promise.all(media.map(({ path }) => readFile(path))) });
      },
      async onIssue(issue) { issues.push(issue.code); },
      onProgress() {}
    }, new AbortController().signal);
    expect(report).toEqual({ totalEntries: 2, mediaEntries: 1, missingMedia: 1 });
    expect(seen).toEqual([
      { id: "uuid:ambiguous", incomplete: true, media: [] },
      { id: "uuid:exact", incomplete: false, media: [secondImage] }
    ]);
    expect(issues).toEqual(["DAYONE_MEDIA_AMBIGUOUS"]);

    const legacy = collector();
    expect(await new DayOneZipImporter().importArchive(
      archive, legacy.consumer, new AbortController().signal
    )).toEqual({ totalEntries: 2, mediaEntries: 1, missingMedia: 1 });
    expect(legacy.issues.map(({ code }) => code)).toEqual(["DAYONE_MEDIA_AMBIGUOUS"]);
    expect(legacy.media).toMatchObject([{
      content: secondImage, referencedByExternalIds: ["uuid:exact"]
    }]);
  });

  it("matches identifier prefixes and nested path suffixes without accepting duplicate identifier candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-media-index-")); roots.push(root);
    const archive = join(root, "indexed.zip");
    const shared = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x21]);
    const nested = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x22]);
    await createZip(archive, [
      { path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries: [
        { uuid: "PREFIX", creationDate: "2026-01-01T00:00:00Z", photos: [{ identifier: "SCAN" }] },
        { uuid: "COMPOUND", creationDate: "2026-01-02T00:00:00Z", photos: [{ identifier: "SCAN.v2" }] },
        { uuid: "NESTED", creationDate: "2026-01-03T00:00:00Z", photos: [{ fileName: "photos/exact.jpeg" }] },
        { uuid: "DUPLICATE", creationDate: "2026-01-04T00:00:00Z", photos: [{ identifier: "DUP" }] }
      ] })) },
      { path: "journal/photos/SCAN.v2_extra.jpeg", bytes: shared },
      { path: "journal/videos/SCAN_else.jpeg", bytes: Buffer.from("not an image") },
      { path: "journal/photos/exact.jpeg", bytes: nested },
      { path: "journal/photos/DUP_1.jpeg", bytes: shared },
      { path: "journal/photos/DUP_2.jpeg", bytes: shared }
    ]);
    const importer = new DayOneZipImporter();
    expect(await importer.previewArchive(archive, new AbortController().signal)).toMatchObject({
      totalEntries: 4, validEntries: 4, mediaReferences: 4,
      matchedMediaFiles: 2, missingOrUnsupportedMedia: 1
    });
    const found: Array<{ id: string; incomplete: boolean; media: Buffer[] }> = [];
    const issues: string[] = [];
    const report = await importer.scanArchive(archive, join(root, "transient"), {
      async onEntry(entry, media, incomplete) {
        found.push({ id: entry.externalId, incomplete, media: await Promise.all(media.map(({ path }) => readFile(path))) });
      },
      async onIssue(issue) { issues.push(issue.code); },
      onProgress() {}
    }, new AbortController().signal);
    expect(report).toEqual({ totalEntries: 4, mediaEntries: 2, missingMedia: 1 });
    expect(found).toEqual([
      { id: "uuid:prefix", incomplete: false, media: [shared] },
      { id: "uuid:compound", incomplete: false, media: [shared] },
      { id: "uuid:nested", incomplete: false, media: [nested] },
      { id: "uuid:duplicate", incomplete: true, media: [] }
    ]);
    expect(issues).toEqual(["DAYONE_MEDIA_MISSING"]);
  });

  it("scans 120 same-day entries across two journals without a page or date cutoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-dense-")); roots.push(root);
    const archive = join(root, "dense.zip");
    const entries = Array.from({ length: 120 }, (_, index) => ({
      uuid: index === 0 || index === 60 ? "SHARED-ACROSS-JOURNALS" : `ENTRY-${index}`,
      creationDate: "2025-03-04T05:06:07Z",
      journal: { uuid: index < 60 ? "JOURNAL-A" : "JOURNAL-B" },
      text: `Synthetic journal entry ${index}`
    }));
    await createZip(archive, [{ path: "Journal.json", bytes: Buffer.from(JSON.stringify({ entries })) }]);
    const seen: NormalizedDayOneEntry[] = [];
    const report = await new DayOneZipImporter().scanArchive(archive, join(root, "transient"), {
      async onEntry(entry) { seen.push(entry); },
      async onIssue() { throw new Error("The dense fixture contains no malformed entries."); },
      onProgress() {}
    }, new AbortController().signal);
    expect(report).toEqual({ totalEntries: 120, mediaEntries: 0, missingMedia: 0 });
    expect(seen).toHaveLength(120);
    expect(seen.map(({ journalDate }) => journalDate)).toEqual(Array(120).fill("2025-03-04"));
    expect(seen[0]?.externalId).toBe(seen[60]?.externalId);
    expect((seen[0]?.raw as { journal: { uuid: string } }).journal.uuid).toBe("JOURNAL-A");
    expect((seen[60]?.raw as { journal: { uuid: string } }).journal.uuid).toBe("JOURNAL-B");
  });

  it("rejects malformed JSON, symbolic links, and configured archive limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-security-")); roots.push(root);
    const malformed = join(root, "malformed.zip");
    await createZip(malformed, [{ path: "Journal.json", bytes: Buffer.from('{"entries":[') }]);
    await expect(new DayOneZipImporter().importArchive(
      malformed, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const multipleJson = join(root, "multiple-json.zip");
    await createZip(multipleJson, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "OtherJournal.json", bytes: Buffer.from('{"entries":[]}') }
    ]);
    await expect(new DayOneZipImporter().scanArchive(multipleJson, join(root, "multi-transient"), {
      async onEntry() {}, async onIssue() {}, onProgress() {}
    }, new AbortController().signal)).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const finderSidecar = join(root, "finder-sidecar.zip");
    await createZip(finderSidecar, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "__MACOSX/._Journal.json", bytes: Buffer.from("finder metadata") }
    ]);
    await expect(new DayOneZipImporter().scanArchive(finderSidecar, join(root, "sidecar-transient"), {
      async onEntry() {}, async onIssue() {}, onProgress() {}
    }, new AbortController().signal)).resolves.toMatchObject({ totalEntries: 0 });

    const symlink = join(root, "symlink.zip");
    await createZip(symlink, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "photos/link.jpeg", bytes: Buffer.from("target"), mode: 0o120777 }
    ]);
    await expect(new DayOneZipImporter().importArchive(
      symlink, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const limited = join(root, "limited.zip");
    await createZip(limited, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "photos/extra.jpeg", bytes: Buffer.from("x") }
    ]);
    await expect(new DayOneZipImporter().importArchive(
      limited, collector().consumer, new AbortController().signal,
      { maxArchiveBytes: 1_000_000, maxEntries: 1, maxEntryBytes: 1_000_000, maxUncompressedBytes: 1_000_000, maxCompressionRatio: 200 }
    )).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
  });

  it("rejects missing entries, traversal, absolute, duplicate, encrypted, and high-ratio ZIP entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-adversarial-")); roots.push(root);
    const noEntries = join(root, "no-entries.zip");
    await createZip(noEntries, [{ path: "Journal.json", bytes: Buffer.from('{"metadata":{}}') }]);
    await expect(new DayOneZipImporter().importArchive(
      noEntries, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const traversal = join(root, "traversal.zip");
    await createZip(traversal, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "aa/evil.txt", bytes: Buffer.from("bad") }
    ]);
    await replaceZipEntryName(traversal, "aa/evil.txt", "../evil.txt");
    await expect(new DayOneZipImporter().importArchive(
      traversal, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const absolute = join(root, "absolute.zip");
    await createZip(absolute, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "aa/evil.txt", bytes: Buffer.from("bad") }
    ]);
    await replaceZipEntryName(absolute, "aa/evil.txt", "C:/evil.txt");
    await expect(new DayOneZipImporter().importArchive(
      absolute, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const duplicate = join(root, "duplicate.zip");
    await createZip(duplicate, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "photos/A.jpeg", bytes: Buffer.from("one") },
      { path: "photos/a.jpeg", bytes: Buffer.from("two") }
    ]);
    await expect(new DayOneZipImporter().importArchive(
      duplicate, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const encrypted = join(root, "encrypted.zip");
    await createZip(encrypted, [{ path: "Journal.json", bytes: Buffer.from('{"entries":[] }') }]);
    await markZipEntryEncrypted(encrypted);
    await expect(new DayOneZipImporter().importArchive(
      encrypted, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

    const ratio = join(root, "ratio.zip");
    await createZip(ratio, [
      { path: "Journal.json", bytes: Buffer.from('{"entries":[]}') },
      { path: "photos/bomb.bin", bytes: Buffer.alloc(2 * 1024 * 1024) }
    ]);
    await expect(new DayOneZipImporter().importArchive(
      ratio, collector().consumer, new AbortController().signal,
      { maxArchiveBytes: 10_000_000, maxEntries: 10, maxEntryBytes: 10_000_000, maxUncompressedBytes: 10_000_000, maxCompressionRatio: 2 }
    )).rejects.toMatchObject({ code: "IMPORT_LIMIT_EXCEEDED" });
  });
});
