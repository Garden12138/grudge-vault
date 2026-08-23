import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("rejects malformed JSON, symbolic links, and configured archive limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-security-")); roots.push(root);
    const malformed = join(root, "malformed.zip");
    await createZip(malformed, [{ path: "Journal.json", bytes: Buffer.from('{"entries":[') }]);
    await expect(new DayOneZipImporter().importArchive(
      malformed, collector().consumer, new AbortController().signal
    )).rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });

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
