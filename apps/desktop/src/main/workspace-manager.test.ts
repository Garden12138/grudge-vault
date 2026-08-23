import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GrudgeVaultApplication, type KeyProtectorPort } from "@grudge-vault/application";
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
      expect(application.listAssets()[0]?.id).toBe(imported.asset.id);
      const session = manager.current()!;
      expect(await session.vault.verify(imported.asset.sha256, session.key)).toBe(true);
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
