import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { KeyProtectorPort, WorkspaceKeyRing, WorkspaceManagerPort, WorkspaceSession } from "@grudge-vault/application";
import type { RecoveryPackageSummary, Workspace, WorkspaceCryptoStatus, WorkspaceLockState, WorkspaceSecuritySettings } from "@grudge-vault/domain";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import {
  inspectWorkspaceSnapshot, openDatabase, prepareRestoredSnapshot, SqliteWorkspaceDatabase
} from "@grudge-vault/persistence-sqlite";
import { AppError, type BackupSummary } from "@grudge-vault/shared";

const WORKSPACE_FORMAT_VERSION = 2;
const legacyConfigSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  keyProtection: z.object({ provider: z.literal("electron-safe-storage"), version: z.literal(1) }),
  keyEnvelope: z.string().min(1)
});
const keySlotSchema = z.object({
  id: z.string().uuid(), envelope: z.string().min(1), status: z.enum(["active", "retiring", "pending"]), createdAt: z.iso.datetime()
});
const configV2Schema = z.object({
  formatVersion: z.literal(WORKSPACE_FORMAT_VERSION), id: z.string().uuid(), name: z.string().min(1).max(120),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  keyProtection: z.object({ provider: z.literal("electron-safe-storage"), version: z.literal(1) }),
  crypto: z.object({
    activeKeyId: z.string().uuid(), legacyKeyId: z.string().uuid(), pendingKeyId: z.string().uuid().optional(),
    keyEpoch: z.number().int().positive(), migrationState: z.enum(["idle", "queued", "running", "failed"]),
    lastError: z.string().optional(), keys: z.array(keySlotSchema).min(1)
  }),
  security: z.object({
    autoLockMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]),
    integrityScanIntervalDays: z.number().int().min(1).max(365)
  })
});
const configSchema = z.union([legacyConfigSchema, configV2Schema]);
type WorkspaceConfig = z.infer<typeof configV2Schema>;

const recentSchema = z.object({ recentWorkspacePath: z.string() });
const backupManifestSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  workspaceId: z.string().uuid(),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({
    path: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }))
});
type BackupManifest = z.infer<typeof backupManifestSchema>;

const recoverySchema = z.object({
  formatVersion: z.literal(1), workspaceId: z.string().uuid(), keyEpoch: z.number().int().positive(), createdAt: z.iso.datetime(),
  kdf: z.object({ name: z.literal("scrypt"), salt: z.string(), N: z.literal(131072), r: z.literal(8), p: z.literal(1), maxmem: z.literal(268435456) }),
  cipher: z.object({ name: z.literal("aes-256-gcm"), iv: z.string(), authTag: z.string(), ciphertext: z.string() })
});
function deriveRecoveryKey(passphrase: string, salt: Buffer, options: {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

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
  private locked: { rootPath: string; workspaceId: string; workspaceName: string } | undefined;
  private currentConfig: WorkspaceConfig | undefined;

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
    const keyId = randomUUID();
    let keyEnvelope: string;
    try { keyEnvelope = await this.keyProtector.protect(key); }
    finally { key.fill(0); }
    const config: WorkspaceConfig = {
      formatVersion: WORKSPACE_FORMAT_VERSION,
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      keyProtection: { provider: "electron-safe-storage", version: 1 },
      crypto: {
        activeKeyId: keyId, legacyKeyId: keyId, keyEpoch: 1, migrationState: "idle",
        keys: [{ id: keyId, envelope: keyEnvelope, status: "active", createdAt: now }]
      },
      security: { autoLockMinutes: 15, integrityScanIntervalDays: 30 }
    };
    await atomicWriteJson(join(rootPath, "workspace.json"), config);
    return this.openConfig(rootPath, config);
  }

  async open(rootPath: string): Promise<WorkspaceSession> {
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "Workspace paths must be absolute.");
    let parsed: z.infer<typeof configSchema>;
    try {
      parsed = configSchema.parse(JSON.parse(await readFile(join(rootPath, "workspace.json"), "utf8")));
    } catch (cause) {
      throw new AppError("WORKSPACE_INVALID", "The selected directory is not a supported Grudge Vault workspace.", false, { cause });
    }
    const config = parsed.formatVersion === 1 ? await this.upgradeLegacyConfig(rootPath, parsed) : parsed;
    try {
      return await this.openConfig(rootPath, config);
    } catch (error) {
      if (error instanceof AppError && error.code === "WORKSPACE_KEY_UNAVAILABLE") {
        this.locked = { rootPath, workspaceId: config.id, workspaceName: config.name };
        this.currentConfig = config;
      }
      throw error;
    }
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

  status(): WorkspaceLockState {
    if (this.session) return { status: "open", workspace: this.session.workspace };
    if (this.locked) return { status: "locked", workspaceId: this.locked.workspaceId, workspaceName: this.locked.workspaceName };
    return { status: "closed" };
  }

  async lock(): Promise<WorkspaceLockState> {
    const current = this.session;
    if (!current) return this.status();
    this.locked = { rootPath: current.workspace.rootPath, workspaceId: current.workspace.id, workspaceName: current.workspace.name };
    this.session = undefined;
    await current.close();
    return this.status();
  }

  async unlock(): Promise<WorkspaceSession> {
    if (!this.locked) throw new AppError("WORKSPACE_LOCKED", "No locked workspace is available to unlock.");
    return this.open(this.locked.rootPath);
  }

  getSecuritySettings(): WorkspaceSecuritySettings {
    if (!this.currentConfig) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return this.currentConfig.security;
  }

  async updateSecuritySettings(settings: WorkspaceSecuritySettings): Promise<WorkspaceSecuritySettings> {
    const current = this.currentConfig;
    const rootPath = this.session?.workspace.rootPath ?? this.locked?.rootPath;
    if (!current || !rootPath) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    if (![0, 5, 15, 30, 60].includes(settings.autoLockMinutes) || settings.integrityScanIntervalDays < 1 || settings.integrityScanIntervalDays > 365) {
      throw new AppError("VALIDATION_FAILED", "Workspace security settings are invalid.");
    }
    this.currentConfig = { ...current, security: settings, updatedAt: new Date().toISOString() };
    await atomicWriteJson(join(rootPath, "workspace.json"), this.currentConfig);
    return settings;
  }

  async exportRecovery(path: string, passphrase: string): Promise<RecoveryPackageSummary> {
    const session = this.session;
    const config = this.currentConfig;
    if (!session || !config) throw new AppError("NO_ACTIVE_WORKSPACE", "Unlock the workspace before exporting recovery material.");
    if (Array.from(passphrase).length < 12) throw new AppError("VALIDATION_FAILED", "Recovery passphrases must contain at least 12 characters.");
    if (await exists(path)) throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery destination already exists.");
    const salt = randomBytes(16);
    const derived = await deriveRecoveryKey(passphrase, salt, { N: 131072, r: 8, p: 1, maxmem: 268435456 });
    let payload: Buffer | undefined;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", derived, iv);
      const aad = Buffer.from(`grudge-vault:recovery:${config.id}:${config.crypto.keyEpoch}:v1`, "utf8");
      cipher.setAAD(aad);
      payload = Buffer.from(JSON.stringify({
        activeKeyId: config.crypto.activeKeyId, legacyKeyId: config.crypto.legacyKeyId, pendingKeyId: config.crypto.pendingKeyId,
        keys: [...(session.keyRing?.keys ?? new Map([[config.crypto.activeKeyId, session.key]])).entries()]
          .map(([id, key]) => ({ id, key: key.toString("base64") }))
      }), "utf8");
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const createdAt = new Date().toISOString();
      await atomicWriteJson(path, {
        formatVersion: 1, workspaceId: config.id, keyEpoch: config.crypto.keyEpoch, createdAt,
        kdf: { name: "scrypt", salt: salt.toString("base64"), N: 131072, r: 8, p: 1, maxmem: 268435456 },
        cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }
      });
      return { formatVersion: 1, workspaceId: config.id, keyEpoch: config.crypto.keyEpoch, createdAt, keyCount: config.crypto.keys.length };
    } finally {
      payload?.fill(0);
      derived.fill(0);
    }
  }

  async recover(path: string, passphrase: string): Promise<WorkspaceSession> {
    const rootPath = this.locked?.rootPath;
    const config = this.currentConfig;
    if (!rootPath || !config) throw new AppError("RECOVERY_PACKAGE_INVALID", "Select the locked workspace before importing its recovery package.");
    try {
      const recovery = recoverySchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (recovery.workspaceId !== config.id || recovery.keyEpoch !== config.crypto.keyEpoch) {
        throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery package belongs to another workspace or key epoch.");
      }
      const salt = Buffer.from(recovery.kdf.salt, "base64");
      const iv = Buffer.from(recovery.cipher.iv, "base64");
      const authTag = Buffer.from(recovery.cipher.authTag, "base64");
      if (salt.length !== 16 || iv.length !== 12 || authTag.length !== 16) throw new Error("Invalid recovery parameters.");
      const derived = await deriveRecoveryKey(passphrase, salt,
        { N: recovery.kdf.N, r: recovery.kdf.r, p: recovery.kdf.p, maxmem: recovery.kdf.maxmem });
      let plaintext: Buffer | undefined;
      let payload: { activeKeyId: string; legacyKeyId: string; pendingKeyId?: string | undefined; keys: Array<{ id: string; key: string }> };
      try {
        const decipher = createDecipheriv("aes-256-gcm", derived, iv);
        decipher.setAAD(Buffer.from(`grudge-vault:recovery:${config.id}:${config.crypto.keyEpoch}:v1`, "utf8"));
        decipher.setAuthTag(authTag);
        plaintext = Buffer.concat([decipher.update(Buffer.from(recovery.cipher.ciphertext, "base64")), decipher.final()]);
        payload = z.object({
          activeKeyId: z.string().uuid(), legacyKeyId: z.string().uuid(), pendingKeyId: z.string().uuid().optional(),
          keys: z.array(z.object({ id: z.string().uuid(), key: z.string() })).min(1)
        }).parse(JSON.parse(plaintext.toString("utf8")));
      } finally {
        plaintext?.fill(0);
        derived.fill(0);
      }
      if (payload.activeKeyId !== config.crypto.activeKeyId || payload.legacyKeyId !== config.crypto.legacyKeyId ||
        payload.pendingKeyId !== config.crypto.pendingKeyId || payload.keys.length !== config.crypto.keys.length) {
        throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery key set does not match the current workspace epoch.");
      }
      const now = new Date().toISOString();
      const keyMap = new Map(payload.keys.map(({ id, key }) => [id, Buffer.from(key, "base64")]));
      try {
        for (const key of keyMap.values()) if (key.length !== 32) throw new Error("Invalid recovered key length.");
        const keys = [];
        for (const slot of config.crypto.keys) {
          const key = keyMap.get(slot.id);
          if (!key) throw new Error("Recovery package is missing a required key.");
          keys.push({ ...slot, envelope: await this.keyProtector.protect(key) });
        }
        const updated: WorkspaceConfig = { ...config, updatedAt: now, crypto: { ...config.crypto, keys } };
        await atomicWriteJson(join(rootPath, "workspace.json"), updated);
        this.currentConfig = updated;
        return await this.openConfig(rootPath, updated);
      } finally {
        for (const key of keyMap.values()) key.fill(0);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery package or passphrase is invalid.", false, { cause: error });
    }
  }

  async prepareKeyRotation(): Promise<WorkspaceCryptoStatus> {
    const session = this.session;
    const config = this.currentConfig;
    if (!session || !config) throw new AppError("NO_ACTIVE_WORKSPACE", "Unlock the workspace before rotating its key.");
    if (config.crypto.migrationState !== "idle") throw new AppError("CRYPTO_MIGRATION_CONFLICT", "Finish the current encryption migration first.");
    const key = randomBytes(32); const keyId = randomUUID(); const now = new Date().toISOString();
    let retained = false;
    try {
      const envelope = await this.keyProtector.protect(key);
      const updated: WorkspaceConfig = {
        ...config, updatedAt: now,
        crypto: {
          ...config.crypto, pendingKeyId: keyId, keyEpoch: config.crypto.keyEpoch + 1, migrationState: "queued",
          keys: [...config.crypto.keys.map((slot) => ({ ...slot, status: slot.id === config.crypto.activeKeyId ? "retiring" as const : slot.status })),
            { id: keyId, envelope, status: "pending", createdAt: now }]
        }
      };
      await atomicWriteJson(join(session.workspace.rootPath, "workspace.json"), updated);
      const currentRing = session.keyRing ?? { activeKeyId: config.crypto.activeKeyId, legacyKeyId: config.crypto.legacyKeyId,
        keys: new Map([[config.crypto.activeKeyId, session.key]]) };
      session.keyRing = { ...currentRing, activeKeyId: keyId, keys: new Map([...currentRing.keys, [keyId, key]]) };
      retained = true;
      this.currentConfig = updated;
      return this.getCryptoStatus();
    } finally {
      if (!retained) key.fill(0);
    }
  }

  async completeKeyRotation(targetKeyId: string): Promise<WorkspaceCryptoStatus> {
    const session = this.session; const config = this.currentConfig;
    if (!session || !config || !session.keyRing) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "No encryption migration is active.");
    const nextKey = session.keyRing.keys.get(targetKeyId);
    if (!nextKey) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The target Workspace Key is unavailable.");
    const slot = config.crypto.keys.find(({ id }) => id === targetKeyId);
    if (!slot) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The target key slot is unavailable.");
    const updated: WorkspaceConfig = {
      ...config, updatedAt: new Date().toISOString(),
      crypto: { activeKeyId: targetKeyId, legacyKeyId: targetKeyId, keyEpoch: config.crypto.keyEpoch,
        migrationState: "idle", keys: [{ ...slot, status: "active" }] }
    };
    await atomicWriteJson(join(session.workspace.rootPath, "workspace.json"), updated);
    for (const [id, key] of session.keyRing.keys) if (id !== targetKeyId) key.fill(0);
    if (session.key !== nextKey) session.key.fill(0);
    session.key = nextKey;
    session.keyRing = { activeKeyId: targetKeyId, legacyKeyId: targetKeyId, keys: new Map([[targetKeyId, nextKey]]) };
    this.currentConfig = updated;
    return this.getCryptoStatus();
  }

  getCryptoStatus(): WorkspaceCryptoStatus {
    const config = this.currentConfig;
    if (!config) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return {
      workspaceFormatVersion: 2, objectFormatVersion: 2,
      activeKeyId: config.crypto.pendingKeyId ?? config.crypto.activeKeyId, keyEpoch: config.crypto.keyEpoch,
      retiringKeyIds: config.crypto.keys.filter(({ status }) => status === "retiring").map(({ id }) => id),
      migrationState: config.crypto.migrationState, processedObjects: 0, totalObjects: this.session?.assets.list().length ?? 0,
      ...(config.crypto.lastError ? { lastError: config.crypto.lastError } : {})
    };
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
      const manifest: BackupManifest = { formatVersion: 2, workspaceId: session.workspace.id, createdAt, files };
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
      const envelope = config.formatVersion === 1
        ? config.keyEnvelope
        : config.crypto.keys.find(({ id }) => id === config.crypto.activeKeyId)?.envelope;
      if (!envelope) throw new AppError("BACKUP_INVALID", "The backup has no active Workspace Key envelope.");
      const unlocked = await this.keyProtector.unprotect(envelope);
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
    this.locked = undefined;
    this.currentConfig = undefined;
  }

  private async openConfig(rootPath: string, config: WorkspaceConfig): Promise<WorkspaceSession> {
    const keyValues = new Map<string, Buffer>();
    const refreshed = [];
    try {
      for (const slot of config.crypto.keys) {
        const unlocked = await this.keyProtector.unprotect(slot.envelope);
        keyValues.set(slot.id, unlocked.key);
        refreshed.push(unlocked.refreshedEnvelope ? { ...slot, envelope: unlocked.refreshedEnvelope } : slot);
      }
    } catch (error) {
      for (const key of keyValues.values()) key.fill(0);
      throw error;
    }
    if (refreshed.some((slot, index) => slot.envelope !== config.crypto.keys[index]?.envelope)) {
      config = { ...config, crypto: { ...config.crypto, keys: refreshed }, updatedAt: new Date().toISOString() };
      await atomicWriteJson(join(rootPath, "workspace.json"), config);
    }
    await this.close();
    await Promise.all([
      mkdir(join(rootPath, "db"), { recursive: true, mode: 0o700 }),
      mkdir(join(rootPath, "logs"), { recursive: true, mode: 0o700 })
    ]);
    const key = keyValues.get(config.crypto.activeKeyId);
    if (!key) throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "The active Workspace Key is unavailable.");
    const keyRing: WorkspaceKeyRing = {
      activeKeyId: config.crypto.pendingKeyId ?? config.crypto.activeKeyId,
      legacyKeyId: config.crypto.legacyKeyId,
      keys: keyValues
    };
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
        keyRing,
        assets: openedDatabase.assets,
        jobs: openedDatabase.jobs,
        memory: openedDatabase.memory,
        agents: openedDatabase.agents,
        phase5: openedDatabase.phase5,
        phase6: openedDatabase.phase6,
        dayOne: openedDatabase.dayOne,
        vault,
        backupDatabase: (destinationPath) => openedDatabase.backup(destinationPath),
        close: async () => {
          try { openedDatabase.close(); }
          finally { for (const value of keyValues.values()) value.fill(0); }
        }
      };
      this.session = session;
      this.currentConfig = config;
      this.locked = undefined;
      await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: rootPath });
      return session;
    } catch (error) {
      database?.close();
      for (const value of keyValues.values()) value.fill(0);
      throw error;
    }
  }

  private async upgradeLegacyConfig(rootPath: string, legacy: z.infer<typeof legacyConfigSchema>): Promise<WorkspaceConfig> {
    const unlocked = await this.keyProtector.unprotect(legacy.keyEnvelope);
    try {
      const keyId = randomUUID();
      const now = new Date().toISOString();
      const config: WorkspaceConfig = {
        formatVersion: 2, id: legacy.id, name: legacy.name, createdAt: legacy.createdAt, updatedAt: now,
        keyProtection: legacy.keyProtection,
        crypto: {
          activeKeyId: keyId, legacyKeyId: keyId, keyEpoch: 1, migrationState: "queued",
          keys: [{ id: keyId, envelope: await this.keyProtector.protect(unlocked.key), status: "active", createdAt: now }]
        },
        security: { autoLockMinutes: 15, integrityScanIntervalDays: 30 }
      };
      await atomicWriteJson(join(rootPath, "workspace.json"), config);
      return config;
    } finally {
      unlocked.key.fill(0);
    }
  }
}
