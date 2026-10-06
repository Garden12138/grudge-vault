import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GrudgeVaultApplication, WorkspaceManagerPort } from "@grudge-vault/application";
import { AppError } from "@grudge-vault/shared";
import { ImportFolderMonitor } from "./import-folder-monitor";
import { LocalIntelligenceStateStore } from "./local-intelligence-state";

describe("Day One import folder monitor", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("scans only stable top-level ZIP files and keeps the path in private machine state", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-folder-")); roots.push(root);
    const workspace = join(root, "workspace"); const folder = join(root, "imports"); const nested = join(folder, "nested");
    await mkdir(workspace); await mkdir(nested, { recursive: true });
    await writeFile(join(folder, "first.zip"), "archive one");
    await writeFile(join(folder, "ignore.txt"), "not a zip");
    await writeFile(join(nested, "nested.zip"), "not top-level");
    const statePath = join(root, "machine", "local-intelligence.json");
    const state = new LocalIntelligenceStateStore(statePath); await state.load();
    const seenHashes = new Set<string>(); const ingested: string[] = []; let imported = 0; let wakes = 0;
    const application = {
      async ingestWatchedDayOne(path: string) {
        ingested.push(basename(path));
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        if (seenHashes.has(hash)) return undefined;
        seenHashes.add(hash); imported += 1; return { id: hash };
      },
      getImportFolderCounts: () => ({ imported, failed: 0 })
    } as unknown as GrudgeVaultApplication;
    const workspaces = { current: () => ({ workspace: { id: "workspace-1", rootPath: workspace } }) } as unknown as WorkspaceManagerPort;
    const monitor = new ImportFolderMonitor(application, workspaces, state,
      () => ({ wake: () => { wakes += 1; } }) as never, { stabilityMs: 5, reconcileMs: 60_000 });
    try {
      const initial = await monitor.choose(folder);
      expect(initial).toMatchObject({ configured: true, enabled: true, importedCount: 1 });
      expect(ingested).toEqual(["first.zip"]);

      await writeFile(join(folder, "renamed.zip"), "archive one");
      await monitor.scanNow();
      expect(imported).toBe(1);
      await writeFile(join(folder, "first.zip"), "archive changed");
      await monitor.scanNow();
      expect(imported).toBe(2);
      expect(wakes).toBe(2);
      expect(ingested).not.toContain("nested.zip");
      // Windows reports synthesized mode bits; this assertion applies to POSIX permissions.
      if (process.platform !== "win32") expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(await readFile(statePath, "utf8")) as {
        importFolders: Record<string, { path: string }>;
      };
      expect(saved.importFolders[`workspace-1:${workspace}`]?.path).toBe(await realpath(folder));
      await expect(monitor.choose(workspace)).rejects.toBeInstanceOf(AppError);
    } finally {
      monitor.stop();
    }
  });
});
