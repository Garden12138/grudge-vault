import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GrudgeVaultApplication, type KeyProtectorPort, type NormalizedDayOneEntry
} from "@grudge-vault/application";
import type { ImportRun } from "@grudge-vault/domain";
import { LocalWorkspaceManager } from "./workspace-manager";

class TestKeyProtector implements KeyProtectorPort {
  async assertAvailable(): Promise<void> {}
  async protect(key: Buffer): Promise<string> { return `test:${key.toString("base64")}`; }
  async unprotect(envelope: string): Promise<{ key: Buffer }> {
    if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
    return { key: Buffer.from(envelope.slice(5), "base64") };
  }
}

describe("encrypted workspace snapshots", () => {
  it("restores events, sources, assets, and encrypted objects into an empty directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-backup-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    try {
      const workspacePath = join(root, "workspace");
      const workspace = await application.createWorkspace(workspacePath, "Backup Test");
      const imported = await application.importAsset(resolve("fixtures/assets/phase-zero-demo.txt"));
      const conversation = application.createConversation("Inbox");
      const recorded = await application.sendMessage({
        conversationId: conversation.id, content: "A restorable project event", createDraft: true
      });
      expect(recorded.draft).toBeDefined();

      const archive = await application.importAsset(resolve("fixtures/dayone/synthetic-minimal.zip"));
      const now = "2026-08-24T00:00:00.000Z";
      const importRun: ImportRun = {
        id: "00000000-0000-4000-8000-000000000020", archiveAssetId: archive.asset.id,
        archiveFileName: archive.asset.originalFileName, state: "succeeded", progress: 1,
        counts: { totalEntries: 2, newEntries: 2, updatedEntries: 0, skippedEntries: 0, mediaImported: 0, mediaMissing: 0, errorCount: 0 },
        createdAt: now, updatedAt: now, finishedAt: now
      };
      const sessionBeforeBackup = manager.current()!;
      sessionBeforeBackup.dayOne.createImportRun(importRun);
      for (let index = 0; index < 2; index += 1) {
        const entry: NormalizedDayOneEntry = {
          externalId: `uuid:backup-entry-${index}`, entryUuid: `BACKUP-ENTRY-${index}`,
          fingerprint: String(index + 3).repeat(64), creationDate: `2026-01-0${index + 1}T00:00:00.000Z`,
          journalDate: `2026-01-0${index + 1}`,
          modifiedDate: now, text: `Restorable Day One entry ${index}`, tags: ["backup"], media: [],
          contentHash: String(index + 5).repeat(64),
          raw: { uuid: `BACKUP-ENTRY-${index}`, creationDate: `2026-01-0${index + 1}T00:00:00.000Z` }
        };
        sessionBeforeBackup.dayOne.upsertEntry(importRun.id, entry, now);
      }
      const backfill = application.startBackfill({ importRunId: importRun.id, tags: ["backup"], batchSize: 1 });
      await application.runBackfill(backfill.id, { signal: new AbortController().signal, reportProgress() {} });
      expect(application.listBackfillRuns()[0]).toMatchObject({ state: "queued", processedItems: 1 });
      expect(application.listCandidates()).toHaveLength(1);

      const backupPath = join(root, "snapshot.gvbackup");
      const summary = await application.createBackup(backupPath);
      expect(summary.workspaceId).toBe(workspace.id);
      expect(JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"))).toMatchObject({
        formatVersion: 1, workspaceId: workspace.id
      });

      const restoredPath = join(root, "restored");
      const restored = await application.restoreBackup(backupPath, restoredPath);
      expect(restored.rootPath).toBe(restoredPath);
      expect(application.searchEvents({ text: "restorable" })[0]?.id).toBe(recorded.draft!.id);
      expect(application.listMessages(conversation.id)[0]?.content).toBe("A restorable project event");
      expect(application.listAssets().map(({ id }) => id)).toEqual(expect.arrayContaining([imported.asset.id, archive.asset.id]));
      const session = manager.current()!;
      expect(await session.vault.verify(imported.asset.sha256, session.key)).toBe(true);
      expect(await session.vault.verify(archive.asset.sha256, session.key)).toBe(true);
      expect(application.getImportRun(importRun.id).run.state).toBe("succeeded");
      expect(application.listBackfillRuns()[0]).toMatchObject({ state: "queued", processedItems: 1 });
      expect(application.listBackfillRuns()[0]?.cursor).toBeTruthy();
      expect(application.listCandidates()[0]?.excerpt).toContain("Restorable Day One entry");
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a backup whose manifest-covered database has been modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-backup-corrupt-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    try {
      await application.createWorkspace(join(root, "workspace"), "Corruption Test");
      const backupPath = join(root, "snapshot.gvbackup");
      await application.createBackup(backupPath);
      const databasePath = join(backupPath, "db", "grudge-vault.sqlite3");
      await writeFile(databasePath, Buffer.concat([await readFile(databasePath), Buffer.from("tampered")]));
      await expect(application.restoreBackup(backupPath, join(root, "restored"))).rejects.toThrow(/verification failed/i);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
