import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { KeyProtectorPort, WorkspaceManagerPort, WorkspaceSession } from "@grudge-vault/application";
import type { Workspace } from "@grudge-vault/domain";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import {
  inspectWorkspaceSnapshot, openDatabase, prepareRestoredSnapshot, SqliteWorkspaceDatabase
} from "@grudge-vault/persistence-sqlite";
import { AppError, type BackupSummary } from "@grudge-vault/shared";

const WORKSPACE_FORMAT_VERSION = 1;
const configSchema = z.object({
  formatVersion: z.literal(WORKSPACE_FORMAT_VERSION),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  keyProtection: z.object({ provider: z.literal("electron-safe-storage"), version: z.literal(1) }),
  keyEnvelope: z.string().min(1)
});
type WorkspaceConfig = z.infer<typeof configSchema>;

const recentSchema = z.object({ recentWorkspacePath: z.string() });
const backupManifestSchema = z.object({
  formatVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({
    path: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }))
});
type BackupManifest = z.infer<typeof backupManifestSchema>;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(rootPath: string, currentPath = rootPath): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(currentPath, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(rootPath, path));
    else if (entry.isFile()) files.push(relative(rootPath, path));
  }
  return files.sort();
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

function objectRelativePath(sha256: string): string {
  return join("vault", "objects", "sha256", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.gvobj`);
}

function assertSafeManifestPath(path: string): void {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) {
    throw new AppError("BACKUP_INVALID", "The backup manifest contains an unsafe path.");
  }
}

export class LocalWorkspaceManager implements WorkspaceManagerPort {
  private session: WorkspaceSession | undefined;

  constructor(
    private readonly keyProtector: KeyProtectorPort,
    private readonly recentStatePath: string
  ) {}

  current(): WorkspaceSession | undefined {
    return this.session;
  }

  async create(rootPath: string, name: string): Promise<WorkspaceSession> {
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "Workspace paths must be absolute.");
    const normalizedName = name.trim();
    if (!normalizedName) throw new AppError("VALIDATION_FAILED", "Workspace name is required.");
    await this.keyProtector.assertAvailable();
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const entries = await readdir(rootPath);
    if (entries.length > 0) {
      if (entries.includes("workspace.json")) {
        throw new AppError("WORKSPACE_EXISTS", "This directory already contains a workspace.");
      }
      throw new AppError("WORKSPACE_INVALID", "Choose an empty directory for a new workspace.");
    }

    const now = new Date().toISOString();
    const key = randomBytes(32);
    const config: WorkspaceConfig = {
      formatVersion: WORKSPACE_FORMAT_VERSION,
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      keyProtection: { provider: "electron-safe-storage", version: 1 },
      keyEnvelope: await this.keyProtector.protect(key)
    };
    key.fill(0);
    await atomicWriteJson(join(rootPath, "workspace.json"), config);
    return this.openConfig(rootPath, config);
  }

  async open(rootPath: string): Promise<WorkspaceSession> {
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "Workspace paths must be absolute.");
    let config: WorkspaceConfig;
    try {
      config = configSchema.parse(JSON.parse(await readFile(join(rootPath, "workspace.json"), "utf8")));
    } catch (cause) {
      throw new AppError("WORKSPACE_INVALID", "The selected directory is not a supported Grudge Vault workspace.", false, { cause });
    }
    return this.openConfig(rootPath, config);
  }

  async openRecent(): Promise<WorkspaceSession | undefined> {
    try {
      const recent = recentSchema.parse(JSON.parse(await readFile(this.recentStatePath, "utf8")));
      if (!(await exists(join(recent.recentWorkspacePath, "workspace.json")))) return undefined;
      return await this.open(recent.recentWorkspacePath);
    } catch {
      return undefined;
    }
  }

  async createBackup(destinationPath: string): Promise<BackupSummary> {
    const session = this.session;
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace before creating a backup.");
    if (!isAbsolute(destinationPath)) throw new AppError("BACKUP_INVALID", "Backup paths must be absolute.");
    if (isInside(session.workspace.rootPath, destinationPath)) {
      throw new AppError("BACKUP_INVALID", "Store the backup outside the active workspace.");
    }
    if (await exists(destinationPath)) throw new AppError("BACKUP_EXISTS", "The backup destination already exists.");
    const staging = join(dirname(destinationPath), `.${randomUUID()}.gvbackup.tmp`);
    try {
      await mkdir(join(staging, "db"), { recursive: true, mode: 0o700 });
      await session.backupDatabase(join(staging, "db", "grudge-vault.sqlite3"));
      await cp(join(session.workspace.rootPath, "workspace.json"), join(staging, "workspace.json"));
      const objectsSource = join(session.workspace.rootPath, "vault", "objects");
      if (await exists(objectsSource)) {
        await cp(objectsSource, join(staging, "vault", "objects"), { recursive: true, preserveTimestamps: true });
      }
      const snapshot = inspectWorkspaceSnapshot(join(staging, "db", "grudge-vault.sqlite3"));
      if (snapshot.workspaceId !== session.workspace.id) throw new AppError("BACKUP_INVALID", "The database belongs to another workspace.");
      for (const sha256 of snapshot.assetHashes) {
        if (!(await exists(join(staging, objectRelativePath(sha256))))) {
          throw new AppError("BACKUP_INVALID", `The encrypted object ${sha256} is missing.`);
        }
      }
      const createdAt = new Date().toISOString();
      const filePaths = await listFiles(staging);
      const files: BackupManifest["files"] = [];
      for (const filePath of filePaths) {
        const absolutePath = join(staging, filePath);
        files.push({ path: filePath, byteSize: (await stat(absolutePath)).size, sha256: await hashFile(absolutePath) });
      }
      const manifest: BackupManifest = { formatVersion: 1, workspaceId: session.workspace.id, createdAt, files };
      await atomicWriteJson(join(staging, "manifest.json"), manifest);
      const manifestSize = (await stat(join(staging, "manifest.json"))).size;
      await rename(staging, destinationPath);
      return {
        path: destinationPath, workspaceId: session.workspace.id, createdAt,
        fileCount: files.length + 1,
        byteSize: files.reduce((sum, file) => sum + file.byteSize, manifestSize)
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_INVALID", "The backup could not be created.", true, { cause: error });
    }
  }

  async restoreBackup(backupPath: string, destinationPath: string): Promise<WorkspaceSession> {
    if (!isAbsolute(backupPath) || !isAbsolute(destinationPath) || dirname(destinationPath) === destinationPath) {
      throw new AppError("BACKUP_INVALID", "Backup and restore paths must be safe absolute paths.");
    }
    if (isInside(backupPath, destinationPath)) {
      throw new AppError("BACKUP_INVALID", "The restore destination must be outside the backup directory.");
    }
    const destinationExists = await exists(destinationPath);
    if (destinationExists) {
      const destinationMetadata = await lstat(destinationPath);
      if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink() || (await readdir(destinationPath)).length > 0) {
        throw new AppError("WORKSPACE_INVALID", "Choose an empty, regular directory for the restored workspace.");
      }
    }
    const staging = join(dirname(destinationPath), `.${randomUUID()}.restore.tmp`);
    try {
      const manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8")));
      for (const file of manifest.files) {
        assertSafeManifestPath(file.path);
        const path = join(backupPath, file.path);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.byteSize || await hashFile(path) !== file.sha256) {
          throw new AppError("BACKUP_INVALID", `Backup verification failed for ${file.path}.`);
        }
      }
      const required = ["workspace.json", join("db", "grudge-vault.sqlite3")];
      if (required.some((path) => !manifest.files.some((file) => file.path === path))) {
        throw new AppError("BACKUP_INVALID", "The backup is missing required workspace files.");
      }
      const config = configSchema.parse(JSON.parse(await readFile(join(backupPath, "workspace.json"), "utf8")));
      if (config.id !== manifest.workspaceId) throw new AppError("BACKUP_INVALID", "The backup workspace identity does not match.");
      const snapshot = inspectWorkspaceSnapshot(join(backupPath, "db", "grudge-vault.sqlite3"));
      if (snapshot.workspaceId !== manifest.workspaceId) throw new AppError("BACKUP_INVALID", "The backup database identity does not match.");
      for (const sha256 of snapshot.assetHashes) {
        const path = objectRelativePath(sha256);
        if (!manifest.files.some((file) => file.path === path)) {
          throw new AppError("BACKUP_INVALID", `The backup does not contain encrypted object ${sha256}.`);
        }
      }
      const unlocked = await this.keyProtector.unprotect(config.keyEnvelope);
      unlocked.key.fill(0);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      for (const file of manifest.files) {
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(join(backupPath, file.path), target);
      }
      prepareRestoredSnapshot(join(staging, "db", "grudge-vault.sqlite3"), new Date().toISOString());
      if (destinationExists) await rmdir(destinationPath);
      await rename(staging, destinationPath);
      return await this.open(destinationPath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_INVALID", "The selected backup is invalid or cannot be restored.", false, { cause: error });
    }
  }

  async close(): Promise<void> {
    const current = this.session;
    this.session = undefined;
    if (current) await current.close();
  }

  private async openConfig(rootPath: string, config: WorkspaceConfig): Promise<WorkspaceSession> {
    const unlocked = await this.keyProtector.unprotect(config.keyEnvelope);
    if (unlocked.refreshedEnvelope) {
      config = { ...config, keyEnvelope: unlocked.refreshedEnvelope, updatedAt: new Date().toISOString() };
      await atomicWriteJson(join(rootPath, "workspace.json"), config);
    }
    await this.close();
    await Promise.all([
      mkdir(join(rootPath, "db"), { recursive: true, mode: 0o700 }),
      mkdir(join(rootPath, "logs"), { recursive: true, mode: 0o700 })
    ]);
    const key = unlocked.key;
    let database: SqliteWorkspaceDatabase | undefined;
    try {
      const vault = new EncryptedObjectVault(join(rootPath, "vault"));
      await vault.initialize();
      database = new SqliteWorkspaceDatabase(await openDatabase(join(rootPath, "db", "grudge-vault.sqlite3")));
      const workspace: Workspace = {
        id: config.id,
        name: config.name,
        rootPath,
        formatVersion: config.formatVersion,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt
      };
      database.ensureWorkspace(workspace);
      const openedDatabase = database;
      const session: WorkspaceSession = {
        workspace,
        key,
        assets: openedDatabase.assets,
        jobs: openedDatabase.jobs,
        memory: openedDatabase.memory,
        agents: openedDatabase.agents,
        dayOne: openedDatabase.dayOne,
        vault,
        backupDatabase: (destinationPath) => openedDatabase.backup(destinationPath),
        close: async () => {
          openedDatabase.close();
          key.fill(0);
        }
      };
      this.session = session;
      await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: rootPath });
      return session;
    } catch (error) {
      database?.close();
      key.fill(0);
      throw error;
    }
  }
}
