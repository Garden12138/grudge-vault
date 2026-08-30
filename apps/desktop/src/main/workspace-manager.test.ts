import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GrudgeVaultApplication, type KeyProtectorPort, type NormalizedDayOneEntry
} from "@grudge-vault/application";
import { AgentHarness } from "@grudge-vault/agent-harness";
import type { ImportRun } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import { LocalWorkspaceManager } from "./workspace-manager";

class TestKeyProtector implements KeyProtectorPort {
  async assertAvailable(): Promise<void> {}
  async protect(key: Buffer): Promise<string> { return `test:${key.toString("base64")}`; }
  async unprotect(envelope: string): Promise<{ key: Buffer }> {
    if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
    return { key: Buffer.from(envelope.slice(5), "base64") };
  }
}

class ScopedTestKeyProtector implements KeyProtectorPort {
  constructor(private readonly scope: string) {}
  async assertAvailable(): Promise<void> {}
  async protect(key: Buffer): Promise<string> { return `${this.scope}:${key.toString("base64")}`; }
  async unprotect(envelope: string): Promise<{ key: Buffer }> {
    if (!envelope.startsWith(`${this.scope}:`)) {
      throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "Different test key store.");
    }
    return { key: Buffer.from(envelope.slice(this.scope.length + 1), "base64") };
  }
}

describe("encrypted workspace snapshots", () => {
  it("allows Finder metadata in an otherwise empty workspace directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-finder-metadata-"));
    const workspacePath = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      await mkdir(workspacePath);
      await writeFile(join(workspacePath, ".DS_Store"), "finder metadata");

      const session = await manager.create(workspacePath, "Finder Metadata Test");

      expect(session.workspace.rootPath).toBe(workspacePath);
      expect(await readdir(workspacePath)).toEqual(expect.arrayContaining([".DS_Store", "workspace.json", "db", "logs", "vault"]));
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically upgrades a v1 workspace config to a stable v2 key ring", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-config-upgrade-"));
    const workspacePath = join(root, "workspace");
    const protector = new TestKeyProtector();
    const creator = new LocalWorkspaceManager(protector, join(root, "creator-state.json"));
    try {
      await creator.create(workspacePath, "Legacy Test");
      await creator.close();
      const current = JSON.parse(await readFile(join(workspacePath, "workspace.json"), "utf8")) as {
        id: string;
        name: string;
        createdAt: string;
        updatedAt: string;
        keyProtection: { provider: "electron-safe-storage"; version: 1 };
        crypto: { keys: Array<{ envelope: string }> };
      };
      await writeFile(join(workspacePath, "workspace.json"), JSON.stringify({
        formatVersion: 1, id: current.id, name: current.name, createdAt: current.createdAt, updatedAt: current.updatedAt,
        keyProtection: current.keyProtection, keyEnvelope: current.crypto.keys[0]!.envelope
      }));

      const upgrader = new LocalWorkspaceManager(protector, join(root, "upgrader-state.json"));
      await upgrader.open(workspacePath);
      expect(upgrader.getCryptoStatus()).toMatchObject({ keyEpoch: 1, migrationState: "queued", objectFormatVersion: 2 });
      await upgrader.close();
      const upgraded = JSON.parse(await readFile(join(workspacePath, "workspace.json"), "utf8")) as {
        formatVersion: number;
        crypto: { activeKeyId: string; keys: Array<{ id: string }> };
      };
      expect(upgraded).toMatchObject({ formatVersion: 2, crypto: { activeKeyId: upgraded.crypto.keys[0]!.id } });

      const reopened = new LocalWorkspaceManager(protector, join(root, "reopened-state.json"));
      await reopened.open(workspacePath);
      expect(reopened.getCryptoStatus().activeKeyId).toBe(upgraded.crypto.activeKeyId);
      await reopened.close();
    } finally {
      await creator.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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
        conversationId: conversation.id, content: "A restorable project event", intent: "record"
      });
      expect(recorded.event).toBeDefined();

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
      const firstPerson = application.createPerson("Backup Alexander");
      const secondPerson = application.createPerson("Backup Alex");
      application.addPersonAlias({ personId: firstPerson.id, value: "Backup Alex" });
      const mergeSuggestion = application.listPersonMergeSuggestions().find(({ status }) => status === "pending")!;
      const identityMerge = application.mergePeople({
        sourcePersonId: firstPerson.id, targetPersonId: secondPerson.id, suggestionId: mergeSuggestion.id
      });
      const relation = application.createEventRelation({
        sourceEventId: recorded.event!.id, targetEventId: application.listCandidates()[0]!.event.id, kind: "similar"
      });
      application.setSemanticEnabled(true);
      const agentResult = await new AgentHarness(application).send({
        conversationId: conversation.id, content: "Record: a restorable Agent proposal"
      });
      application.saveAgentModelCallAudit({
        id: "00000000-0000-4000-8000-000000000080", runId: agentResult.run.id, sequence: 0,
        endpointOrigin: "https://model.example", model: "backup-fake", categories: ["conversation_text"],
        contextHash: agentResult.run.contextHash, status: "failed", errorCode: "AGENT_MODEL_UNAVAILABLE",
        startedAt: now, finishedAt: now
      });
      application.updateAgentSettings({
        mode: "private",
        privateEndpoint: { baseUrl: "http://127.0.0.1:11434/v1", model: "local-backup", apiKey: "backup-secret" }
      });

      const backupPath = join(root, "snapshot.gvbackup");
      const summary = await application.createBackup(backupPath);
      expect(summary.workspaceId).toBe(workspace.id);
      expect(JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"))).toMatchObject({
        formatVersion: 2, workspaceId: workspace.id
      });

      const restoredPath = join(root, "restored");
      const restored = await application.restoreBackup(backupPath, restoredPath);
      expect(restored.rootPath).toBe(restoredPath);
      expect(application.searchEvents({ text: "restorable" })[0]?.id).toBe(recorded.event!.id);
      expect(application.listMessages(conversation.id)[0]?.content).toBe("A restorable project event");
      expect(application.listAssets().map(({ id }) => id)).toEqual(expect.arrayContaining([imported.asset.id, archive.asset.id]));
      const session = manager.current()!;
      expect(await session.vault.verify(imported.asset.sha256, session.keyRing ?? session.key)).toBe(true);
      expect(await session.vault.verify(archive.asset.sha256, session.keyRing ?? session.key)).toBe(true);
      expect(application.getImportRun(importRun.id).run.state).toBe("succeeded");
      expect(application.listBackfillRuns()[0]).toMatchObject({ state: "queued", processedItems: 1 });
      expect(application.listBackfillRuns()[0]?.cursor).toBeTruthy();
      expect(application.listCandidates()[0]?.excerpt).toContain("Restorable Day One entry");
      expect(application.getPersonIdentity(secondPerson.id).identities).toHaveLength(2);
      expect(application.getPersonIdentity(secondPerson.id).activeMerges[0]?.id).toBe(identityMerge.id);
      expect(application.listEventRelations(recorded.event!.id)[0]?.id).toBe(relation.id);
      expect(application.getEmbeddingStatus()).toMatchObject({ available: false, enabled: false, state: "unavailable" });
      expect((await application.unifiedSearch({ text: "Restorable Day One", semantic: false }))
        .some(({ kind }) => kind === "journal_entry")).toBe(true);
      expect(application.listAgentRuns(conversation.id)[0]).toMatchObject({
        id: agentResult.run.id, status: "succeeded", intent: "record"
      });
      expect(application.listAgentModelCallAudits(agentResult.run.id)[0]).toMatchObject({
        model: "backup-fake", status: "failed"
      });
      expect(application.getAgentSettings().privateEndpoint).toMatchObject({
        baseUrl: "http://127.0.0.1:11434/v1", model: "local-backup", credentialConfigured: true
      });
      expect(application.getAgentCredential("private")).toBe("backup-secret");
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

  it("rebinds a locked workspace across key protectors with a passphrase recovery package", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-recovery-"));
    const workspacePath = join(root, "workspace");
    const recoveryPath = join(root, "keys.gvrecovery");
    const passphrase = "  correct horse battery staple  ";
    const source = new LocalWorkspaceManager(new ScopedTestKeyProtector("source"), join(root, "source-state.json"));
    try {
      const application = new GrudgeVaultApplication(source);
      const workspace = await application.createWorkspace(workspacePath, "Recovery Test");
      await application.importAsset(resolve("fixtures/assets/phase-zero-demo.txt"));
      const summary = await application.exportWorkspaceRecovery(recoveryPath, passphrase);
      expect(summary).toMatchObject({ workspaceId: workspace.id, keyEpoch: 1, keyCount: 1 });
      await source.close();

      const target = new LocalWorkspaceManager(new ScopedTestKeyProtector("target"), join(root, "target-state.json"));
      const targetApplication = new GrudgeVaultApplication(target);
      await expect(targetApplication.openWorkspace(workspacePath)).rejects.toMatchObject({ code: "WORKSPACE_KEY_UNAVAILABLE" });
      expect(targetApplication.getWorkspaceStatus()).toMatchObject({ status: "locked", workspaceId: workspace.id });
      await expect(targetApplication.recoverWorkspace(recoveryPath, "wrong passphrase value"))
        .rejects.toMatchObject({ code: "RECOVERY_PACKAGE_INVALID" });
      const encodedRecovery = JSON.parse(await readFile(recoveryPath, "utf8")) as {
        workspaceId: string;
        cipher: { ciphertext: string };
      };
      const wrongWorkspacePath = join(root, "wrong-workspace.gvrecovery");
      await writeFile(wrongWorkspacePath, JSON.stringify({ ...encodedRecovery, workspaceId: "00000000-0000-4000-8000-000000000099" }));
      await expect(targetApplication.recoverWorkspace(wrongWorkspacePath, passphrase))
        .rejects.toMatchObject({ code: "RECOVERY_PACKAGE_INVALID" });
      const tamperedPath = join(root, "tampered.gvrecovery");
      const ciphertext = Buffer.from(encodedRecovery.cipher.ciphertext, "base64");
      ciphertext[Math.floor(ciphertext.length / 2)]! ^= 0xff;
      await writeFile(tamperedPath, JSON.stringify({
        ...encodedRecovery, cipher: { ...encodedRecovery.cipher, ciphertext: ciphertext.toString("base64") }
      }));
      await expect(targetApplication.recoverWorkspace(tamperedPath, passphrase))
        .rejects.toMatchObject({ code: "RECOVERY_PACKAGE_INVALID" });
      const recovered = await targetApplication.recoverWorkspace(recoveryPath, passphrase);
      expect(recovered.id).toBe(workspace.id);
      const key = target.current()!.key;
      await targetApplication.lockWorkspace();
      expect([...key].every((value) => value === 0)).toBe(true);
      await target.close();
    } finally {
      await source.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
