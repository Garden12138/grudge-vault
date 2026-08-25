import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { GrudgeVaultApplication, JobRunner, WorkspaceManagerPort } from "@grudge-vault/application";
import type { ImportFolderStatus } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import { LocalIntelligenceStateStore } from "./local-intelligence-state";

const FIVE_MINUTES = 5 * 60_000;

interface ImportFolderMonitorOptions {
  reconcileMs?: number;
  stabilityMs?: number;
  now?: () => Date;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class ImportFolderMonitor {
  private watcher: FSWatcher | undefined;
  private interval: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private scanning = false;
  private watching = false;
  private readonly completedSignatures = new Map<string, string>();
  private readonly reconcileMs: number;
  private readonly stabilityMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly application: GrudgeVaultApplication,
    private readonly workspaces: WorkspaceManagerPort,
    private readonly state: LocalIntelligenceStateStore,
    private readonly getRunner: () => JobRunner | undefined,
    options: ImportFolderMonitorOptions = {}
  ) {
    this.reconcileMs = options.reconcileMs ?? FIVE_MINUTES;
    this.stabilityMs = options.stabilityMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  async choose(path: string): Promise<ImportFolderStatus> {
    const session = this.workspaces.current();
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    const info = await lstat(path).catch((cause) => {
      throw new AppError("IMPORT_FOLDER_UNAVAILABLE", "The selected import folder cannot be read.", false, { cause });
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError("IMPORT_FOLDER_UNAVAILABLE", "Choose a regular directory.");
    const folder = await realpath(path);
    const workspace = await realpath(session.workspace.rootPath);
    const relationship = relative(workspace, folder);
    if (!relationship || (!relationship.startsWith(`..${sep}`) && relationship !== "..")) {
      throw new AppError("IMPORT_FOLDER_UNAVAILABLE", "The import folder must be outside the workspace.");
    }
    this.completedSignatures.clear();
    await this.state.setImportFolder(this.workspaceKey(), { path: folder, enabled: true });
    await this.restart();
    await this.scanNow();
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<ImportFolderStatus> {
    const key = this.workspaceKey();
    const current = this.state.getImportFolder(key);
    if (!current) throw new AppError("IMPORT_FOLDER_UNAVAILABLE", "Choose an import folder first.");
    await this.state.setImportFolder(key, { ...current, enabled });
    await this.restart();
    return this.status();
  }

  async status(): Promise<ImportFolderStatus> {
    const session = this.workspaces.current();
    if (!session) return { configured: false, enabled: false, watching: false, importedCount: 0, failedCount: 0 };
    const value = this.state.getImportFolder(this.workspaceKey());
    const counts = this.application.getImportFolderCounts();
    return {
      configured: Boolean(value), enabled: value?.enabled ?? false,
      ...(value ? { displayPath: value.path } : {}), watching: this.watching,
      ...(value?.lastScannedAt ? { lastScannedAt: value.lastScannedAt } : {}),
      importedCount: counts.imported, failedCount: counts.failed,
      ...(value?.lastError ? { lastError: value.lastError } : {})
    };
  }

  async start(): Promise<void> {
    await this.restart();
    if (this.watching) await this.scanNow();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.interval) clearInterval(this.interval);
    if (this.debounce) clearTimeout(this.debounce);
    this.interval = undefined;
    this.debounce = undefined;
    this.watching = false;
  }

  async scanNow(): Promise<ImportFolderStatus> {
    if (this.scanning) return this.status();
    const session = this.workspaces.current();
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    const key = this.workspaceKey();
    const value = this.state.getImportFolder(key);
    if (!value?.enabled) return this.status();
    this.scanning = true;
    let lastError: string | undefined;
    try {
      const entries = await readdir(value.path, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
        const path = resolve(value.path, entry.name);
        try {
          const first = await lstat(path);
          if (!first.isFile() || first.isSymbolicLink()) continue;
          const signature = `${first.size}:${first.mtimeMs}`;
          if (this.completedSignatures.get(path) === signature) continue;
          await delay(this.stabilityMs);
          const second = await lstat(path);
          if (!second.isFile() || second.isSymbolicLink() || first.size !== second.size || first.mtimeMs !== second.mtimeMs) continue;
          const run = await this.application.ingestWatchedDayOne(path);
          this.completedSignatures.set(path, signature);
          if (run) this.getRunner()?.wake();
        } catch (error) {
          lastError = error instanceof AppError ? `${error.code}: ${error.message}` : "An import folder item could not be ingested.";
        }
      }
    } catch (error) {
      lastError = error instanceof AppError ? `${error.code}: ${error.message}` : "The import folder could not be scanned.";
    } finally {
      this.scanning = false;
      const current = this.state.getImportFolder(key);
      if (current) await this.state.setImportFolder(key, {
        path: current.path, enabled: current.enabled, lastScannedAt: this.now().toISOString(),
        ...(lastError ? { lastError } : {})
      });
    }
    return this.status();
  }

  private async restart(): Promise<void> {
    this.stop();
    if (!this.workspaces.current()) return;
    const value = this.state.getImportFolder(this.workspaceKey());
    if (!value?.enabled) return;
    try {
      this.watcher = watch(value.path, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => void this.scanNow(), 2_000);
      });
      this.watcher.on("error", () => { this.watching = false; });
      this.watching = true;
      this.interval = setInterval(() => void this.scanNow(), this.reconcileMs);
      this.interval.unref();
    } catch {
      this.watching = false;
    }
  }

  private workspaceKey(): string {
    const workspace = this.workspaces.current()?.workspace;
    if (!workspace) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return `${workspace.id}:${resolve(workspace.rootPath)}`;
  }
}
