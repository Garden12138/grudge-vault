import { createDecipheriv, createHash, randomUUID, scryptSync } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  GrudgeVaultApplication, type KeyProtectorPort, type NormalizedDayOneEntry, type ScreeningPort
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

async function contentSnapshot(root: string, current = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) Object.assign(result, await contentSnapshot(root, path));
    else if (entry.isFile()) {
      result[path.slice(root.length + 1)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return result;
}

async function assertAbsentFromWorkspaceFiles(root: string, markers: string[]): Promise<void> {
  const relativePaths = Object.keys(await contentSnapshot(root));
  for (const relativePath of relativePaths) {
    const bytes = await readFile(join(root, relativePath));
    for (const marker of markers) {
      expect(bytes.includes(Buffer.from(marker, "utf8")), `${relativePath} retained the skipped marker`).toBe(false);
    }
  }
}

describe("workspace security settings", () => {
  it("keeps a newer policy when a delayed open refreshes its key envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-open-policy-race-"));
    const workspace = join(root, "workspace");
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdOpen = false;
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { return `test:${key.toString("base64")}`; },
      async unprotect(envelope) {
        const encoded = envelope.startsWith("test-refreshed:") ? envelope.slice(15)
          : envelope.startsWith("test:") ? envelope.slice(5) : undefined;
        if (!encoded) throw new Error("invalid envelope");
        if (holdOpen) {
          holdOpen = false; entered(); await held;
          return { key: Buffer.from(encoded, "base64"), refreshedEnvelope: `test-refreshed:${encoded}` };
        }
        return { key: Buffer.from(encoded, "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic policy refresh workspace");
      holdOpen = true;
      const opening = manager.open(workspace);
      await waiting;
      await manager.updateSecuritySettings({ autoLockMinutes: 60, integrityScanIntervalDays: 30 });
      release();
      await opening;
      expect(manager.getSecuritySettings().autoLockMinutes).toBe(60);
      expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
        security: { autoLockMinutes: 60, integrityScanIntervalDays: 30 },
        crypto: { keys: [{ envelope: expect.stringMatching(/^test-refreshed:/) }] }
      });
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a delayed open after the workspace key set changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-open-key-race-"));
    const workspace = join(root, "workspace");
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdOpen = false;
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { return `test:${key.toString("base64")}`; },
      async unprotect(envelope) {
        if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
        if (holdOpen) { holdOpen = false; entered(); await held; }
        return { key: Buffer.from(envelope.slice(5), "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic key race workspace");
      const active = manager.current();
      holdOpen = true;
      const opening = manager.open(workspace);
      const outcome = opening.then(() => "opened", (cause: AppError) => cause.code);
      await waiting;
      const rotation = await manager.prepareKeyRotation();
      expect(rotation.migrationState).toBe("queued");
      release();
      expect(await outcome).toBe("WORKSPACE_LOCKED");
      expect(manager.current()).toBe(active);
      expect(manager.getCryptoStatus().migrationState).toBe("queued");
      expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
        crypto: { pendingKeyId: rotation.activeKeyId, migrationState: "queued" }
      });
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the active policy after a failed write, cleans its temporary file and serializes later saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-security-save-"));
    const workspace = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic security workspace");
      const configPath = join(workspace, "workspace.json");
      const original = await readFile(configPath);
      await rm(configPath);
      await mkdir(configPath);
      await expect(manager.updateSecuritySettings({ autoLockMinutes: 0, integrityScanIntervalDays: 30 })).rejects.toThrow();
      expect(manager.getSecuritySettings()).toEqual({ autoLockMinutes: 15, integrityScanIntervalDays: 30 });
      expect((await readdir(workspace)).filter((name) => name.startsWith("workspace.json.") && name.endsWith(".tmp"))).toEqual([]);
      await rm(configPath, { recursive: true });
      await writeFile(configPath, original);
      await Promise.all([
        manager.updateSecuritySettings({ autoLockMinutes: 30, integrityScanIntervalDays: 30 }),
        manager.updateSecuritySettings({ autoLockMinutes: 60, integrityScanIntervalDays: 30 })
      ]);
      expect(manager.getSecuritySettings()).toEqual({ autoLockMinutes: 60, integrityScanIntervalDays: 30 });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        security: { autoLockMinutes: 60, integrityScanIntervalDays: 30 }
      });
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not lose an idle-lock change while a key rotation is waiting for system protection", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-security-rotation-"));
    const workspace = join(root, "workspace");
    let pauseProtection = false;
    let entered!: () => void; let release!: () => void;
    const protecting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) {
        if (pauseProtection) { pauseProtection = false; entered(); await held; }
        return `test:${key.toString("base64")}`;
      },
      async unprotect(envelope) {
        if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
        return { key: Buffer.from(envelope.slice(5), "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic rotation workspace");
      pauseProtection = true;
      const rotation = manager.prepareKeyRotation();
      await protecting;
      const change = manager.updateSecuritySettings({ autoLockMinutes: 60, integrityScanIntervalDays: 30 });
      release();
      const [prepared] = await Promise.all([rotation, change]);
      expect(prepared.migrationState).toBe("queued");
      expect(manager.getSecuritySettings().autoLockMinutes).toBe(60);
      expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
        security: { autoLockMinutes: 60, integrityScanIntervalDays: 30 },
        crypto: { pendingKeyId: prepared.activeKeyId, migrationState: "queued" }
      });
      await manager.completeKeyRotation(prepared.activeKeyId);
      expect(manager.getSecuritySettings().autoLockMinutes).toBe(60);
      await manager.close();
      const reopened = new LocalWorkspaceManager(protector, join(root, "reopen-state.json"));
      try {
        await reopened.open(workspace);
        expect(reopened.getSecuritySettings().autoLockMinutes).toBe(60);
        expect(reopened.getCryptoStatus().migrationState).toBe("idle");
      } finally { await reopened.close(); }
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not commit a pending key rotation after the workspace locks during protection", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-lock-during-rotation-"));
    const workspace = join(root, "workspace");
    let entered!: () => void; let release!: () => void;
    const protecting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pauseProtection = false;
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) {
        if (pauseProtection) { pauseProtection = false; entered(); await held; }
        return `test:${key.toString("base64")}`;
      },
      async unprotect(envelope) {
        if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
        return { key: Buffer.from(envelope.slice(5), "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic lock-during-rotation workspace");
      pauseProtection = true;
      const rotation = manager.prepareKeyRotation();
      await protecting;
      await manager.lock();
      release();
      await expect(rotation).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
      expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
        crypto: { migrationState: "idle", keyEpoch: 1 }
      });
      await manager.unlock();
      expect(manager.getCryptoStatus().migrationState).toBe("idle");
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("workspace opening order", () => {
  it("keeps the later workspace when an earlier open returns from key protection afterward", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-open-order-"));
    const firstPath = join(root, "first"); const secondPath = join(root, "second");
    const seed = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "seed-state.json"));
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdFirst = false;
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { return `test:${key.toString("base64")}`; },
      async unprotect(envelope) {
        if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
        if (holdFirst) { holdFirst = false; entered(); await held; }
        return { key: Buffer.from(envelope.slice(5), "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "open-state.json"));
    try {
      await seed.create(firstPath, "First synthetic workspace");
      await seed.create(secondPath, "Second synthetic workspace");
      await seed.close();
      holdFirst = true;
      const earlier = manager.open(firstPath).then(() => "opened", (cause: AppError) => cause.code);
      await waiting;
      await manager.open(secondPath);
      release();
      expect(await earlier).toBe("WORKSPACE_LOCKED");
      expect(manager.status()).toMatchObject({ status: "open", workspace: { rootPath: secondPath } });
      expect(manager.current()?.workspace.rootPath).toBe(secondPath);
    } finally {
      release();
      await seed.close();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let an older backup restore replace a later workspace selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-restore-order-"));
    const firstPath = join(root, "first"); const secondPath = join(root, "second");
    const backupPath = join(root, "snapshot.gvbackup"); const restoredPath = join(root, "restored");
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holdRestore = false;
    const protector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { return `test:${key.toString("base64")}`; },
      async unprotect(envelope) {
        if (!envelope.startsWith("test:")) throw new Error("invalid envelope");
        if (holdRestore) { holdRestore = false; entered(); await held; }
        return { key: Buffer.from(envelope.slice(5), "base64") };
      }
    };
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    try {
      await manager.create(firstPath, "First synthetic workspace");
      await manager.createBackup(backupPath);
      await manager.create(secondPath, "Second synthetic workspace");
      holdRestore = true;
      const earlier = manager.restoreBackup(backupPath, restoredPath).then(() => "restored", (cause: AppError) => cause.code);
      await waiting;
      await manager.open(secondPath);
      release();
      expect(await earlier).toBe("WORKSPACE_LOCKED");
      expect(manager.current()?.workspace.rootPath).toBe(secondPath);
      await expect(access(restoredPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not clear a newly opened workspace when an older close finishes late", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-close-order-"));
    const firstPath = join(root, "first"); const secondPath = join(root, "second");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      await manager.create(firstPath, "First synthetic workspace");
      const first = manager.current()!;
      const originalClose = first.close;
      first.close = async () => { entered(); await held; await originalClose(); };
      const closing = manager.close();
      await waiting;
      const opening = manager.create(secondPath, "Second synthetic workspace");
      release();
      await Promise.all([closing, opening]);
      expect(manager.current()?.workspace.rootPath).toBe(secondPath);
      expect(manager.getSecuritySettings().autoLockMinutes).toBe(15);
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes an outgoing session only once across overlapping workspace handoffs", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-handoff-order-"));
    const firstPath = join(root, "first"); const secondPath = join(root, "second"); const thirdPath = join(root, "third");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    let entered!: () => void; let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      await manager.create(firstPath, "First synthetic workspace");
      const first = manager.current()!;
      const originalClose = first.close;
      let closeCalls = 0;
      first.close = async () => {
        closeCalls += 1;
        if (closeCalls > 1) throw new Error("Outgoing workspace closed twice");
        entered(); await held; await originalClose();
      };
      const second = manager.create(secondPath, "Second synthetic workspace");
      await waiting;
      const third = manager.create(thirdPath, "Third synthetic workspace");
      release();
      await Promise.all([second, third]);
      expect(closeCalls).toBe(1);
      expect(manager.current()?.workspace.rootPath).toBe(thirdPath);
      expect(JSON.parse(await readFile(join(root, "state.json"), "utf8"))).toEqual({ recentWorkspacePath: thirdPath });
    } finally {
      release();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed if the outgoing workspace reports a close error", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-handoff-close-fault-"));
    const firstPath = join(root, "first"); const secondPath = join(root, "second");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const first = await manager.create(firstPath, "First synthetic workspace");
      const originalClose = first.close;
      first.close = async () => { await originalClose(); throw new Error("Synthetic close failure"); };
      await expect(manager.create(secondPath, "Second synthetic workspace")).rejects.toMatchObject({
        code: "CLEANUP_FAILED", message: "无法安全关闭原工作区；已锁定，请重新打开。"
      });
      expect(manager.current()).toBeUndefined();
      expect(manager.status()).toMatchObject({ status: "locked", workspaceId: first.workspace.id });
      expect(JSON.parse(await readFile(join(root, "state.json"), "utf8"))).toEqual({ recentWorkspacePath: firstPath });
      const reopened = await manager.unlock();
      expect(reopened.workspace.rootPath).toBe(firstPath);
    } finally {
      await manager.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("encrypted workspace snapshots", () => {
  it("removes only marked transient files left by a previous process", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-transient-recovery-"));
    const statePath = join(root, "state.json");
    try {
      const first = new LocalWorkspaceManager(new TestKeyProtector(), statePath);
      const abandoned = await first.createTransientDirectory("screened-zip-");
      await writeFile(join(abandoned, "ordinary-day-marker"), "synthetic private text");
      const neighboring = join(root, "user-kept-directory");
      await mkdir(neighboring);
      await writeFile(join(neighboring, "keep.txt"), "keep");

      const restarted = new LocalWorkspaceManager(new TestKeyProtector(), statePath);
      await restarted.prepareTransientStorage();
      await expect(access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(root, ".grudge-vault-redesign-transient-v1")))
        .toEqual([".owned-by-grudge-vault"]);
      expect(await readFile(join(neighboring, "keep.txt"), "utf8")).toBe("keep");
      const next = await restarted.createTransientDirectory("pending-zip-");
      expect(next).toContain(".grudge-vault-redesign-transient-v1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete an unmarked or symlinked transient directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-transient-guard-"));
    const statePath = join(root, "state.json");
    const transient = join(root, ".grudge-vault-redesign-transient-v1");
    try {
      await mkdir(transient, { mode: 0o700 });
      await writeFile(join(transient, "user-file"), "do not remove");
      const manager = new LocalWorkspaceManager(new TestKeyProtector(), statePath);
      await expect(manager.prepareTransientStorage()).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
      expect(await readFile(join(transient, "user-file"), "utf8")).toBe("do not remove");
      await rm(transient, { recursive: true });
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "keep.txt"), "still here");
      await symlink(outside, transient);
      await expect(manager.prepareTransientStorage()).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
      expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("still here");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the current workspace open when another workspace fails its recovery scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-open-rollback-"));
    const protector = new TestKeyProtector();
    const manager = new LocalWorkspaceManager(protector, join(root, "current-state.json"));
    const otherManager = new LocalWorkspaceManager(protector, join(root, "other-state.json"));
    const currentPath = join(root, "current");
    const otherPath = join(root, "other");
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(currentPath, "Current workspace");
      await new GrudgeVaultApplication(otherManager).createWorkspace(otherPath, "Broken workspace");
      await otherManager.close();
      await rm(join(otherPath, "vault", "tmp"), { recursive: true });
      await symlink(root, join(otherPath, "vault", "tmp"));

      await expect(manager.open(otherPath)).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
      expect(manager.current()?.workspace.rootPath).toBe(currentPath);
      expect(application.listRecordTimeline({ limit: 10 }).records).toHaveLength(0);
      expect(JSON.parse(await readFile(join(root, "current-state.json"), "utf8"))).toEqual({ recentWorkspacePath: currentPath });
    } finally {
      await otherManager.close();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace an open workspace's key settings after another workspace cannot unlock", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-key-rollback-"));
    const manager = new LocalWorkspaceManager(new ScopedTestKeyProtector("current"), join(root, "state.json"));
    const otherManager = new LocalWorkspaceManager(new ScopedTestKeyProtector("other"), join(root, "other-state.json"));
    const currentPath = join(root, "current");
    const otherPath = join(root, "other");
    try {
      await new GrudgeVaultApplication(manager).createWorkspace(currentPath, "Current workspace");
      await new GrudgeVaultApplication(otherManager).createWorkspace(otherPath, "Other workspace");
      const before = manager.getCryptoStatus();
      await expect(manager.open(otherPath)).rejects.toMatchObject({ code: "WORKSPACE_KEY_UNAVAILABLE" });
      expect(manager.current()?.workspace.rootPath).toBe(currentPath);
      expect(manager.getCryptoStatus()).toEqual(before);
    } finally {
      await otherManager.close();
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the public manual intake entry point from accepting injected import provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-manual-origin-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(join(root, "workspace"), "Manual origin test");
      const forged = {
        text: "合成的手动奖金记录", origin: "zip", sourceVersion: "forged-import-version",
        sourceLocator: { connectorId: "dayone-zip", journalId: "forged", entryId: "forged" }
      } as unknown as Parameters<GrudgeVaultApplication["prepareIntake"]>[0];
      const draft = await application.prepareIntake(forged);
      const result = await application.screenAndSaveIntake(draft.sessionId, randomUUID(), {
        async screen(input) {
          expect(input.origin).toBe("manual");
          expect(input.sourceVersion).not.toBe("forged-import-version");
          return {
            decision: "include", categories: ["rights"], reason: "合成权益事实",
            anchors: [], coverage: "complete", policyVersion: "test-v1"
          };
        }
      });
      if (result.kind !== "saved") throw new Error("expected a saved manual record");
      expect(application.getRecordDetail(result.recordId).source).toMatchObject({ origin: "manual" });
      expect(application.getRecordDetail(result.recordId).source.connectorId).toBeUndefined();
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seals an existing plaintext pending review when reopening its verified workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-pending-upgrade-"));
    const workspacePath = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const marker = `legacy-pending-${randomUUID()}`;
    const id = randomUUID();
    try {
      await new GrudgeVaultApplication(manager).createWorkspace(workspacePath, "Pending upgrade test");
      await manager.close();
      const database = new Database(join(workspacePath, "db", "grudge-vault.sqlite3"));
      try {
        database.prepare(`
          INSERT INTO redesign_pending_reviews(
            id, origin, origin_locator, source_version, excerpt, reason, categories_json,
            coverage, created_at, updated_at
          ) VALUES (?, 'zip', ?, ?, ?, ?, '[]', 'partial', ?, ?)
        `).run(id, marker, "a".repeat(64), marker, marker, "2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z");
      } finally {
        database.close();
      }
      await manager.openRecent();
      expect(new GrudgeVaultApplication(manager).listPendingReviews()[0]).toMatchObject({ id, excerpt: marker });
      await manager.close();
      await assertAbsentFromWorkspaceFiles(workspacePath, [marker]);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps pending-review text sealed through a workspace key rotation and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-pending-rotation-"));
    const workspacePath = join(root, "workspace");
    const protector = new TestKeyProtector();
    const manager = new LocalWorkspaceManager(protector, join(root, "state.json"));
    const marker = `private-review-${randomUUID()}`;
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(workspacePath, "Pending rotation test");
      const draft = await application.prepareIntake({ text: `请核对 ${marker}` });
      const result = await application.screenAndSaveIntake(draft.sessionId, randomUUID(), {
        async screen() {
          return { decision: "review", categories: ["rights"], reason: `信息不足 ${marker}`,
            anchors: [], coverage: "partial", policyVersion: "test-v1" };
        }
      });
      expect(result.kind).toBe("needs_review");
      const pending = application.listPendingReviews();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.excerpt).toContain(marker);
      const before = manager.getCryptoStatus();
      const prepared = await manager.prepareKeyRotation();
      expect(prepared.activeKeyId).not.toBe(before.activeKeyId);
      await manager.completeKeyRotation(prepared.activeKeyId);
      expect(application.listPendingReviews()[0]?.excerpt).toContain(marker);
      const backupPath = join(root, "backup");
      await application.createBackup(backupPath);
      await assertAbsentFromWorkspaceFiles(backupPath, [marker]);
      await manager.close();
      await assertAbsentFromWorkspaceFiles(workspacePath, [marker]);

      const reopened = new LocalWorkspaceManager(protector, join(root, "state.json"));
      try {
        expect((await reopened.openRecent())?.workspace.rootPath).toBe(workspacePath);
        expect(new GrudgeVaultApplication(reopened).listPendingReviews()[0]?.excerpt).toContain(marker);
      } finally {
        await reopened.close();
      }
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no skipped manual text or media in workspace files or a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-skip-residue-"));
    const workspacePath = join(root, "workspace");
    const backupPath = join(root, "backup");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const marker = `ordinary-only-${randomUUID()}`;
    const mediaMarker = `media-only-${randomUUID()}`;
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(workspacePath, "No residue");
      const mediaPath = join(root, "ordinary.png");
      await writeFile(mediaPath, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(mediaMarker)
      ]));
      const draft = await application.prepareIntake({ text: `今天买了菜。${marker}`, paths: [mediaPath] });
      const result = await application.screenAndSaveIntake(draft.sessionId, randomUUID(), {
        async screen(input) {
          return {
            decision: "skip", categories: [], reason: "普通日常", coverage: "complete", policyVersion: "test-v1",
            anchors: [{ sourceVersion: input.sourceVersion, temporaryMediaRef: draft.attachments[0]!.id }]
          };
        }
      });
      expect(result.kind).toBe("skipped");
      expect(application.listRecordTimeline({ limit: 10 }).records).toHaveLength(0);
      await application.createBackup(backupPath);
      await assertAbsentFromWorkspaceFiles(workspacePath, [marker, mediaMarker]);
      await assertAbsentFromWorkspaceFiles(backupPath, [marker, mediaMarker]);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a backup destination that points inside the workspace through a directory alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-backup-inside-alias-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const workspacePath = join(root, "workspace");
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(workspacePath, "Active workspace");
      const aliasPath = join(root, "workspace-alias");
      await symlink(workspacePath, aliasPath);
      await expect(application.createBackup(join(aliasPath, "nested-backup"))).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      await expect(access(join(workspacePath, "nested-backup"))).rejects.toBeDefined();
      expect(manager.current()?.workspace.rootPath).toBe(workspacePath);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("backs up and restores through an alias to an external directory using its resolved path", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-external-backup-alias-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(join(root, "workspace"), "Active workspace");
      const externalPath = join(root, "external");
      await mkdir(externalPath);
      const aliasPath = join(root, "external-alias");
      await symlink(externalPath, aliasPath);
      const backup = await application.createBackup(join(aliasPath, "snapshot.gvbackup"));
      expect(backup.path).toBe(await realpath(join(externalPath, "snapshot.gvbackup")));
      const restored = await application.restoreBackup(join(aliasPath, "snapshot.gvbackup"), join(aliasPath, "restored"));
      expect(restored.rootPath).toBe(await realpath(join(externalPath, "restored")));
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects backup and restore paths beneath a dangling directory alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-dangling-alias-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(join(root, "workspace"), "Active workspace");
      const validBackup = join(root, "snapshot.gvbackup");
      await application.createBackup(validBackup);
      const aliasPath = join(root, "missing-alias");
      await symlink(join(root, "missing-target"), aliasPath);
      await expect(application.createBackup(join(aliasPath, "nested-backup"))).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      await expect(application.restoreBackup(validBackup, join(aliasPath, "restored"))).rejects.toMatchObject({
        code: "BACKUP_INVALID"
      });
      await expect(access(join(root, "missing-target"))).rejects.toBeDefined();
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not copy an unreferenced encrypted vault object into a new backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-orphan-backup-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(join(root, "workspace"), "Orphan backup test");
      const inputPath = join(root, "uncommitted-input.txt");
      await writeFile(inputPath, "synthetic uncommitted input");
      const session = manager.current()!;
      const orphan = await session.vault.put(inputPath, session.keyRing ?? session.key);
      const relativePath = join(
        "vault", "objects", "sha256", orphan.sha256.slice(0, 2), orphan.sha256.slice(2, 4), `${orphan.sha256}.gvobj`
      );
      await access(join(root, "workspace", relativePath));

      const backupPath = join(root, "backup");
      await application.createBackup(backupPath);
      await expect(access(join(backupPath, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(join(backupPath, "db"))).toContain("grudge-vault.sqlite3");
      await access(join(root, "workspace", relativePath));

      // Simulate an older format-3 backup that copied every vault object, including this orphan.
      const orphanBytes = await readFile(join(root, "workspace", relativePath));
      const backupObjectPath = join(backupPath, relativePath);
      await mkdir(join(backupPath, "vault", "objects", "sha256", orphan.sha256.slice(0, 2), orphan.sha256.slice(2, 4)), { recursive: true });
      await writeFile(backupObjectPath, orphanBytes);
      const manifestPath = join(backupPath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: Array<{ path: string; byteSize: number; sha256: string }>;
      };
      manifest.files.push({
        path: relativePath, byteSize: orphanBytes.length,
        sha256: createHash("sha256").update(orphanBytes).digest("hex")
      });
      await writeFile(manifestPath, JSON.stringify(manifest));
      const restored = await application.restoreBackup(backupPath, join(root, "restored"));
      expect(restored.rootPath).toBe(await realpath(join(root, "restored")));
      await expect(access(join(restored.rootPath, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports a decrypted attachment only outside the encrypted workspace, including symlinked paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-asset-export-"));
    const workspacePath = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(workspacePath, "Asset export boundary test");
      const mediaPath = join(root, "synthetic.png");
      const bytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic-retained-evidence")
      ]);
      await writeFile(mediaPath, bytes);
      const draft = await application.prepareIntake({ text: "合成的权益凭证", paths: [mediaPath] });
      const saved = await application.screenAndSaveIntake(draft.sessionId, randomUUID(), {
        async screen(input) {
          return {
            decision: "include", categories: ["rights"], reason: "附件关联权益事实",
            anchors: [{ sourceVersion: input.sourceVersion, temporaryMediaRef: input.media[0]!.id }],
            coverage: "complete", policyVersion: "test-v1"
          };
        }
      });
      if (saved.kind !== "saved") throw new Error("expected a saved record");
      const assetId = application.getRecordDetail(saved.recordId).attachments[0]!.id;
      const insidePath = join(workspacePath, "decrypted.png");
      await expect(application.exportAsset(assetId, insidePath)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(access(insidePath)).rejects.toMatchObject({ code: "ENOENT" });

      const aliasPath = join(root, "workspace-alias");
      await symlink(workspacePath, aliasPath);
      await expect(application.exportAsset(assetId, join(aliasPath, "decrypted.png")))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(access(insidePath)).rejects.toMatchObject({ code: "ENOENT" });

      const exportedPath = join(root, "exported.png");
      expect(await application.exportAsset(assetId, exportedPath)).toBe(exportedPath);
      expect(await readFile(exportedPath)).toEqual(bytes);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers crash-orphaned encrypted objects without deleting database-referenced assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-orphan-recovery-"));
    const workspacePath = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(workspacePath, "Recovery test");
      const retainedPath = join(root, "retained.txt");
      const orphanPath = join(root, "orphan.txt");
      await writeFile(retainedPath, "synthetic retained attachment");
      await writeFile(orphanPath, "synthetic crash-orphaned attachment");
      const retained = await application.importAsset(retainedPath);
      const session = manager.current()!;
      const orphan = await session.vault.put(orphanPath, session.keyRing ?? session.key);
      expect(await session.vault.exists(orphan.sha256)).toBe(true);

      await manager.close();
      const reopened = (await manager.openRecent())!;
      expect(await reopened.vault.exists(retained.asset.sha256)).toBe(true);
      expect(await reopened.vault.verify(retained.asset.sha256, reopened.keyRing ?? reopened.key)).toBe(true);
      expect(await reopened.vault.exists(orphan.sha256)).toBe(false);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an unsafe vault link instead of following it during startup recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-recovery-link-"));
    const workspacePath = join(root, "workspace");
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      await manager.create(workspacePath, "Recovery link test");
      await manager.close();
      const outside = join(root, "outside");
      await mkdir(outside);
      await symlink(outside, join(workspacePath, "vault", "objects", "sha256", "ff"));
      await expect(manager.openRecent()).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates draft and search sessions when the workspace is locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-lock-sessions-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      const application = new GrudgeVaultApplication(manager);
      await application.createWorkspace(join(root, "workspace"), "Session lock test");
      const draft = await application.prepareIntake({ text: "合成记录草稿" });
      const query = await application.prepareRecordSearchQuery({ text: "合成查询" });
      await application.lockWorkspace();
      await application.unlockWorkspace();
      await expect(application.screenAndSaveIntake(draft.sessionId, randomUUID(), {
        async screen() { throw new Error("A cleared draft must never reach the model."); }
      })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
      await expect(application.executeRecordSearchQuery(query.sessionId, {}))
        .rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("refuses an old workspace without modifying it in place", async () => {
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

      const before = await readFile(join(workspacePath, "workspace.json"));
      const upgrader = new LocalWorkspaceManager(protector, join(root, "upgrader-state.json"));
      await expect(upgrader.open(workspacePath)).rejects.toMatchObject({ code: "WORKSPACE_MIGRATION_REQUIRED" });
      expect(await readFile(join(workspacePath, "workspace.json"))).toEqual(before);
      await upgrader.close();
    } finally {
      await creator.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reselects a real old workspace to keep a reviewed record with its original attachment and revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-legacy-review-"));
    const protector = new TestKeyProtector();
    const legacyPath = join(root, "legacy");
    const targetPath = join(root, "target");
    const legacyManager = new LocalWorkspaceManager(protector, join(root, "legacy-state.json"));
    const targetManager = new LocalWorkspaceManager(protector, join(root, "target-state.json"));
    try {
      const legacyApplication = new GrudgeVaultApplication(legacyManager);
      await legacyApplication.createWorkspace(legacyPath, "待核对旧工作区");
      const event = legacyApplication.createEvent({
        title: "待核对的旧工资记录", status: "confirmed", occurredAt: { kind: "date", value: "2024-06-01" },
        narrative: "旧记录里的工资凭证需要我确认", facts: [], interpretations: [], emotions: [], interests: [],
        participants: [], sourceRefs: [], assetRefs: [], reason: "test fixture"
      });
      const imagePath = join(root, "old-proof.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x72, 0x6f, 0x6f, 0x66]));
      await legacyApplication.importAssetsForEvent([imagePath], event.id, event.currentRevision);
      await legacyManager.close();
      const configPath = join(legacyPath, "workspace.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      config.formatVersion = 2;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const before = await contentSnapshot(legacyPath);

      const targetApplication = new GrudgeVaultApplication(targetManager);
      await targetApplication.createWorkspace(targetPath, "新版待核对工作区");
      const firstSource = await targetManager.createLegacyMigrationSource(legacyPath);
      const summary = await targetApplication.migrateLegacyWorkspace(firstSource, {
        async screen() {
          return { decision: "review", categories: ["rights"], reason: "需要用户确认来源",
            anchors: [], coverage: "complete", policyVersion: "test-v1" };
        }
      });
      expect(summary).toMatchObject({ total: 1, review: 1, included: 0 });
      const pending = targetApplication.listPendingReviews()[0]!;
      expect(pending).toMatchObject({ origin: "migration", sessionAvailable: false });
      const reopened = await targetManager.createLegacyMigrationSource(legacyPath);
      const saved = await targetApplication.resolvePendingReviewFromLegacyWorkspace(pending.id, reopened, {
        async screen() { throw new Error("The unchanged old source should not call the model again."); }
      }, randomUUID());
      expect(saved.kind).toBe("saved");
      expect(targetApplication.listPendingReviews()).toHaveLength(0);
      const record = targetApplication.listRecordTimeline({ limit: 10 }).records[0]!;
      expect(record).toMatchObject({ origin: "migration", title: "待核对的旧工资记录", attachmentCount: 1 });
      const detail = targetApplication.getRecordDetail(record.id);
      expect(detail.source).toMatchObject({ connectorId: `legacy:${config.id as string}`, entryId: event.id });
      expect(await targetManager.current()!.vault.verify(
        detail.attachments[0]!.sha256,
        targetManager.current()!.keyRing ?? targetManager.current()!.key
      )).toBe(true);
      const database = new Database(join(targetPath, "db", "grudge-vault.sqlite3"), { readonly: true });
      try {
        expect(database.prepare("SELECT count(*) FROM redesign_legacy_revisions").pluck().get()).toBeGreaterThan(0);
      } finally {
        database.close();
      }
      expect(await contentSnapshot(legacyPath)).toEqual(before);
    } finally {
      await legacyManager.close();
      await targetManager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("screens a legacy workspace into a separate vault while preserving revisions and leaving the source byte-identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-screened-migration-"));
    const protector = new TestKeyProtector();
    const legacyPath = join(root, "legacy");
    const targetPath = join(root, "target");
    const legacyManager = new LocalWorkspaceManager(protector, join(root, "legacy-state.json"));
    const targetManager = new LocalWorkspaceManager(protector, join(root, "target-state.json"));
    const skippedMarker = `ordinary-only-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
    let skippedLegacyId = "";
    try {
      const legacyApplication = new GrudgeVaultApplication(legacyManager);
      await legacyApplication.createWorkspace(legacyPath, "旧工作区");
      const relevant = legacyApplication.createEvent({
        title: "欠薪争议原始标题", status: "confirmed", occurredAt: { kind: "date", value: "2025-03-02" },
        narrative: "公司拖欠我的奖金，欠薪争议需要处理。", facts: [], interpretations: [], emotions: [], interests: [],
        participants: [], sourceRefs: [], assetRefs: [], reason: "test fixture"
      });
      const ordinary = legacyApplication.createEvent({
        title: `普通买菜 ${skippedMarker}`, status: "confirmed", occurredAt: { kind: "date", value: "2025-03-03" },
        narrative: `今天买了青菜和水果。${skippedMarker}`, facts: [], interpretations: [], emotions: [], interests: [],
        participants: [], sourceRefs: [], assetRefs: [], reason: "test fixture"
      });
      skippedLegacyId = ordinary.id;
      const imagePath = join(root, "proof.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x72, 0x6f, 0x6f, 0x66]));
      const withAsset = await legacyApplication.importAssetsForEvent([imagePath], relevant.id, relevant.currentRevision);
      legacyApplication.updateEvent({
        eventId: withAsset.id, expectedRevision: withAsset.currentRevision, reason: "用户补充标题",
        title: "用户补充后的欠薪标题", status: withAsset.status,
        occurredAt: { kind: "date", value: "2025-03-01" },
        ...(withAsset.narrative ? { narrative: withAsset.narrative } : {}),
        facts: withAsset.facts, interpretations: withAsset.interpretations, emotions: withAsset.emotions,
        interests: withAsset.interests, participants: withAsset.participants,
        sourceRefs: withAsset.sourceRefs, assetRefs: withAsset.assetRefs
      });
      await legacyManager.close();

      const configPath = join(legacyPath, "workspace.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      config.formatVersion = 2;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const before = await contentSnapshot(legacyPath);

      const targetApplication = new GrudgeVaultApplication(targetManager);
      await targetApplication.createWorkspace(targetPath, "新版工作区");
      const source = await targetManager.createLegacyMigrationSource(legacyPath);
      const screening: ScreeningPort = {
        async screen(input) {
          return input.text.includes("欠薪争议")
            ? { decision: "include", categories: ["rights"], reason: "涉及用户劳动报酬权益", anchors: [], coverage: "complete", policyVersion: "test-v1" }
            : { decision: "skip", categories: [], reason: "普通日常", anchors: [], coverage: "complete", policyVersion: "test-v1" };
        }
      };
      await expect(targetApplication.migrateLegacyWorkspace(source, screening)).resolves.toEqual({
        total: 2, included: 1, skipped: 1, review: 0, failed: 0
      });

      const timeline = targetApplication.listRecordTimeline({ limit: 10 });
      expect(timeline.records).toHaveLength(1);
      expect(timeline.records[0]).toMatchObject({
        origin: "migration", title: "用户补充后的欠薪标题", occurredAt: { kind: "date", value: "2025-03-01" }, attachmentCount: 1
      });
      const detail = targetApplication.getRecordDetail(timeline.records[0]!.id);
      expect(detail.source.text).toContain("公司拖欠我的奖金");
      expect(await targetManager.current()!.vault.verify(
        detail.attachments[0]!.sha256,
        targetManager.current()!.keyRing ?? targetManager.current()!.key
      )).toBe(true);
      const sha256 = detail.attachments[0]!.sha256;
      const encryptedObjectPath = join("vault", "objects", "sha256", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.gvobj`);
      expect(await readFile(join(targetPath, encryptedObjectPath)))
        .not.toEqual(await readFile(join(legacyPath, encryptedObjectPath)));

      const targetDatabase = new Database(join(targetPath, "db", "grudge-vault.sqlite3"), { readonly: true });
      try {
        expect(targetDatabase.prepare("SELECT count(*) AS count FROM redesign_migration_map").get()).toEqual({ count: 1 });
        expect(targetDatabase.prepare("SELECT count(*) AS count FROM redesign_legacy_revisions").get()).toEqual({ count: 3 });
      } finally {
        targetDatabase.close();
      }
      const backupPath = join(root, "target-backup");
      await targetApplication.createBackup(backupPath);
      await assertAbsentFromWorkspaceFiles(targetPath, [skippedMarker, skippedLegacyId]);
      await assertAbsentFromWorkspaceFiles(backupPath, [skippedMarker, skippedLegacyId]);
      await targetManager.close();
      const restartedManager = new LocalWorkspaceManager(protector, join(root, "target-state.json"));
      try {
        const reopened = await restartedManager.openRecent();
        expect(reopened?.workspace.rootPath).toBe(targetPath);
        const restartedApplication = new GrudgeVaultApplication(restartedManager);
        const restartedTimeline = restartedApplication.listRecordTimeline({ limit: 10 });
        expect(restartedTimeline.records).toHaveLength(1);
        expect(restartedTimeline.records[0]?.id).toBe(timeline.records[0]?.id);
        const reopenedDetail = restartedApplication.getRecordDetail(timeline.records[0]!.id);
        expect(reopenedDetail.source.text).toBe(detail.source.text);
        expect(reopenedDetail.attachments[0]?.sha256).toBe(sha256);
        expect(await reopened!.vault.verify(sha256, reopened!.keyRing ?? reopened!.key)).toBe(true);
        const decryptedChunks: Buffer[] = [];
        for await (const chunk of await reopened!.vault.open(sha256, reopened!.keyRing ?? reopened!.key)) {
          decryptedChunks.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(decryptedChunks)).toEqual(await readFile(imagePath));
        const reopenedDatabase = new Database(join(targetPath, "db", "grudge-vault.sqlite3"), { readonly: true });
        try {
          const revisions = reopenedDatabase.prepare(`
            SELECT legacy_revision, snapshot_json FROM redesign_legacy_revisions
            WHERE record_id = ? ORDER BY legacy_revision
          `).all(timeline.records[0]!.id) as Array<{ legacy_revision: number; snapshot_json: string }>;
          expect(revisions.map(({ legacy_revision }) => legacy_revision)).toEqual([1, 2, 3]);
          expect(JSON.parse(revisions.at(-1)!.snapshot_json)).toMatchObject({ title: "用户补充后的欠薪标题" });
        } finally {
          reopenedDatabase.close();
        }
      } finally {
        await restartedManager.close();
      }
      expect(await contentSnapshot(legacyPath)).toEqual(before);
    } finally {
      await legacyManager.close();
      await targetManager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("screens unlinked legacy Day One sources without duplicating sources already represented by events", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-source-migration-"));
    const protector = new TestKeyProtector();
    const legacyPath = join(root, "legacy");
    const targetPath = join(root, "target");
    const legacyManager = new LocalWorkspaceManager(protector, join(root, "legacy-state.json"));
    const targetManager = new LocalWorkspaceManager(protector, join(root, "target-state.json"));
    const ordinaryMarker = `source-ordinary-${randomUUID()}`;
    const ordinaryMediaMarker = `ordinary-media-${randomUUID()}`;
    try {
      const legacyApplication = new GrudgeVaultApplication(legacyManager);
      await legacyApplication.createWorkspace(legacyPath, "旧 Day One 工作区");
      const imagePath = join(root, "refund.png");
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x65, 0x66, 0x75, 0x6e, 0x64]));
      const importedAsset = await legacyApplication.importAsset(imagePath);
      const ordinaryImagePath = join(root, "ordinary.png");
      const ordinaryImageBytes = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(ordinaryMediaMarker)
      ]);
      await writeFile(ordinaryImagePath, ordinaryImageBytes);
      const ordinaryAsset = await legacyApplication.importAsset(ordinaryImagePath);
      const importRun = await legacyApplication.createDayOneImport(imagePath);
      const dayOne = legacyManager.current()!.dayOne;
      const now = "2026-09-20T10:00:00.000Z";
      const entry = (externalId: string, text: string, day: string): NormalizedDayOneEntry => ({
        externalId, entryUuid: externalId, fingerprint: createHash("sha256").update(externalId).digest("hex"),
        creationDate: `${day}T10:00:00.000Z`, journalDate: day, modifiedDate: now,
        text, tags: [], media: [], contentHash: createHash("sha256").update(text).digest("hex"), raw: { text }
      });
      const linked = dayOne.upsertEntry(importRun.id, entry("LINKED", "旧 Day One 项目奖金未支付", "2025-03-01"), now);
      dayOne.upsertEntry(importRun.id, entry("STANDALONE", "旧 Day One 退款承诺落空", "2025-03-02"), now);
      const ordinary = dayOne.upsertEntry(importRun.id, entry("ORDINARY", `午饭后散步 ${ordinaryMarker}`, "2025-03-03"), now);
      dayOne.linkMedia(importRun.id, ["STANDALONE"], importedAsset.asset.id, "photos/refund.png", now);
      dayOne.linkMedia(importRun.id, ["ORDINARY"], ordinaryAsset.asset.id, "photos/ordinary.png", now);
      legacyApplication.createEvent({
        title: "项目奖金未支付", status: "confirmed", occurredAt: { kind: "date", value: "2025-03-01" },
        narrative: "公司仍未支付项目奖金。", facts: [], interpretations: [], emotions: [], interests: [],
        participants: [], sourceRefs: [linked.journalEntry.sourceItemId], assetRefs: [], reason: "test fixture"
      });
      await legacyManager.close();
      const configPath = join(legacyPath, "workspace.json");
      const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      config.formatVersion = 2;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const before = await contentSnapshot(legacyPath);

      const targetApplication = new GrudgeVaultApplication(targetManager);
      await targetApplication.createWorkspace(targetPath, "新版来源工作区");
      const screening: ScreeningPort = { async screen(input) {
        if (input.text.includes("午饭后散步")) return {
          decision: "skip", categories: [], reason: "普通日常", coverage: "complete", policyVersion: "test-v1",
          anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id }))
        };
        return {
          decision: "include", categories: ["rights"], reason: "模拟权益事件", coverage: "complete", policyVersion: "test-v1",
          anchors: input.media.map(({ id }) => ({ sourceVersion: input.sourceVersion, temporaryMediaRef: id }))
        };
      } };
      const source = await targetManager.createLegacyMigrationSource(legacyPath);
      expect(await targetApplication.migrateLegacyWorkspace(source, screening)).toEqual({
        total: 3, included: 2, skipped: 1, review: 0, failed: 0
      });
      const timeline = targetApplication.listRecordTimeline({ limit: 10 }).records;
      expect(timeline).toHaveLength(2);
      const refund = timeline.find(({ title }) => title.includes("退款承诺落空"));
      expect(refund?.attachmentCount).toBe(1);
      expect(timeline.filter(({ title }) => title.includes("项目奖金"))).toHaveLength(1);
      const refundAssetHash = targetApplication.getRecordDetail(refund!.id).attachments[0]!.sha256;
      const refundObjectPath = join("vault", "objects", "sha256", refundAssetHash.slice(0, 2), refundAssetHash.slice(2, 4), `${refundAssetHash}.gvobj`);
      expect(await readFile(join(targetPath, refundObjectPath))).not.toEqual(await readFile(join(legacyPath, refundObjectPath)));
      const replay = await targetManager.createLegacyMigrationSource(legacyPath);
      await targetApplication.migrateLegacyWorkspace(replay, screening);
      expect(targetApplication.listRecordTimeline({ limit: 10 }).records).toHaveLength(2);
      await assertAbsentFromWorkspaceFiles(targetPath, [ordinaryMarker, ordinary.journalEntry.sourceItemId]);
      const ordinaryHash = createHash("sha256").update(ordinaryImageBytes).digest("hex");
      await expect(access(join(targetPath, "vault", "objects", "sha256", ordinaryHash.slice(0, 2), ordinaryHash.slice(2, 4), `${ordinaryHash}.gvobj`)))
        .rejects.toThrow();
      await targetManager.close();
      const restartedManager = new LocalWorkspaceManager(protector, join(root, "target-state.json"));
      try {
        expect((await restartedManager.openRecent())?.workspace.rootPath).toBe(targetPath);
        expect(new GrudgeVaultApplication(restartedManager).getRecordDetail(refund!.id).attachments[0]?.sha256).toBe(refundAssetHash);
        const decryptedChunks: Buffer[] = [];
        const session = restartedManager.current()!;
        for await (const chunk of await session.vault.open(refundAssetHash, session.keyRing ?? session.key)) {
          decryptedChunks.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(decryptedChunks)).toEqual(await readFile(imagePath));
      } finally {
        await restartedManager.close();
      }
      expect(await contentSnapshot(legacyPath)).toEqual(before);
    } finally {
      await legacyManager.close();
      await targetManager.close();
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
        formatVersion: 3, workspaceId: workspace.id
      });

      const restoredPath = join(root, "restored");
      const restored = await application.restoreBackup(backupPath, restoredPath);
      expect(restored.rootPath).toBe(await realpath(restoredPath));
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

  it("rejects manifest-consistent but undecryptable backup objects before switching workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-backup-object-corrupt-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    const workspacePath = join(root, "workspace");
    try {
      await application.createWorkspace(workspacePath, "Healthy workspace");
      const imported = await application.importAsset(resolve("fixtures/assets/phase-zero-demo.txt"));
      const backupPath = join(root, "snapshot.gvbackup");
      await application.createBackup(backupPath);
      const hash = imported.asset.sha256;
      const relativePath = join("vault", "objects", "sha256", hash.slice(0, 2), hash.slice(2, 4), `${hash}.gvobj`);
      const objectPath = join(backupPath, relativePath);
      const objectBytes = await readFile(objectPath);
      objectBytes[objectBytes.length - 1] = objectBytes[objectBytes.length - 1]! ^ 1;
      await writeFile(objectPath, objectBytes);
      const manifestPath = join(backupPath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: Array<{ path: string; byteSize: number; sha256: string }>;
      };
      const entry = manifest.files.find(({ path }) => path === relativePath)!;
      entry.sha256 = createHash("sha256").update(objectBytes).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));

      const destination = join(root, "restored");
      await expect(application.restoreBackup(backupPath, destination)).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      await expect(access(destination)).rejects.toBeDefined();
      expect(manager.current()?.workspace.rootPath).toBe(workspacePath);
      expect(await manager.current()!.vault.verify(hash, manager.current()!.keyRing ?? manager.current()!.key)).toBe(true);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["direct", "symlink"] as const)("rejects a %s restore destination inside the active workspace", async (route) => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-restore-inside-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    const workspacePath = join(root, "workspace");
    try {
      await application.createWorkspace(workspacePath, "Active workspace");
      const backupPath = join(root, "snapshot.gvbackup");
      await application.createBackup(backupPath);
      if (route === "symlink") await symlink(workspacePath, join(root, "workspace-alias"));
      const destination = join(route === "direct" ? workspacePath : join(root, "workspace-alias"), "restored");
      await expect(application.restoreBackup(backupPath, destination)).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      await expect(access(join(workspacePath, "restored"))).rejects.toBeDefined();
      expect(manager.current()?.workspace.rootPath).toBe(workspacePath);
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a destination inside the backup even when its path uses a directory alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-restore-backup-alias-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    try {
      await application.createWorkspace(join(root, "workspace"), "Active workspace");
      const backupPath = join(root, "snapshot.gvbackup");
      await application.createBackup(backupPath);
      const aliasPath = join(root, "backup-alias");
      await symlink(backupPath, aliasPath);
      await expect(application.restoreBackup(aliasPath, join(backupPath, "nested-restored"))).rejects.toMatchObject({
        code: "BACKUP_INVALID"
      });
      await expect(access(join(backupPath, "nested-restored"))).rejects.toBeDefined();
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an old-format backup before creating or mutating the restore destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-old-backup-"));
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    const application = new GrudgeVaultApplication(manager);
    try {
      await application.createWorkspace(join(root, "workspace"), "Old Backup Guard");
      const backupPath = join(root, "snapshot.gvbackup");
      await application.createBackup(backupPath);
      const manifestPath = join(backupPath, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.formatVersion = 2;
      await writeFile(manifestPath, JSON.stringify(manifest));
      const destination = join(root, "restored");
      await expect(application.restoreBackup(backupPath, destination)).rejects.toMatchObject({
        code: "WORKSPACE_MIGRATION_REQUIRED"
      });
      await expect(access(destination)).rejects.toBeDefined();
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

  it("does not overwrite a locked workspace policy while recovering its keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-recovery-policy-race-"));
    const workspace = join(root, "workspace");
    const recoveryPath = join(root, "keys.gvrecovery");
    const passphrase = "synthetic recovery passphrase";
    const source = new LocalWorkspaceManager(new ScopedTestKeyProtector("source"), join(root, "source-state.json"));
    let entered!: () => void; let release!: () => void;
    const protecting = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const targetProtector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { entered(); await held; return `target:${key.toString("base64")}`; },
      async unprotect(envelope) {
        if (!envelope.startsWith("target:")) throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "Different synthetic key store.");
        return { key: Buffer.from(envelope.slice(7), "base64") };
      }
    };
    const target = new LocalWorkspaceManager(targetProtector, join(root, "target-state.json"));
    try {
      await source.create(workspace, "Synthetic recovery policy workspace");
      await source.exportRecovery(recoveryPath, passphrase);
      await source.close();
      await expect(target.open(workspace)).rejects.toMatchObject({ code: "WORKSPACE_KEY_UNAVAILABLE" });
      const recovery = target.recover(recoveryPath, passphrase);
      await protecting;
      const policy = target.updateSecuritySettings({ autoLockMinutes: 60, integrityScanIntervalDays: 30 });
      release();
      await Promise.all([recovery, policy]);
      expect(target.getSecuritySettings().autoLockMinutes).toBe(60);
      expect(JSON.parse(await readFile(join(workspace, "workspace.json"), "utf8"))).toMatchObject({
        security: { autoLockMinutes: 60, integrityScanIntervalDays: 30 }
      });
      await target.close();
      await target.open(workspace);
      expect(target.getSecuritySettings().autoLockMinutes).toBe(60);
    } finally {
      release();
      await source.close();
      await target.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports one internally consistent key epoch when a rotation starts at the same time", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-recovery-export-race-"));
    const workspace = join(root, "workspace");
    const recoveryPath = join(root, "keys.gvrecovery");
    const passphrase = "synthetic export race passphrase";
    const manager = new LocalWorkspaceManager(new TestKeyProtector(), join(root, "state.json"));
    try {
      await manager.create(workspace, "Synthetic export race workspace");
      const exportPromise = manager.exportRecovery(recoveryPath, passphrase);
      const rotationPromise = manager.prepareKeyRotation();
      const [summary] = await Promise.all([exportPromise, rotationPromise]);
      const packageJson = JSON.parse(await readFile(recoveryPath, "utf8")) as {
        keyEpoch: number;
        kdf: { salt: string; N: number; r: number; p: number; maxmem: number };
        cipher: { iv: string; authTag: string; ciphertext: string };
      };
      const derived = scryptSync(passphrase, Buffer.from(packageJson.kdf.salt, "base64"), 32,
        { N: packageJson.kdf.N, r: packageJson.kdf.r, p: packageJson.kdf.p, maxmem: packageJson.kdf.maxmem });
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(packageJson.cipher.iv, "base64"));
        decipher.setAAD(Buffer.from(`grudge-vault:recovery:${summary.workspaceId}:${packageJson.keyEpoch}:v1`));
        decipher.setAuthTag(Buffer.from(packageJson.cipher.authTag, "base64"));
        plaintext = Buffer.concat([decipher.update(Buffer.from(packageJson.cipher.ciphertext, "base64")), decipher.final()]);
        const payload = JSON.parse(plaintext.toString("utf8")) as {
          activeKeyId: string; pendingKeyId?: string; keys: Array<{ id: string }>;
        };
        expect(packageJson.keyEpoch).toBe(summary.keyEpoch);
        expect(payload.keys).toHaveLength(summary.keyCount);
        expect(payload.keys.some(({ id }) => id === payload.activeKeyId)).toBe(true);
        expect(payload.pendingKeyId).toBeUndefined();
      } finally {
        plaintext?.fill(0); derived.fill(0);
      }
    } finally {
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reopen a recovered workspace after another workspace becomes active", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-recovery-switch-race-"));
    const workspace = join(root, "recovered-workspace");
    const otherWorkspace = join(root, "other-workspace");
    const recoveryPath = join(root, "keys.gvrecovery");
    const passphrase = "synthetic switch recovery passphrase";
    const source = new LocalWorkspaceManager(new ScopedTestKeyProtector("source"), join(root, "source-state.json"));
    let entered!: () => void; let release!: () => void;
    const reopening = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pauseRecoveredOpen = false;
    const targetProtector: KeyProtectorPort = {
      async assertAvailable() {},
      async protect(key) { pauseRecoveredOpen = true; return `target:${key.toString("base64")}`; },
      async unprotect(envelope) {
        if (!envelope.startsWith("target:")) throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "Different synthetic key store.");
        if (pauseRecoveredOpen) { pauseRecoveredOpen = false; entered(); await held; }
        return { key: Buffer.from(envelope.slice(7), "base64") };
      }
    };
    const target = new LocalWorkspaceManager(targetProtector, join(root, "target-state.json"));
    const otherSeed = new LocalWorkspaceManager(new ScopedTestKeyProtector("target"), join(root, "other-state.json"));
    try {
      await source.create(workspace, "Synthetic recovered workspace");
      await source.exportRecovery(recoveryPath, passphrase);
      await source.close();
      await otherSeed.create(otherWorkspace, "Synthetic other workspace");
      await otherSeed.close();
      await expect(target.open(workspace)).rejects.toMatchObject({ code: "WORKSPACE_KEY_UNAVAILABLE" });
      const recovery = target.recover(recoveryPath, passphrase);
      await reopening;
      await target.open(otherWorkspace);
      release();
      await expect(recovery).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
      expect(target.status()).toMatchObject({ status: "open", workspace: { rootPath: otherWorkspace } });
      expect(target.current()?.workspace.rootPath).toBe(otherWorkspace);
      const reopened = new LocalWorkspaceManager(targetProtector, join(root, "reopened-state.json"));
      try {
        await reopened.open(workspace);
        expect(reopened.status()).toMatchObject({ status: "open", workspace: { rootPath: workspace } });
      } finally { await reopened.close(); }
    } finally {
      release();
      await source.close();
      await otherSeed.close();
      await target.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
