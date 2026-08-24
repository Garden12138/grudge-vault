import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import {
  GrudgeVaultApplication, type WorkspaceManagerPort, type WorkspaceSession
} from "@grudge-vault/application";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import {
  runMigrations, SqliteAgentRepository, SqliteAssetRepository, SqliteDayOneRepository,
  SqliteJobRepository, SqliteMemoryRepository
} from "@grudge-vault/persistence-sqlite";
import { DayOneZipImporter } from "./index";

async function writeFixture(path: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ entries: [
    {
      uuid: "INTEGRATION-1", creationDate: "2026-01-01T10:00:00Z", modifiedDate: "2026-01-02T10:00:00Z",
      text: "A first import entry", tags: ["integration"], photos: [{ identifier: "SHARED-PHOTO", type: "jpeg" }],
      futureDayOneField: { retained: true }
    },
    {
      uuid: "INTEGRATION-2", creationDate: "2026-01-03T10:00:00Z",
      text: "A second import entry", tags: ["integration"], photos: [{ identifier: "SHARED-PHOTO", type: "jpeg" }]
    },
    { uuid: "BROKEN", text: "This private body must not enter diagnostics." }
  ] })), "export/Journal.json");
  zip.addBuffer(Buffer.from("shared encrypted media"), "export/photos/SHARED-PHOTO.jpeg");
  zip.end();
  await pipeline(zip.outputStream as Readable, createWriteStream(path));
}

describe("Day One application integration", () => {
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
