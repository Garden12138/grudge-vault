import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { KeyProtectorPort, WorkspaceManagerPort, WorkspaceSession } from "@grudge-vault/application";
import type { Workspace } from "@grudge-vault/domain";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import { openDatabase, SqliteWorkspaceDatabase } from "@grudge-vault/persistence-sqlite";
import { AppError } from "@grudge-vault/shared";

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

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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
      this.session = {
        workspace,
        key,
        assets: openedDatabase.assets,
        jobs: openedDatabase.jobs,
        vault,
        close: async () => {
          openedDatabase.close();
          key.fill(0);
        }
      };
      await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: rootPath });
      return this.session;
    } catch (error) {
      database?.close();
      key.fill(0);
      throw error;
    }
  }
}
