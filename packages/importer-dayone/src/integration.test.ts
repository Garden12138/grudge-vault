import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import {
  GrudgeVaultApplication, type WorkspaceManagerPort, type WorkspaceSession
} from "@grudge-vault/application";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository,
  SqliteJobRepository, SqliteMemoryRepository, SqliteRecordRepository
} from "@grudge-vault/persistence-sqlite";
import { DayOneZipImporter } from "./index";

const SKIPPED_ENTRY_MARKER = "ordinary-only-dayone-integration-marker-8c23b61a";

async function writeFixture(path: string, photoTail = 0x64): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    {
      uuid: "INTEGRATION-1", creationDate: "2026-01-01T10:00:00Z", modifiedDate: "2026-01-02T10:00:00Z",
      text: "A first import entry", tags: ["integration"], photos: [{ identifier: "SHARED-PHOTO", type: "jpeg" }],
      futureDayOneField: { retained: true }
    },
    {
      uuid: "INTEGRATION-2", creationDate: "2026-01-03T10:00:00Z",
      text: `A second import entry ${SKIPPED_ENTRY_MARKER}`, tags: ["integration"], photos: [{ identifier: "SHARED-PHOTO", type: "jpeg" }]
    },
    { uuid: "BROKEN", text: "This private body must not enter diagnostics." }
  ] })), "export/Journal.json");
  zip.addBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x73, 0x68, 0x61, 0x72, 0x65, photoTail]), "export/photos/SHARED-PHOTO.jpeg");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeManyEntriesFixture(path: string, count: number): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({
    entries: Array.from({ length: count }, (_, index) => ({
      uuid: `INTERRUPTED-${index + 1}`,
      creationDate: `2026-01-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
      text: `合成权益争议条目 ${index + 1}`
    }))
  })), "Journal.json");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeDenseMultiJournalFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({
    entries: Array.from({ length: 120 }, (_, index) => ({
      uuid: index === 0 || index === 60 ? "SHARED-UUID" : `DENSE-${index}`,
      creationDate: "2026-05-01T10:00:00Z",
      journal: { uuid: index < 60 ? "JOURNAL-A" : "JOURNAL-B" },
      text: `A first synthetic dispute from entry ${index}`
    }))
  })), "Journal.json");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeHistoricRevisionFixture(path: string, related: boolean): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [{
    uuid: "HISTORIC-2019", creationDate: "2019-04-05T10:00:00Z",
    modifiedDate: related ? "2026-09-24T10:00:00Z" : "2019-04-05T10:00:00Z",
    text: related ? "A first historical rights dispute found after editing" : "A quiet ordinary walk in 2019"
  }] })), "Journal.json");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeCorruptMediaFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    {
      uuid: "DAMAGED-PHOTO", creationDate: "2026-02-01T10:00:00Z", text: "这条日记有损坏的图片",
      photos: [{ identifier: "DAMAGED-PHOTO", type: "jpeg" }]
    },
    { uuid: "VALID-AFTER-DAMAGE", creationDate: "2026-02-02T10:00:00Z", text: "A first valid entry after damaged media" }
  ] })), "Journal.json");
  zip.addBuffer(Buffer.from("not a JPEG image"), "photos/DAMAGED-PHOTO.jpeg");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeMalformedMediaReferenceFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [{
    uuid: "MALFORMED-MEDIA-REFERENCE", creationDate: "2026-02-03T10:00:00Z",
    text: "普通日常，但导出中的图片引用无标识符", photos: [{}]
  }] })), "Journal.json");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function writeCorruptRevisionFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [{
    uuid: "INTEGRATION-1", creationDate: "2026-01-01T10:00:00Z", modifiedDate: "2026-01-02T10:00:00Z",
    text: "A first import entry", tags: ["integration"], photos: [{ identifier: "SHARED-PHOTO", type: "jpeg" }],
    futureDayOneField: { retained: true }
  }] })), "export/Journal.json");
  zip.addBuffer(Buffer.from("not a JPEG image"), "export/photos/SHARED-PHOTO.jpeg");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

async function corruptStoredZipBytes(path: string, original: Buffer, byteOffset: number): Promise<void> {
  const archive = await readFile(path);
  const offset = archive.indexOf(original);
  if (offset < 0) throw new Error("Stored ZIP fixture payload was not found.");
  archive[offset + byteOffset]! ^= 0x01;
  await writeFile(path, archive);
}

async function writeCrcCorruptMediaFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    { uuid: "CRC-BROKEN-PHOTO", creationDate: "2026-03-01T10:00:00Z", text: "", photos: [{ identifier: "CRC-PHOTO", type: "jpeg" }] },
    { uuid: "VALID-AFTER-CRC", creationDate: "2026-03-02T10:00:00Z", text: "A first valid entry after CRC damage" }
  ] })), "Journal.json");
  const media = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x61, 0x62, 0x63, 0x64]);
  zip.addBuffer(media, "photos/CRC-PHOTO.jpeg", { compress: false });
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
  await corruptStoredZipBytes(path, media, media.length - 1);
}

async function writeCrcCorruptJournalFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  const journal = Buffer.from(JSON.stringify({ entries: [
    { uuid: "CRC-BROKEN-JOURNAL", creationDate: "2026-04-01T10:00:00Z", text: "A first CRC journal entry" }
  ] }));
  zip.addBuffer(journal, "Journal.json", { compress: false });
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
  await corruptStoredZipBytes(path, journal, journal.indexOf("CRC") + 2);
}

describe("Day One application integration", () => {
  it("reselects a real ZIP to confirm one pending entry without persisting the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-zip-pending-reselect-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const archivePath = join(root, "dayone.zip");
    await writeFixture(archivePath);
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const vault = new EncryptedObjectVault(join(workspaceRoot, "vault"));
    await vault.initialize();
    const sessionKey = Buffer.alloc(32, 31);
    const session: WorkspaceSession = {
      workspace: {
        id: "00000000-0000-4000-8000-000000000104", name: "Pending ZIP integration", rootPath: workspaceRoot,
        formatVersion: 3, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z"
      },
      key: sessionKey, assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
      memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory),
      records: new SqliteRecordRepository(database, () => sessionKey), vault, async backupDatabase() {}, async close() {}
    };
    const manager: WorkspaceManagerPort = {
      current: () => session, async create() { return session; }, async open() { return session; },
      async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {}
    };
    const application = new GrudgeVaultApplication(manager, undefined, new DayOneZipImporter());
    try {
      const imported = await application.importScreenedDayOneZip(archivePath, {
        async screen(input) {
          return input.text.includes("first")
            ? { decision: "review", categories: ["rights"], reason: "需要本人确认", anchors: [],
              coverage: "partial", policyVersion: "test-v1" }
            : { decision: "skip", categories: [], reason: "普通日常",
              anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id })),
              coverage: "complete", policyVersion: "test-v1" };
        }
      });
      expect(imported).toMatchObject({ included: 0, skipped: 1, review: 1 });
      const pending = application.listPendingReviews()[0]!;
      expect(pending.sessionAvailable).toBe(false);
      const result = await application.resolvePendingReviewFromDayOneZip(pending.id, archivePath, {
        async screen() { throw new Error("The original review should be confirmed without a second model decision."); }
      }, "00000000-0000-4000-8000-000000000105");
      expect(result.kind).toBe("saved");
      expect(application.listPendingReviews()).toHaveLength(0);
      const timeline = application.listRecordTimeline({ limit: 10 }).records;
      expect(timeline).toHaveLength(1);
      expect(timeline[0]?.attachmentCount).toBe(1);
      expect(database.serialize().includes(Buffer.from(SKIPPED_ENTRY_MARKER))).toBe(false);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resumes a stopped ZIP on re-selection without duplicating committed versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-resume-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const archivePath = join(root, "ten-entries.zip");
    await writeManyEntriesFixture(archivePath, 10);
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const vault = new EncryptedObjectVault(join(workspaceRoot, "vault"));
    await vault.initialize();
    const sessionKey = Buffer.alloc(32, 9);
    const session: WorkspaceSession = {
      workspace: {
        id: "00000000-0000-4000-8000-000000000103", name: "Resume Integration", rootPath: workspaceRoot,
        formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
      },
      key: sessionKey, assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
      memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory),
      records: new SqliteRecordRepository(database, () => sessionKey), vault, async backupDatabase() {}, async close() {}
    };
    const manager: WorkspaceManagerPort = {
      current: () => session, async create() { return session; }, async open() { return session; },
      async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {}
    };
    const application = new GrudgeVaultApplication(manager, undefined, new DayOneZipImporter());
    const controller = new AbortController();
    let firstScreeningCalls = 0;
    let resumedScreeningCalls = 0;
    const include = {
      decision: "include" as const, categories: ["rights" as const], reason: "合成权益争议",
      anchors: [], coverage: "complete" as const, policyVersion: "resume-test-v1"
    };
    try {
      await expect(application.importScreenedDayOneZip(archivePath, {
        async screen() {
          firstScreeningCalls += 1;
          if (firstScreeningCalls === 7) controller.abort();
          return include;
        }
      }, controller.signal)).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
      expect(firstScreeningCalls).toBe(7);
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(6);

      const resumed = await application.importScreenedDayOneZip(archivePath, {
        async screen() { resumedScreeningCalls += 1; return include; }
      });
      expect(resumed).toMatchObject({ totalEntries: 10, included: 10, skipped: 0, failed: 0 });
      expect(resumedScreeningCalls).toBe(4);
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(10);
      expect(database.prepare("SELECT count(*) FROM redesign_sources").pluck().get()).toBe(10);
      expect(database.prepare("SELECT count(*) FROM jobs WHERE type = 'record.analyze'").pluck().get()).toBe(10);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("screens a ZIP entry-by-entry and persists only included content", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-screened-dayone-integration-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const archivePath = join(root, "dayone.zip");
    await writeFixture(archivePath);
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const vault = new EncryptedObjectVault(join(workspaceRoot, "vault"));
    await vault.initialize();
    const sessionKey = Buffer.alloc(32, 8);
    const session: WorkspaceSession = {
      workspace: {
        id: "00000000-0000-4000-8000-000000000102", name: "Screened Integration", rootPath: workspaceRoot,
        formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
      },
      key: sessionKey, assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
      memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory),
      records: new SqliteRecordRepository(database, () => sessionKey), vault, async backupDatabase() {}, async close() {}
    };
    const manager: WorkspaceManagerPort = {
      current: () => session, async create() { return session; }, async open() { return session; },
      async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {}
    };
    const importer = new DayOneZipImporter();
    const originalScan = importer.scanArchive.bind(importer);
    let temporaryRoot = "";
    vi.spyOn(importer, "scanArchive").mockImplementation(async (...args) => {
      temporaryRoot = args[1];
      return originalScan(...args);
    });
    const application = new GrudgeVaultApplication(manager, undefined, importer);
    let screened = 0;
    const screening = {
      async screen(input: import("@grudge-vault/application").ScreeningInput) {
        screened += 1;
        const include = input.text.includes("first");
        return {
          decision: include ? "include" as const : "skip" as const,
          categories: include ? ["rights" as const] : [],
          reason: include ? "related" : "ordinary",
          anchors: input.media[0] ? [{ sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0].id }] : [],
          coverage: "complete" as const,
          policyVersion: "integration-v1"
        };
      }
    };

    try {
      const first = await application.importScreenedDayOneZip(archivePath, screening);
      expect(first).toEqual({
        totalEntries: 3, included: 1, skipped: 1, review: 0, failed: 1,
        mediaEntries: 1, missingMedia: 0, issueCount: 1
      });
      expect(first.included + first.skipped + first.review + first.failed).toBe(first.totalEntries);
      expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM journal_entries").get()).toEqual({ count: 0 });
      expect(database.serialize().includes(Buffer.from(SKIPPED_ENTRY_MARKER))).toBe(false);
      expect(database.serialize().includes(Buffer.from("INTEGRATION-2"))).toBe(false);
      expect(database.serialize().includes(Buffer.from("This private body must not enter diagnostics."))).toBe(false);

      const replay = await application.importScreenedDayOneZip(archivePath, screening);
      expect(replay.included).toBe(1);
      expect(replay.failed).toBe(1);
      expect(replay.included + replay.skipped + replay.review + replay.failed).toBe(replay.totalEntries);
      expect(screened).toBe(3);
      expect(database.prepare("SELECT count(*) AS count FROM redesign_records").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM redesign_sources").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT count(*) AS count FROM jobs WHERE type = 'record.analyze'").get()).toEqual({ count: 1 });
      expect(database.serialize().includes(Buffer.from(SKIPPED_ENTRY_MARKER))).toBe(false);

      const changedMediaArchive = join(root, "dayone-media-changed.zip");
      await writeFixture(changedMediaArchive, 0x65);
      const changedMedia = await application.importScreenedDayOneZip(changedMediaArchive, screening);
      expect(changedMedia.included).toBe(1);
      expect(screened).toBe(5);
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);
      expect(database.prepare("SELECT count(*) FROM redesign_sources").pluck().get()).toBe(2);
      expect(database.prepare("SELECT count(*) FROM assets").pluck().get()).toBe(2);
      expect(database.prepare("SELECT revision FROM redesign_records").pluck().get()).toBe(2);

      const controller = new AbortController();
      let screenedBeforeStop = 0;
      await expect(application.importScreenedDayOneZip(archivePath, {
        async screen(input) {
          screenedBeforeStop += 1;
          controller.abort();
          return {
            decision: "skip", categories: [], reason: "普通日常", anchors: input.media.map(({ id }) => ({
              sourceVersion: input.sourceVersion, temporaryMediaRef: id
            })), coverage: "complete", policyVersion: "cancel-test-v1"
          };
        }
      }, controller.signal)).rejects.toMatchObject({ code: "IMPORT_CANCELLED" });
      expect(screenedBeforeStop).toBe(1);
      await expect(access(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(1);

      const corruptMediaArchive = join(root, "dayone-corrupt-photo.zip");
      await writeCorruptMediaFixture(corruptMediaArchive);
      const damaged = await application.importScreenedDayOneZip(corruptMediaArchive, screening);
      expect(damaged).toMatchObject({ totalEntries: 2, included: 1, review: 1, failed: 0, issueCount: 1 });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(2);
      expect(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get()).toBe(1);
      expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE entry_id = 'uuid:damaged-photo'").pluck().get()).toBe(0);

      const corruptRevisionArchive = join(root, "dayone-corrupt-revision.zip");
      await writeCorruptRevisionFixture(corruptRevisionArchive);
      const corruptRevision = await application.importScreenedDayOneZip(corruptRevisionArchive, screening);
      expect(corruptRevision).toMatchObject({ totalEntries: 1, included: 0, review: 1, failed: 0 });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(2);
      expect(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get()).toBe(2);
      expect(database.prepare(`
        SELECT source_updated, report_state FROM redesign_records WHERE id = (
          SELECT record_id FROM redesign_sources WHERE entry_id = 'uuid:integration-1' LIMIT 1
        )
      `).get()).toEqual({ source_updated: 1, report_state: "stale" });

      const corruptCrcMediaArchive = join(root, "dayone-bad-media-crc.zip");
      await writeCrcCorruptMediaFixture(corruptCrcMediaArchive);
      const crcMedia = await application.importScreenedDayOneZip(corruptCrcMediaArchive, screening);
      expect(crcMedia).toMatchObject({ totalEntries: 2, included: 1, review: 1, missingMedia: 1, issueCount: 1 });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(3);
      expect(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get()).toBe(3);

      const malformedMediaArchive = join(root, "dayone-malformed-media-reference.zip");
      await writeMalformedMediaReferenceFixture(malformedMediaArchive);
      const pendingBefore = Number(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get());
      const malformedScreening = {
        async screen() {
          return {
            decision: "skip" as const, categories: [], reason: "正文只是普通日常",
            anchors: [], coverage: "complete" as const, policyVersion: "malformed-media-test-v1"
          };
        }
      };
      const malformed = await application.importScreenedDayOneZip(malformedMediaArchive, malformedScreening);
      expect(malformed).toMatchObject({
        totalEntries: 1, included: 0, skipped: 0, review: 1, failed: 0,
        missingMedia: 1, issueCount: 1
      });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(3);
      expect(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get()).toBe(pendingBefore + 1);
      expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE entry_id = 'uuid:malformed-media-reference'").pluck().get()).toBe(0);
      const malformedReplay = await application.importScreenedDayOneZip(malformedMediaArchive, malformedScreening);
      expect(malformedReplay).toMatchObject({ totalEntries: 1, skipped: 0, review: 1, failed: 0 });
      expect(database.prepare("SELECT count(*) FROM redesign_pending_reviews").pluck().get()).toBe(pendingBefore + 1);

      const corruptJournalArchive = join(root, "dayone-bad-journal-crc.zip");
      await writeCrcCorruptJournalFixture(corruptJournalArchive);
      await expect(application.importScreenedDayOneZip(corruptJournalArchive, screening))
        .rejects.toMatchObject({ code: "IMPORT_INVALID_ARCHIVE" });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(3);

      const denseArchive = join(root, "dayone-dense-multi-journal.zip");
      await writeDenseMultiJournalFixture(denseArchive);
      const dense = await application.importScreenedDayOneZip(denseArchive, screening);
      expect(dense).toMatchObject({ totalEntries: 120, included: 120, skipped: 0, review: 0, failed: 0 });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(123);
      expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE journal_id = 'journal-a'").pluck().get()).toBe(60);
      expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE journal_id = 'journal-b'").pluck().get()).toBe(60);
      expect(database.prepare("SELECT count(DISTINCT record_id) FROM redesign_sources WHERE entry_id = 'uuid:shared-uuid'").pluck().get()).toBe(2);

      const historicOriginal = join(root, "historic-original.zip");
      await writeHistoricRevisionFixture(historicOriginal, false);
      const originalCheck = await application.importScreenedDayOneZip(historicOriginal, screening);
      expect(originalCheck).toMatchObject({ totalEntries: 1, included: 0, skipped: 1 });
      expect(database.prepare("SELECT count(*) FROM redesign_sources WHERE entry_id = 'uuid:historic-2019'").pluck().get()).toBe(0);
      expect(database.serialize().includes(Buffer.from("HISTORIC-2019"))).toBe(false);

      const historicEdited = join(root, "historic-edited.zip");
      await writeHistoricRevisionFixture(historicEdited, true);
      const editedCheck = await application.importScreenedDayOneZip(historicEdited, screening);
      expect(editedCheck).toMatchObject({ totalEntries: 1, included: 1, skipped: 0 });
      expect(database.prepare("SELECT count(*) FROM redesign_records").pluck().get()).toBe(124);
      expect(database.prepare("SELECT recorded_at FROM redesign_sources WHERE entry_id = 'uuid:historic-2019'").pluck().get())
        .toBe("2019-04-05T10:00:00.000Z");
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits valid entries around a bad record and reimports the same ZIP without duplicate versions or assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dayone-integration-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const archivePath = join(root, "dayone.zip");
    await writeFixture(archivePath);
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const vault = new EncryptedObjectVault(join(workspaceRoot, "vault"));
    await vault.initialize();
    const session: WorkspaceSession = {
      workspace: {
        id: "00000000-0000-4000-8000-000000000101", name: "Integration", rootPath: workspaceRoot,
        formatVersion: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z"
      },
      key: Buffer.alloc(32, 7), assets: new SqliteAssetRepository(database), jobs: new SqliteJobRepository(database),
      memory, agents: new SqliteAgentRepository(database), dayOne: new SqliteDayOneRepository(database, memory), vault,
      async backupDatabase() {}, async close() {}
    };
    const manager: WorkspaceManagerPort = {
      current: () => session, async create() { return session; }, async open() { return session; },
      async createBackup() { throw new Error("unused"); }, async restoreBackup() { return session; }, async close() {}
    };
    const application = new GrudgeVaultApplication(manager, undefined, new DayOneZipImporter());
    const context = { signal: new AbortController().signal, reportProgress() {} };

    try {
      const first = await application.createDayOneImport(archivePath);
      await application.runDayOneImport(first.id, context);
      expect(application.getImportRun(first.id).run).toMatchObject({
        state: "succeeded",
        counts: { totalEntries: 3, newEntries: 2, updatedEntries: 0, skippedEntries: 0, mediaImported: 1, mediaMissing: 0, errorCount: 1 }
      });
      expect(application.getImportRun(first.id).issues[0]).toMatchObject({ code: "DAYONE_ENTRY_INVALID" });
      expect(application.getImportRun(first.id).issues[0]?.message).not.toContain("private body");
      expect(database.prepare("SELECT count(*) AS count FROM source_versions").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT count(*) AS count FROM source_item_assets").get()).toEqual({ count: 2 });
      expect(application.listAssets()).toHaveLength(2);

      const second = await application.createDayOneImport(archivePath);
      await application.runDayOneImport(second.id, context);
      expect(application.getImportRun(second.id).run).toMatchObject({
        state: "succeeded",
        counts: { totalEntries: 3, newEntries: 0, updatedEntries: 0, skippedEntries: 2, mediaImported: 1, mediaMissing: 0, errorCount: 1 }
      });
      expect(database.prepare("SELECT count(*) AS count FROM source_versions").get()).toEqual({ count: 2 });
      expect(application.listAssets()).toHaveLength(2);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
