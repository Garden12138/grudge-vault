import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import Database from "better-sqlite3";
import type {
  KeyProtectorPort, LegacyMigrationSourcePort, VaultKey, WorkspaceKeyRing, WorkspaceManagerPort, WorkspaceSession
} from "@grudge-vault/application";
import type {
  Event, RecoveryPackageSummary, Workspace, WorkspaceCryptoStatus, WorkspaceLockState, WorkspaceSecuritySettings
} from "@grudge-vault/domain";
import { EncryptedObjectVault } from "@grudge-vault/object-vault";
import {
  inspectWorkspaceSnapshot, openDatabase, prepareRestoredSnapshot, SqliteWorkspaceDatabase
} from "@grudge-vault/persistence-sqlite";
import { AppError, type BackupSummary, type WorkspaceUnlockInput, type WorkspacePasswordInput } from "@grudge-vault/shared";
import { createWorkspacePassword, verifyWorkspacePassword, workspacePasswordSchema } from "./workspace-password";

const WORKSPACE_FORMAT_VERSION = 3;
const TRANSIENT_DIRECTORY_NAME = ".grudge-vault-redesign-transient-v1";
const TRANSIENT_MARKER_NAME = ".owned-by-grudge-vault";
const TRANSIENT_MARKER = "grudge-vault-redesign-transient-v1\n";
const IGNORABLE_DIRECTORY_METADATA = new Set([".DS_Store"]);
const MIGRATABLE_MEDIA_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".mp3", ".m4a", ".wav", ".mp4", ".mov"
]);
const MEDIA_EXTENSION_BY_MIME = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["image/heic", ".heic"],
  ["audio/mpeg", ".mp3"], ["audio/mp4", ".m4a"], ["audio/wav", ".wav"],
  ["video/mp4", ".mp4"], ["video/quicktime", ".mov"]
]);
const MAX_MIGRATION_ATTACHMENTS = 20;
const MAX_MIGRATION_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MAX_MIGRATION_TEXT_CODEPOINTS = 50_000;
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
  formatVersion: z.literal(2), id: z.string().uuid(), name: z.string().min(1).max(120),
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
const configV3Schema = configV2Schema.extend({ formatVersion: z.literal(WORKSPACE_FORMAT_VERSION), password: workspacePasswordSchema.optional() });
const configSchema = z.union([legacyConfigSchema, configV2Schema, configV3Schema]);
type WorkspaceConfig = z.infer<typeof configV3Schema>;

const legacyEventSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  occurredAt: z.object({ kind: z.enum(["instant", "date", "month", "range", "relative", "unknown"]) }).passthrough(),
  recordedAt: z.string().min(1),
  narrative: z.string().optional(),
  facts: z.array(z.object({ text: z.string() }).passthrough()).default([]),
  interpretations: z.array(z.object({ text: z.string() }).passthrough()).default([]),
  emotions: z.array(z.object({ label: z.string() }).passthrough()).default([]),
  interests: z.array(z.object({ label: z.string(), description: z.string().optional() }).passthrough()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  assetRefs: z.array(z.string()).default([]),
  currentRevision: z.number().int().positive()
}).passthrough();

const recentSchema = z.object({ recentWorkspacePath: z.string() });
const backupManifestSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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

async function lstatIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function meaningfulDirectoryEntries(entries: string[]): string[] {
  return entries.filter((entry) => !IGNORABLE_DIRECTORY_METADATA.has(entry));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function hasTable(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function truncateCodePoints(value: string, limit: number): { value: string; truncated: boolean } {
  const points = Array.from(value);
  return points.length > limit
    ? { value: points.slice(0, limit).join(""), truncated: true }
    : { value, truncated: false };
}

function renderLegacyEvent(event: Event, sourceContents: readonly string[]): string {
  const sections = [
    event.title,
    event.narrative,
    event.facts.length ? `事实：\n${event.facts.map(({ text }) => `- ${text}`).join("\n")}` : undefined,
    event.interpretations.length ? `解读：\n${event.interpretations.map(({ text }) => `- ${text}`).join("\n")}` : undefined,
    event.emotions.length ? `感受：${event.emotions.map(({ label }) => label).join("、")}` : undefined,
    event.interests.length
      ? `诉求：\n${event.interests.map(({ label, description }) => `- ${label}${description ? `：${description}` : ""}`).join("\n")}`
      : undefined,
    ...sourceContents.map((content, index) => `来源 ${index + 1}：\n${content}`)
  ];
  return sections.filter((value): value is string => Boolean(value?.trim())).join("\n\n");
}

function zeroVaultKey(key: VaultKey): void {
  if (Buffer.isBuffer(key)) key.fill(0);
  else for (const value of key.keys.values()) value.fill(0);
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

async function canonicalFuturePath(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      if ((await lstatIfPresent(current))?.isSymbolicLink()) throw new Error("A destination ancestor is a dangling symbolic link.");
      missing.push(basename(current));
      current = dirname(current);
    }
  }
}

function objectRelativePath(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new AppError("BACKUP_INVALID", "The backup database contains an invalid object hash.");
  }
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
  private transientReady: Promise<void> | undefined;
  private configMutationTail: Promise<void> = Promise.resolve();
  private sessionTransitionTail: Promise<void> = Promise.resolve();
  private workspaceSelectionEpoch = 0;
  private passwordFailures = new Map<string, { count: number; blockedUntil: number }>();

  constructor(
    private readonly keyProtector: KeyProtectorPort,
    private readonly recentStatePath: string
  ) {}

  private async withConfigMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.configMutationTail;
    let release!: () => void;
    this.configMutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await mutation(); }
    finally { release(); }
  }

  private async withSessionTransition<T>(transition: () => Promise<T>): Promise<T> {
    const previous = this.sessionTransitionTail;
    let release!: () => void;
    this.sessionTransitionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await transition(); }
    finally { release(); }
  }

  private beginWorkspaceSelection(): () => void {
    const epoch = ++this.workspaceSelectionEpoch;
    return () => {
      if (epoch !== this.workspaceSelectionEpoch) {
        throw new AppError("WORKSPACE_LOCKED", "工作区选择已变化，请重新执行当前操作。", true);
      }
    };
  }

  current(): WorkspaceSession | undefined {
    return this.session;
  }

  async prepareTransientStorage(): Promise<void> {
    if (!this.transientReady) {
      this.transientReady = this.initializeTransientStorage().catch((cause) => {
        this.transientReady = undefined;
        if (cause instanceof AppError) throw cause;
        throw new AppError("CLEANUP_FAILED", "无法清理上次中断留下的临时处理文件。", true, { cause });
      });
    }
    return this.transientReady;
  }

  async createTransientDirectory(prefix: string): Promise<string> {
    if (!/^[a-z]+(?:-[a-z]+)*-$/.test(prefix)) throw new AppError("INVALID_INPUT", "临时目录类型无效。");
    await this.prepareTransientStorage();
    return mkdtemp(join(this.transientRoot(), prefix));
  }

  private transientRoot(): string {
    return join(dirname(this.recentStatePath), TRANSIENT_DIRECTORY_NAME);
  }

  private async initializeTransientStorage(): Promise<void> {
    const root = this.transientRoot();
    await mkdir(dirname(root), { recursive: true, mode: 0o700 });
    const previous = await lstat(root).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (previous) {
      if (!previous.isDirectory() || previous.isSymbolicLink() ||
        (previous.mode & 0o077) !== 0 ||
        (process.getuid && previous.uid !== process.getuid())) {
        throw new AppError("CLEANUP_FAILED", "临时处理目录的所有权或权限异常；未删除其中内容。", true);
      }
      const markerPath = join(root, TRANSIENT_MARKER_NAME);
      const marker = await lstat(markerPath).catch(() => undefined);
      if (!marker?.isFile() || marker.isSymbolicLink() || (marker.mode & 0o077) !== 0 ||
        (process.getuid && marker.uid !== process.getuid()) ||
        await readFile(markerPath, "utf8") !== TRANSIENT_MARKER) {
        throw new AppError("CLEANUP_FAILED", "临时处理目录缺少应用所有权标记；未删除其中内容。", true);
      }
      await rm(root, { recursive: true, force: false });
    }
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, TRANSIENT_MARKER_NAME), TRANSIENT_MARKER, { flag: "wx", mode: 0o600 });
  }

  async create(rootPath: string, name: string): Promise<WorkspaceSession> {
    const assertStillCurrent = this.beginWorkspaceSelection();
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "Workspace paths must be absolute.");
    const normalizedName = name.trim();
    if (!normalizedName) throw new AppError("VALIDATION_FAILED", "Workspace name is required.");
    await this.keyProtector.assertAvailable();
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const entries = meaningfulDirectoryEntries(await readdir(rootPath));
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
    assertStillCurrent();
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
    return this.openConfig(rootPath, config, assertStillCurrent);
  }

  async open(rootPath: string, assertStillCurrent = this.beginWorkspaceSelection(), password?: string, newPassword?: string): Promise<WorkspaceSession> {
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "Workspace paths must be absolute.");
    let parsed: z.infer<typeof configSchema>;
    try {
      parsed = configSchema.parse(JSON.parse(await readFile(join(rootPath, "workspace.json"), "utf8")));
    } catch (cause) {
      throw new AppError("WORKSPACE_INVALID", "The selected directory is not a supported Grudge Vault workspace.", false, { cause });
    }
    if (parsed.formatVersion !== WORKSPACE_FORMAT_VERSION) {
      throw new AppError(
        "WORKSPACE_MIGRATION_REQUIRED",
        "这是旧版工作区。请创建独立的新版工作区并从设置中执行筛选迁移；原工作区尚未被修改。"
      );
    }
    let config = parsed;
    if (config.password && !password) {
      await this.withSessionTransition(async () => {
        assertStillCurrent();
        const outgoing = this.session;
        this.session = undefined;
        this.locked = { rootPath, workspaceId: config.id, workspaceName: config.name };
        this.currentConfig = config;
        await outgoing?.close();
        await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: rootPath });
      });
      throw new AppError("WORKSPACE_PASSWORD_REQUIRED", "请输入账本密码，继续查看你的记录。", true);
    }
    if (config.password) {
      await this.withConfigMutation(async () => { assertStillCurrent(); await this.assertPassword(config, password); assertStillCurrent(); });
      if (newPassword) throw new AppError("VALIDATION_FAILED", "请先打开账本，再修改密码。");
    } else if (newPassword) {
      const candidate = { ...config, password: await createWorkspacePassword(newPassword), updatedAt: new Date().toISOString() };
      await this.withConfigMutation(async () => {
        assertStillCurrent();
        const latest = configV3Schema.parse(JSON.parse(await readFile(join(rootPath, "workspace.json"), "utf8")));
        if (latest.id !== config.id || latest.password || JSON.stringify(latest.crypto) !== JSON.stringify(config.crypto)) {
          throw new AppError("WORKSPACE_LOCKED", "账本设置已变化，请重新打开。", true);
        }
        config = { ...latest, password: candidate.password, updatedAt: candidate.updatedAt };
        await atomicWriteJson(join(rootPath, "workspace.json"), config);
        this.currentConfig = config;
      });
    }
    try {
      return await this.openConfig(rootPath, config, assertStillCurrent);
    } catch (error) {
      if (!this.session && error instanceof AppError && error.code === "WORKSPACE_KEY_UNAVAILABLE") {
        assertStillCurrent();
        this.locked = { rootPath, workspaceId: config.id, workspaceName: config.name };
        this.currentConfig = config;
      }
      throw error;
    }
  }

  async openRecent(): Promise<WorkspaceSession | undefined> {
    const assertStillCurrent = this.beginWorkspaceSelection();
    let recent: z.infer<typeof recentSchema>;
    try {
      recent = recentSchema.parse(JSON.parse(await readFile(this.recentStatePath, "utf8")));
    } catch {
      return undefined;
    }
    if (!(await exists(join(recent.recentWorkspacePath, "workspace.json")))) return undefined;
    try {
      return await this.open(recent.recentWorkspacePath, assertStillCurrent);
    } catch (error) {
      if (error instanceof AppError && error.code === "CLEANUP_FAILED") throw error;
      return undefined;
    }
  }

  status(): WorkspaceLockState {
    if (this.session) return { status: "open", workspace: this.session.workspace };
    if (this.locked) return { status: "locked", workspaceId: this.locked.workspaceId, workspaceName: this.locked.workspaceName,
      ...(this.currentConfig?.password ? { passwordConfigured: true } : {}) };
    return { status: "closed" };
  }

  async lock(): Promise<WorkspaceLockState> {
    this.beginWorkspaceSelection();
    return this.withSessionTransition(async () => {
      const current = this.session;
      if (!current) return this.status();
      this.locked = { rootPath: current.workspace.rootPath, workspaceId: current.workspace.id, workspaceName: current.workspace.name };
      this.session = undefined;
      await current.close();
      return this.status();
    });
  }

  async unlock(input?: WorkspaceUnlockInput): Promise<WorkspaceSession> {
    if (!this.locked) throw new AppError("WORKSPACE_LOCKED", "No locked workspace is available to unlock.");
    return this.open(this.locked.rootPath, this.beginWorkspaceSelection(), input?.password, input?.newPassword);
  }

  passwordStatus(): { configured: boolean } {
    return { configured: Boolean(this.currentConfig?.password) };
  }

  private async assertPassword(config: WorkspaceConfig, password?: string): Promise<void> {
    if (!config.password) return;
    const failure = this.passwordFailures.get(config.id);
    if (failure && failure.blockedUntil > Date.now()) {
      throw new AppError("WORKSPACE_PASSWORD_THROTTLED", "尝试次数较多，请 30 秒后再试。", true);
    }
    if (!await verifyWorkspacePassword(config.password, password)) {
      const count = failure && failure.blockedUntil === 0 ? failure.count + 1 : 1;
      this.passwordFailures.set(config.id, { count, blockedUntil: count >= 5 ? Date.now() + 30_000 : 0 });
      throw new AppError("WORKSPACE_PASSWORD_INCORRECT", "密码不正确，请再试一次。", true);
    }
    this.passwordFailures.delete(config.id);
  }

  async setPassword(input: WorkspacePasswordInput): Promise<{ configured: boolean }> {
    const target = this.session;
    if (!target) throw new AppError("WORKSPACE_LOCKED", "请先打开账本，再设置密码。", true);
    return this.withConfigMutation(async () => {
      const config = this.currentConfig;
      if (!config || this.session !== target) throw new AppError("WORKSPACE_LOCKED", "账本已锁定，请重新打开。", true);
      await this.assertPassword(config, input.currentPassword);
      const password = await createWorkspacePassword(input.newPassword);
      if (this.session !== target || this.currentConfig !== config) throw new AppError("WORKSPACE_LOCKED", "账本已锁定或切换，密码尚未修改。", true);
      const latest = configV3Schema.parse(JSON.parse(await readFile(join(target.workspace.rootPath, "workspace.json"), "utf8")));
      if (latest.id !== config.id || JSON.stringify(latest.password) !== JSON.stringify(config.password)) {
        throw new AppError("WORKSPACE_LOCKED", "账本密码设置已变化，请重新打开。", true);
      }
      await this.withSessionTransition(async () => {
        if (this.session !== target || this.currentConfig !== config) throw new AppError("WORKSPACE_LOCKED", "账本已锁定或切换，密码尚未修改。", true);
        const updated = { ...config, password, updatedAt: new Date().toISOString() };
        await atomicWriteJson(join(target.workspace.rootPath, "workspace.json"), updated);
        this.currentConfig = updated;
      });
      return { configured: true };
    });
  }

  getSecuritySettings(): WorkspaceSecuritySettings {
    if (!this.currentConfig) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return this.currentConfig.security;
  }

  async updateSecuritySettings(settings: WorkspaceSecuritySettings): Promise<WorkspaceSecuritySettings> {
    const targetRootPath = this.session?.workspace.rootPath ?? this.locked?.rootPath;
    const targetWorkspaceId = this.currentConfig?.id;
    if (!targetRootPath || !targetWorkspaceId) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return this.withConfigMutation(async () => {
      const current = this.currentConfig;
      const rootPath = this.session?.workspace.rootPath ?? this.locked?.rootPath;
      if (!current || current.id !== targetWorkspaceId || rootPath !== targetRootPath) {
        throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新打开设置后再保存。", true);
      }
      if (![0, 5, 15, 30, 60].includes(settings.autoLockMinutes) || settings.integrityScanIntervalDays < 1 || settings.integrityScanIntervalDays > 365) {
        throw new AppError("VALIDATION_FAILED", "Workspace security settings are invalid.");
      }
      const updated = { ...current, security: settings, updatedAt: new Date().toISOString() };
      await atomicWriteJson(join(rootPath, "workspace.json"), updated);
      if (this.currentConfig === current) this.currentConfig = updated;
      return settings;
    });
  }

  async exportRecovery(path: string, passphrase: string): Promise<RecoveryPackageSummary> {
    const targetSession = this.session;
    const targetWorkspaceId = this.currentConfig?.id;
    if (!targetSession || !targetWorkspaceId) {
      throw new AppError("NO_ACTIVE_WORKSPACE", "Unlock the workspace before exporting recovery material.");
    }
    return this.withConfigMutation(async () => {
      const session = this.session;
      const config = this.currentConfig;
      if (session !== targetSession || !config || config.id !== targetWorkspaceId) {
        throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新导出恢复包。", true);
      }
      if (Array.from(passphrase).length < 12) throw new AppError("VALIDATION_FAILED", "Recovery passphrases must contain at least 12 characters.");
      if (await exists(path)) throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery destination already exists.");
      const salt = randomBytes(16);
      const derived = await deriveRecoveryKey(passphrase, salt, { N: 131072, r: 8, p: 1, maxmem: 268435456 });
      let payload: Buffer | undefined;
      try {
        if (this.session !== session || this.currentConfig !== config) {
          throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新导出恢复包。", true);
        }
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
    });
  }

  async recover(path: string, passphrase: string): Promise<WorkspaceSession> {
    const assertStillCurrent = this.beginWorkspaceSelection();
    const targetRootPath = this.locked?.rootPath;
    const targetWorkspaceId = this.currentConfig?.id;
    if (!targetRootPath || !targetWorkspaceId) {
      throw new AppError("RECOVERY_PACKAGE_INVALID", "Select the locked workspace before importing its recovery package.");
    }
    const rebound = await this.withConfigMutation(async () => {
      assertStillCurrent();
      const rootPath = this.locked?.rootPath;
      const config = this.currentConfig;
      if (!rootPath || rootPath !== targetRootPath || !config || config.id !== targetWorkspaceId) {
        throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新选择恢复包。", true);
      }
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
          assertStillCurrent();
          if (this.locked?.rootPath !== rootPath || this.currentConfig !== config) {
            throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新选择恢复包。", true);
          }
          const updated: WorkspaceConfig = { ...config, updatedAt: now, crypto: { ...config.crypto, keys } };
          // A verified recovery package is the independent way to regain access after forgetting a password.
          delete updated.password;
          await atomicWriteJson(join(rootPath, "workspace.json"), updated);
          this.currentConfig = updated;
          return { rootPath, updated };
        } finally {
          for (const key of keyMap.values()) key.fill(0);
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("RECOVERY_PACKAGE_INVALID", "The recovery package or passphrase is invalid.", false, { cause: error });
      }
    });
    assertStillCurrent();
    return this.openConfig(rebound.rootPath, rebound.updated, () => {
      assertStillCurrent();
      if (this.locked?.rootPath !== rebound.rootPath || this.currentConfig?.id !== rebound.updated.id ||
        JSON.stringify(this.currentConfig.crypto) !== JSON.stringify(rebound.updated.crypto) || this.session) {
        throw new AppError("WORKSPACE_LOCKED", "工作区已变化，请重新选择恢复包。", true);
      }
    });
  }

  async prepareKeyRotation(): Promise<WorkspaceCryptoStatus> {
    return this.withConfigMutation(async () => {
      const session = this.session;
      const config = this.currentConfig;
      if (!session || !config) throw new AppError("NO_ACTIVE_WORKSPACE", "Unlock the workspace before rotating its key.");
      if (config.crypto.migrationState !== "idle") throw new AppError("CRYPTO_MIGRATION_CONFLICT", "Finish the current encryption migration first.");
      const key = randomBytes(32); const keyId = randomUUID(); const now = new Date().toISOString();
      let retained = false;
      try {
        const envelope = await this.keyProtector.protect(key);
        if (this.session !== session || this.currentConfig !== config) {
          throw new AppError("WORKSPACE_LOCKED", "工作区已锁定或切换；密钥轮换未开始。", true);
        }
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
    });
  }

  async completeKeyRotation(targetKeyId: string): Promise<WorkspaceCryptoStatus> {
    return this.withConfigMutation(async () => {
      const session = this.session; const config = this.currentConfig;
      if (!session || !config || !session.keyRing) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "No encryption migration is active.");
      const nextKey = session.keyRing.keys.get(targetKeyId);
      if (!nextKey) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The target Workspace Key is unavailable.");
      const slot = config.crypto.keys.find(({ id }) => id === targetKeyId);
      if (!slot) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "The target key slot is unavailable.");
      if (!session.records) throw new AppError("CRYPTO_MIGRATION_CONFLICT", "待确认项存储不可用，不能完成密钥轮换。");
      session.records.reencryptPending(targetKeyId);
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
    });
  }

  getCryptoStatus(): WorkspaceCryptoStatus {
    const config = this.currentConfig;
    if (!config) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace first.");
    return {
      workspaceFormatVersion: WORKSPACE_FORMAT_VERSION, objectFormatVersion: 2,
      activeKeyId: config.crypto.pendingKeyId ?? config.crypto.activeKeyId, keyEpoch: config.crypto.keyEpoch,
      retiringKeyIds: config.crypto.keys.filter(({ status }) => status === "retiring").map(({ id }) => id),
      migrationState: config.crypto.migrationState, processedObjects: 0, totalObjects: this.session?.assets.list().length ?? 0,
      ...(config.crypto.lastError ? { lastError: config.crypto.lastError } : {})
    };
  }

  async createLegacyMigrationSource(rootPath: string): Promise<LegacyMigrationSourcePort> {
    if (!isAbsolute(rootPath)) throw new AppError("WORKSPACE_INVALID", "旧工作区路径必须是绝对路径。");
    const sourceRoot = resolve(rootPath);
    if (this.session && resolve(this.session.workspace.rootPath) === sourceRoot) {
      throw new AppError("WORKSPACE_INVALID", "不能把当前新版工作区作为迁移来源。");
    }

    let config: z.infer<typeof legacyConfigSchema> | z.infer<typeof configV2Schema>;
    try {
      const parsed = configSchema.parse(JSON.parse(await readFile(join(sourceRoot, "workspace.json"), "utf8")));
      if (parsed.formatVersion === WORKSPACE_FORMAT_VERSION) {
        throw new AppError("WORKSPACE_INVALID", "请选择格式版本 1 或 2 的旧工作区。");
      }
      config = parsed;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("WORKSPACE_INVALID", "所选目录不是可迁移的旧版 Grudge Vault 工作区。", false, { cause: error });
    }

    await this.keyProtector.assertAvailable();
    let key: VaultKey | undefined;
    let database: Database.Database | undefined;
    let temporaryRoot: string | undefined;
    try {
      if (config.formatVersion === 1) {
        const unlocked = await this.keyProtector.unprotect(config.keyEnvelope);
        if (unlocked.key.length !== 32) {
          unlocked.key.fill(0);
          throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "旧工作区密钥无效。");
        }
        key = unlocked.key;
      } else {
        const keys = new Map<string, Buffer>();
        try {
          for (const slot of config.crypto.keys) {
            const unlocked = await this.keyProtector.unprotect(slot.envelope);
            if (unlocked.key.length !== 32) {
              unlocked.key.fill(0);
              throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "旧工作区密钥无效。");
            }
            keys.set(slot.id, unlocked.key);
          }
        } catch (error) {
          for (const value of keys.values()) value.fill(0);
          throw error;
        }
        key = {
          activeKeyId: config.crypto.pendingKeyId ?? config.crypto.activeKeyId,
          legacyKeyId: config.crypto.legacyKeyId,
          keys
        };
      }

      temporaryRoot = await this.createTransientDirectory("legacy-migration-");
      const sourceDatabasePath = join(sourceRoot, "db", "grudge-vault.sqlite3");
      const sourceDatabaseMetadata = await lstat(sourceDatabasePath);
      if (!sourceDatabaseMetadata.isFile() || sourceDatabaseMetadata.isSymbolicLink()) {
        throw new AppError("WORKSPACE_INVALID", "旧工作区数据库不是普通文件。");
      }
      const copiedDatabasePath = join(temporaryRoot, "legacy.sqlite3");
      const mainHashBefore = await hashFile(sourceDatabasePath);
      await cp(sourceDatabasePath, copiedDatabasePath);
      const sourceWalPath = `${sourceDatabasePath}-wal`;
      const copiedWalPath = `${copiedDatabasePath}-wal`;
      const walExisted = await exists(sourceWalPath);
      const walHashBefore = walExisted ? await hashFile(sourceWalPath) : undefined;
      if (walExisted) await cp(sourceWalPath, copiedWalPath);
      const mainUnchanged = await hashFile(sourceDatabasePath) === mainHashBefore
        && await hashFile(copiedDatabasePath) === mainHashBefore;
      const walStillExists = await exists(sourceWalPath);
      const walUnchanged = walExisted === walStillExists && (!walExisted
        || await hashFile(sourceWalPath) === walHashBefore && await hashFile(copiedWalPath) === walHashBefore);
      if (!mainUnchanged || !walUnchanged) {
        throw new AppError("WORKSPACE_INVALID", "旧工作区仍在变化；请先关闭使用它的旧版应用后重试。");
      }
      database = new Database(copiedDatabasePath, {
        readonly: true,
        fileMustExist: true,
        timeout: 5_000
      });
      database.pragma("query_only = ON");
      const integrity = database.pragma("quick_check", { simple: true });
      if (integrity !== "ok") throw new AppError("WORKSPACE_INVALID", "旧工作区数据库完整性检查失败。");
      if (!hasTable(database, "workspace_meta") || !hasTable(database, "events") || !hasTable(database, "event_revisions")) {
        throw new AppError("WORKSPACE_INVALID", "旧工作区缺少事件或修订数据表。");
      }
      const metadata = database.prepare("SELECT workspace_id FROM workspace_meta LIMIT 1").get() as { workspace_id: string } | undefined;
      if (metadata?.workspace_id !== config.id) {
        throw new AppError("WORKSPACE_INVALID", "旧工作区配置与数据库身份不一致。");
      }
    } catch (error) {
      database?.close();
      if (key) zeroVaultKey(key);
      if (temporaryRoot) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch((cause) => {
          throw new AppError("CLEANUP_FAILED", "旧工作区临时副本清理失败；请勿继续迁移。", true, { cause });
        });
      }
      if (error instanceof AppError) throw error;
      throw new AppError("WORKSPACE_INVALID", "无法只读打开旧工作区。", false, { cause: error });
    }

    const openedDatabase = database;
    const openedKey = key;
    const stagingRoot = temporaryRoot;
    const vault = new EncryptedObjectVault(join(sourceRoot, "vault"));
    const tables = {
      assets: hasTable(openedDatabase, "assets"),
      eventAssets: hasTable(openedDatabase, "event_assets"),
      sourceItems: hasTable(openedDatabase, "source_items"),
      sourceItemAssets: hasTable(openedDatabase, "source_item_assets"),
      journalEntries: hasTable(openedDatabase, "journal_entries"),
      sourceVersions: hasTable(openedDatabase, "source_versions"),
      sourceVersionAssets: hasTable(openedDatabase, "source_version_assets")
    };
    let closed = false;
    let scanning = false;
    const stageAssets = async (assetIds: Iterable<string>, directory: string, signal: AbortSignal) => {
      const selectedAssetIds = [...new Set(assetIds)].sort();
      let incompleteMedia = selectedAssetIds.length > MAX_MIGRATION_ATTACHMENTS;
      const paths: string[] = [];
      const fileNames: string[] = [];
      const versionAssets: Array<{ id: string; sha256?: string }> = [];
      for (const [index, assetId] of selectedAssetIds.entries()) {
        signal.throwIfAborted();
        if (!tables.assets) {
          incompleteMedia = true;
          versionAssets.push({ id: assetId });
          continue;
        }
        const asset = openedDatabase.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as Record<string, unknown> | undefined;
        if (!asset) {
          incompleteMedia = true;
          versionAssets.push({ id: assetId });
          continue;
        }
        const sha256 = String(asset.sha256);
        versionAssets.push({ id: assetId, sha256 });
        if (index >= MAX_MIGRATION_ATTACHMENTS) continue;
        const originalName = basename(String(asset.original_file_name || assetId));
        const originalExtension = extname(originalName).toLocaleLowerCase("en-US");
        const extension = MIGRATABLE_MEDIA_EXTENSIONS.has(originalExtension)
          ? originalExtension
          : MEDIA_EXTENSION_BY_MIME.get(String(asset.mime_type).toLocaleLowerCase("en-US"));
        const byteSize = Number(asset.byte_size);
        if (!extension || !Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > MAX_MIGRATION_ATTACHMENT_BYTES
          || asset.integrity_status === "corrupt"
          || ["missing", "deleted", "superseded"].includes(String(asset.availability_status ?? "available"))) {
          incompleteMedia = true;
          continue;
        }
        const outputPath = join(directory, `${String(index).padStart(2, "0")}-${assetId}${extension}`);
        try {
          await pipeline(await vault.open(sha256, openedKey), createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
          const outputMetadata = await stat(outputPath);
          if (outputMetadata.size !== byteSize || await hashFile(outputPath) !== sha256) {
            throw new Error("Legacy asset plaintext integrity check failed.");
          }
          paths.push(outputPath);
          fileNames.push(originalName || `${assetId}${extension}`);
        } catch {
          incompleteMedia = true;
          await rm(outputPath, { force: true }).catch(() => undefined);
        }
      }
      return { paths, fileNames, versionAssets, incompleteMedia };
    };

    return {
      sourceWorkspaceId: config.id,
      scan: async (consumer, signal, selection) => {
        if (closed) throw new AppError("SOURCE_UNAVAILABLE", "旧工作区迁移来源已关闭。");
        if (scanning) throw new AppError("REVISION_CONFLICT", "旧工作区正在迁移。");
        scanning = true;
        try {
          const eventRows = openedDatabase.prepare(
            "SELECT id, snapshot_json, recorded_at FROM events ORDER BY recorded_at, id"
          ).all() as Array<{ id: string; snapshot_json: string; recorded_at: string }>;
          const representedSourceIds = new Set<string>();
          let selectedEventCount = 0;
          for (const row of eventRows) {
            signal.throwIfAborted();
            const event = legacyEventSchema.parse(JSON.parse(row.snapshot_json)) as unknown as Event;
            if (event.id !== row.id) throw new AppError("WORKSPACE_INVALID", "旧事件投影的身份不一致。");
            for (const sourceId of event.sourceRefs) representedSourceIds.add(sourceId);
            if (selection && (selection.sourceCollection !== "events" || selection.legacyEntityId !== event.id)) continue;
            selectedEventCount += 1;

            const sourceRows = event.sourceRefs.length && tables.sourceItems
              ? openedDatabase.prepare(
                `SELECT id, content, recorded_at FROM source_items WHERE id IN (${placeholders(event.sourceRefs)}) ORDER BY recorded_at, id`
              ).all(...event.sourceRefs) as Array<{ id: string; content: string | null; recorded_at: string }>
              : [];
            const sourceContents = sourceRows.flatMap(({ content }) => content?.trim() ? [content] : []);
            const rendered = truncateCodePoints(renderLegacyEvent(event, sourceContents), MAX_MIGRATION_TEXT_CODEPOINTS);
            let incompleteMedia = rendered.truncated;

            const assetIds = new Set(event.assetRefs);
            if (tables.eventAssets) {
              const linked = openedDatabase.prepare("SELECT asset_id FROM event_assets WHERE event_id = ? ORDER BY asset_id")
                .all(event.id) as Array<{ asset_id: string }>;
              for (const { asset_id: id } of linked) assetIds.add(id);
            }
            if (event.sourceRefs.length && tables.sourceItemAssets) {
              const linked = openedDatabase.prepare(
                `SELECT asset_id FROM source_item_assets WHERE source_item_id IN (${placeholders(event.sourceRefs)}) ORDER BY asset_id`
              ).all(...event.sourceRefs) as Array<{ asset_id: string }>;
              for (const { asset_id: id } of linked) assetIds.add(id);
            }
            if (event.sourceRefs.length && tables.journalEntries && tables.sourceVersionAssets) {
              const linked = openedDatabase.prepare(`
                SELECT sva.asset_id FROM journal_entries je
                JOIN source_version_assets sva ON sva.source_version_id = je.current_version_id
                WHERE je.source_item_id IN (${placeholders(event.sourceRefs)}) ORDER BY sva.asset_id
              `).all(...event.sourceRefs) as Array<{ asset_id: string }>;
              for (const { asset_id: id } of linked) assetIds.add(id);
            }

            const eventStaging = await mkdtemp(join(stagingRoot, "event-"));
            try {
              const staged = await stageAssets(assetIds, eventStaging, signal);
              incompleteMedia ||= staged.incompleteMedia;
              const { paths, fileNames, versionAssets } = staged;

              const revisions = (openedDatabase.prepare(`
                SELECT revision, snapshot_json, actor, reason, created_at
                FROM event_revisions WHERE event_id = ? ORDER BY revision
              `).all(event.id) as Array<{
                revision: number; snapshot_json: string; actor: string; reason: string; created_at: string;
              }>).map((revision) => ({
                revision: revision.revision,
                snapshot: (() => {
                  try { return JSON.parse(revision.snapshot_json) as unknown; }
                  catch { return revision.snapshot_json; }
                })(),
                actor: revision.actor,
                reason: revision.reason,
                createdAt: revision.created_at
              }));
              if (revisions.length === 0) {
                revisions.push({
                  revision: event.currentRevision,
                  snapshot: event,
                  actor: "user",
                  reason: "旧工作区当前事件投影",
                  createdAt: event.updatedAt
                });
              }
              const sourceVersion = createHash("sha256").update(JSON.stringify({
                event: row.snapshot_json,
                sources: sourceRows.map(({ id, content, recorded_at }) => ({ id, content, recordedAt: recorded_at })),
                assets: versionAssets
              })).digest("hex");
              await consumer({
                legacyEntityId: event.id,
                title: event.title,
                occurredAt: event.occurredAt,
                text: rendered.value,
                paths,
                fileNames,
                incompleteMedia,
                sourceVersion,
                recordedAt: event.recordedAt || row.recorded_at,
                revisions
              });
            } finally {
              await rm(eventStaging, { recursive: true, force: true });
            }
          }
          let standaloneSourceCount = 0;
          if (tables.sourceItems) {
            const sourceRows = openedDatabase.prepare(`
              SELECT si.id, si.external_id, si.content, si.recorded_at, s.kind
              FROM source_items si JOIN sources s ON s.id = si.source_id
              WHERE si.deleted_at IS NULL AND s.kind <> 'chat'
              ORDER BY si.recorded_at, si.id
            `).all() as Array<{
              id: string; external_id: string | null; content: string | null; recorded_at: string; kind: string;
            }>;
            for (const row of sourceRows) {
              signal.throwIfAborted();
              if (representedSourceIds.has(row.id)) continue;
              if (selection && (selection.sourceCollection !== "source_items"
                || selection.legacyEntityId !== `source-item:${row.id}`)) continue;
              const journalEntry = tables.journalEntries ? openedDatabase.prepare(`
                SELECT journal_date, current_version_id FROM journal_entries WHERE source_item_id = ?
              `).get(row.id) as { journal_date: string; current_version_id: string } | undefined : undefined;
              const currentVersion = journalEntry && tables.sourceVersions ? openedDatabase.prepare(`
                SELECT version, content, content_hash FROM source_versions WHERE id = ?
              `).get(journalEntry.current_version_id) as {
                version: number; content: string | null; content_hash: string;
              } | undefined : undefined;
              const content = currentVersion ? currentVersion.content ?? "" : row.content ?? "";
              const assetIds = new Set<string>();
              if (tables.sourceItemAssets) {
                const linked = openedDatabase.prepare("SELECT asset_id FROM source_item_assets WHERE source_item_id = ? ORDER BY asset_id")
                  .all(row.id) as Array<{ asset_id: string }>;
                for (const { asset_id: id } of linked) assetIds.add(id);
              }
              if (journalEntry && tables.sourceVersionAssets) {
                const linked = openedDatabase.prepare("SELECT asset_id FROM source_version_assets WHERE source_version_id = ? ORDER BY asset_id")
                  .all(journalEntry.current_version_id) as Array<{ asset_id: string }>;
                for (const { asset_id: id } of linked) assetIds.add(id);
              }
              if (!content.trim() && assetIds.size === 0) continue;
              standaloneSourceCount += 1;
              const rendered = truncateCodePoints(content, MAX_MIGRATION_TEXT_CODEPOINTS);
              const sourceStaging = await mkdtemp(join(stagingRoot, "source-"));
              try {
                const staged = await stageAssets(assetIds, sourceStaging, signal);
                const versions = tables.sourceVersions ? openedDatabase.prepare(`
                  SELECT version, raw_json, created_at FROM source_versions WHERE source_item_id = ? ORDER BY version
                `).all(row.id) as Array<{ version: number; raw_json: string; created_at: string }> : [];
                const revisions = versions.map(({ version, raw_json, created_at }) => ({
                  revision: version,
                  snapshot: (() => { try { return JSON.parse(raw_json) as unknown; } catch { return raw_json; } })(),
                  actor: "importer",
                  reason: "旧来源版本",
                  createdAt: created_at
                }));
                const sourceVersion = createHash("sha256").update(JSON.stringify({
                  id: row.id, externalId: row.external_id, kind: row.kind, content,
                  currentVersion: currentVersion?.version, contentHash: currentVersion?.content_hash,
                  assets: staged.versionAssets
                })).digest("hex");
                await consumer({
                  legacyEntityId: `source-item:${row.id}`,
                  sourceCollection: "source_items",
                  title: truncateCodePoints(content.trim().split("\n", 1)[0] || "旧来源媒体记录", 120).value,
                  occurredAt: journalEntry && /^\d{4}-\d{2}-\d{2}$/.test(journalEntry.journal_date)
                    ? { kind: "date", value: journalEntry.journal_date }
                    : { kind: "unknown" },
                  text: rendered.value,
                  paths: staged.paths,
                  fileNames: staged.fileNames,
                  incompleteMedia: rendered.truncated || staged.incompleteMedia,
                  sourceVersion,
                  recordedAt: row.recorded_at,
                  revisions
                });
              } finally {
                await rm(sourceStaging, { recursive: true, force: true });
              }
            }
          }
          return selectedEventCount + standaloneSourceCount;
        } finally {
          scanning = false;
        }
      },
      close: async () => {
        if (closed) return;
        if (scanning) throw new AppError("REVISION_CONFLICT", "旧工作区扫描尚未结束。");
        try { openedDatabase.close(); }
        finally {
          zeroVaultKey(openedKey);
          await rm(stagingRoot, { recursive: true, force: true }).catch((cause) => {
            throw new AppError("CLEANUP_FAILED", "旧工作区临时副本清理失败；请检查目录权限。", true, { cause });
          });
          closed = true;
        }
      }
    };
  }

  async createBackup(destinationPath: string): Promise<BackupSummary> {
    const session = this.session;
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Open a workspace before creating a backup.");
    if (!isAbsolute(destinationPath)) throw new AppError("BACKUP_INVALID", "Backup paths must be absolute.");
    let workspaceRoot: string;
    let resolvedDestinationPath: string;
    try {
      workspaceRoot = await realpath(session.workspace.rootPath);
      resolvedDestinationPath = await canonicalFuturePath(destinationPath);
    } catch (cause) {
      throw new AppError("BACKUP_INVALID", "The backup destination cannot be resolved safely.", false, { cause });
    }
    if (isInside(workspaceRoot, resolvedDestinationPath)) {
      throw new AppError("BACKUP_INVALID", "Store the backup outside the active workspace.");
    }
    if (await lstatIfPresent(destinationPath) || await lstatIfPresent(resolvedDestinationPath)) {
      throw new AppError("BACKUP_EXISTS", "The backup destination already exists.");
    }
    const staging = join(dirname(resolvedDestinationPath), `.${randomUUID()}.gvbackup.tmp`);
    try {
      await mkdir(join(staging, "db"), { recursive: true, mode: 0o700 });
      await session.backupDatabase(join(staging, "db", "grudge-vault.sqlite3"));
      await cp(join(workspaceRoot, "workspace.json"), join(staging, "workspace.json"));
      const snapshot = inspectWorkspaceSnapshot(join(staging, "db", "grudge-vault.sqlite3"));
      if (snapshot.workspaceId !== session.workspace.id) throw new AppError("BACKUP_INVALID", "The database belongs to another workspace.");
      for (const sha256 of snapshot.assetHashes) {
        const relativePath = objectRelativePath(sha256);
        const source = join(workspaceRoot, relativePath);
        const destination = join(staging, relativePath);
        const sourceStat = await lstat(source).catch(() => undefined);
        if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
          throw new AppError("BACKUP_INVALID", `The encrypted object ${sha256} is missing.`);
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await cp(source, destination, { preserveTimestamps: true });
      }
      const createdAt = new Date().toISOString();
      const filePaths = await listFiles(staging);
      const files: BackupManifest["files"] = [];
      for (const filePath of filePaths) {
        const absolutePath = join(staging, filePath);
        files.push({ path: filePath, byteSize: (await stat(absolutePath)).size, sha256: await hashFile(absolutePath) });
      }
      const manifest: BackupManifest = { formatVersion: WORKSPACE_FORMAT_VERSION, workspaceId: session.workspace.id, createdAt, files };
      await atomicWriteJson(join(staging, "manifest.json"), manifest);
      const manifestSize = (await stat(join(staging, "manifest.json"))).size;
      await rename(staging, resolvedDestinationPath);
      return {
        path: resolvedDestinationPath, workspaceId: session.workspace.id, createdAt,
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
    const assertStillCurrent = this.beginWorkspaceSelection();
    if (!isAbsolute(backupPath) || !isAbsolute(destinationPath) || dirname(destinationPath) === destinationPath) {
      throw new AppError("BACKUP_INVALID", "Backup and restore paths must be safe absolute paths.");
    }
    let resolvedBackupPath: string;
    let resolvedDestinationPath: string;
    let activeWorkspacePath: string | undefined;
    try {
      resolvedBackupPath = await realpath(backupPath);
      resolvedDestinationPath = await canonicalFuturePath(destinationPath);
      const activePath = this.session?.workspace.rootPath ?? this.locked?.rootPath;
      activeWorkspacePath = activePath ? await realpath(activePath) : undefined;
    } catch (cause) {
      throw new AppError("BACKUP_INVALID", "Backup or restore path cannot be resolved safely.", false, { cause });
    }
    if (isInside(resolvedBackupPath, resolvedDestinationPath)) {
      throw new AppError("BACKUP_INVALID", "The restore destination must be outside the backup directory.");
    }
    if (activeWorkspacePath && isInside(activeWorkspacePath, resolvedDestinationPath)) {
      throw new AppError("BACKUP_INVALID", "Restore the backup outside the active workspace.");
    }
    const requestedMetadata = await lstatIfPresent(destinationPath);
    if (requestedMetadata?.isSymbolicLink()) {
      throw new AppError("WORKSPACE_INVALID", "Choose an empty, regular directory for the restored workspace.");
    }
    const destinationMetadata = await lstatIfPresent(resolvedDestinationPath);
    const destinationExists = destinationMetadata !== undefined;
    if (destinationExists) {
      if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()
        || meaningfulDirectoryEntries(await readdir(resolvedDestinationPath)).length > 0) {
        throw new AppError("WORKSPACE_INVALID", "Choose an empty, regular directory for the restored workspace.");
      }
    }
    const staging = join(dirname(resolvedDestinationPath), `.${randomUUID()}.restore.tmp`);
    try {
      const manifest = backupManifestSchema.parse(JSON.parse(await readFile(join(resolvedBackupPath, "manifest.json"), "utf8")));
      if (manifest.formatVersion !== WORKSPACE_FORMAT_VERSION) {
        throw new AppError(
          "WORKSPACE_MIGRATION_REQUIRED",
          "旧格式备份不能原地恢复为新版工作区；请恢复到兼容版本后，再使用只读筛选迁移。"
        );
      }
      for (const file of manifest.files) {
        assertSafeManifestPath(file.path);
        const path = join(resolvedBackupPath, file.path);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.byteSize || await hashFile(path) !== file.sha256) {
          throw new AppError("BACKUP_INVALID", `Backup verification failed for ${file.path}.`);
        }
      }
      const required = ["workspace.json", join("db", "grudge-vault.sqlite3")];
      if (required.some((path) => !manifest.files.some((file) => file.path === path))) {
        throw new AppError("BACKUP_INVALID", "The backup is missing required workspace files.");
      }
      const config = configSchema.parse(JSON.parse(await readFile(join(resolvedBackupPath, "workspace.json"), "utf8")));
      if (config.formatVersion !== WORKSPACE_FORMAT_VERSION) {
        throw new AppError(
          "WORKSPACE_MIGRATION_REQUIRED",
          "备份中的旧工作区必须通过独立新版工作区筛选迁移。"
        );
      }
      if (config.id !== manifest.workspaceId) throw new AppError("BACKUP_INVALID", "The backup workspace identity does not match.");
      const snapshot = inspectWorkspaceSnapshot(join(resolvedBackupPath, "db", "grudge-vault.sqlite3"));
      if (snapshot.workspaceId !== manifest.workspaceId) throw new AppError("BACKUP_INVALID", "The backup database identity does not match.");
      const restoredPaths = new Set([...required, ...snapshot.assetHashes.map(objectRelativePath)]);
      for (const sha256 of snapshot.assetHashes) {
        const path = objectRelativePath(sha256);
        if (!manifest.files.some((file) => file.path === path)) {
          throw new AppError("BACKUP_INVALID", `The backup does not contain encrypted object ${sha256}.`);
        }
      }
      const envelope = config.crypto.keys.find(({ id }) => id === config.crypto.activeKeyId)?.envelope;
      if (!envelope) throw new AppError("BACKUP_INVALID", "The backup has no active Workspace Key envelope.");
      const unlocked = await this.keyProtector.unprotect(envelope);
      unlocked.key.fill(0);
      assertStillCurrent();
      await mkdir(staging, { recursive: true, mode: 0o700 });
      for (const file of manifest.files) {
        if (!restoredPaths.has(file.path)) continue;
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await cp(join(resolvedBackupPath, file.path), target);
      }
      prepareRestoredSnapshot(join(staging, "db", "grudge-vault.sqlite3"), new Date().toISOString());
      const preflightState = join(dirname(resolvedDestinationPath), `.${randomUUID()}.restore-check.json`);
      const preflight = new LocalWorkspaceManager(this.keyProtector, preflightState);
      try {
        // Internal object verification never publishes a user session. The final open still requires its password.
        const candidate = await preflight.openConfig(staging, config);
        const candidateSnapshot = inspectWorkspaceSnapshot(join(staging, "db", "grudge-vault.sqlite3"));
        for (const sha256 of candidateSnapshot.assetHashes) {
          if (!(await candidate.vault.verify(sha256, candidate.keyRing ?? candidate.key))) {
            throw new AppError("BACKUP_INVALID", `The restored encrypted object ${sha256} failed verification.`);
          }
        }
      } catch (cause) {
        throw new AppError("BACKUP_INVALID", "The restored workspace did not pass opening and object verification.", false, { cause });
      } finally {
        try { await preflight.close(); }
        finally { await rm(preflightState, { force: true }); }
      }
      assertStillCurrent();
      if (destinationExists) await rmdir(resolvedDestinationPath);
      assertStillCurrent();
      await rename(staging, resolvedDestinationPath);
      assertStillCurrent();
      return await this.open(resolvedDestinationPath, assertStillCurrent);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError("BACKUP_INVALID", "The selected backup is invalid or cannot be restored.", false, { cause: error });
    }
  }

  async close(): Promise<void> {
    this.beginWorkspaceSelection();
    await this.withSessionTransition(async () => {
      const current = this.session;
      this.session = undefined;
      try { if (current) await current.close(); }
      finally {
        this.locked = undefined;
        this.currentConfig = undefined;
      }
    });
  }

  private async openConfig(rootPath: string, config: WorkspaceConfig, assertStillCurrent?: () => void): Promise<WorkspaceSession> {
    const recoverOrphans = this.session === undefined;
    const keyValues = new Map<string, Buffer>();
    const refreshed: WorkspaceConfig["crypto"]["keys"] = [];
    try {
      for (const slot of config.crypto.keys) {
        const unlocked = await this.keyProtector.unprotect(slot.envelope);
        keyValues.set(slot.id, unlocked.key);
        refreshed.push(unlocked.refreshedEnvelope ? { ...slot, envelope: unlocked.refreshedEnvelope } : slot);
      }
      assertStillCurrent?.();
    } catch (error) {
      for (const key of keyValues.values()) key.fill(0);
      throw error;
    }
    const key = keyValues.get(config.crypto.activeKeyId);
    if (!key) {
      for (const value of keyValues.values()) value.fill(0);
      throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "The active Workspace Key is unavailable.");
    }
    const keyRing: WorkspaceKeyRing = {
      activeKeyId: config.crypto.pendingKeyId ?? config.crypto.activeKeyId,
      legacyKeyId: config.crypto.legacyKeyId,
      keys: keyValues
    };
    let database: SqliteWorkspaceDatabase | undefined;
    let candidateSession: WorkspaceSession | undefined;
    try {
      await Promise.all([
        mkdir(join(rootPath, "db"), { recursive: true, mode: 0o700 }),
        mkdir(join(rootPath, "logs"), { recursive: true, mode: 0o700 })
      ]);
      const vault = new EncryptedObjectVault(join(rootPath, "vault"));
      try {
        await vault.initialize();
      } catch (cause) {
        throw new AppError("CLEANUP_FAILED", "无法安全清理工作区的临时加密文件。", true, { cause });
      }
      database = new SqliteWorkspaceDatabase(
        await openDatabase(join(rootPath, "db", "grudge-vault.sqlite3")),
        () => candidateSession?.keyRing ?? candidateSession?.key ?? keyRing
      );
      const workspace: Workspace = {
        id: config.id,
        name: config.name,
        rootPath,
        formatVersion: config.formatVersion,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt
      };
      database.ensureWorkspace(workspace);
      database.records.sealExistingPending();
      database.records.ensureKeywordProjection();
      if (recoverOrphans) {
        try {
          const snapshot = inspectWorkspaceSnapshot(join(rootPath, "db", "grudge-vault.sqlite3"));
          if (snapshot.workspaceId !== workspace.id) throw new Error("Workspace identity mismatch during recovery scan.");
          await vault.pruneUnreferencedObjects(new Set(snapshot.assetHashes));
        } catch (cause) {
          throw new AppError("CLEANUP_FAILED", "无法清理上次中断留下的孤立加密对象。", true, { cause });
        }
      }
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
        records: openedDatabase.records,
        vault,
        backupDatabase: (destinationPath) => openedDatabase.backup(destinationPath),
        close: async () => {
          try { openedDatabase.close(); }
          finally { for (const value of keyValues.values()) value.fill(0); }
        }
      };
      candidateSession = session;
      const commit = async () => this.withSessionTransition(async () => {
        assertStillCurrent?.();
        let latest: WorkspaceConfig;
        try {
          const parsed = configSchema.parse(JSON.parse(await readFile(join(rootPath, "workspace.json"), "utf8")));
          if (parsed.formatVersion !== WORKSPACE_FORMAT_VERSION) throw new Error("Workspace format changed.");
          latest = parsed;
        } catch (cause) {
          throw new AppError("WORKSPACE_INVALID", "The workspace configuration changed while opening.", true, { cause });
        }
        if (latest.id !== config.id || latest.formatVersion !== config.formatVersion ||
          JSON.stringify(latest.crypto) !== JSON.stringify(config.crypto) || JSON.stringify(latest.password) !== JSON.stringify(config.password)) {
          throw new AppError("WORKSPACE_LOCKED", "工作区密钥配置已变化，请重新打开。", true);
        }
        const committedConfig = refreshed.some((slot, index) => slot.envelope !== config.crypto.keys[index]?.envelope)
          ? { ...latest, crypto: { ...latest.crypto, keys: refreshed }, updatedAt: new Date().toISOString() }
          : latest;
        if (committedConfig !== latest) await atomicWriteJson(join(rootPath, "workspace.json"), committedConfig);
        await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: rootPath });
        const outgoing = this.session;
        try {
          await outgoing?.close();
        } catch (cause) {
          this.session = undefined;
          if (outgoing) {
            this.locked = {
              rootPath: outgoing.workspace.rootPath,
              workspaceId: outgoing.workspace.id,
              workspaceName: outgoing.workspace.name
            };
            try {
              await atomicWriteJson(this.recentStatePath, { recentWorkspacePath: outgoing.workspace.rootPath });
            } catch (rollbackCause) {
              throw new AppError("CLEANUP_FAILED", "切换工作区失败，无法恢复上次工作区位置；请手动重新选择工作区。", true,
                { cause: rollbackCause });
            }
          }
          throw new AppError("CLEANUP_FAILED", "无法安全关闭原工作区；已锁定，请重新打开。", true, { cause });
        }
        workspace.name = committedConfig.name;
        workspace.updatedAt = committedConfig.updatedAt;
        this.session = session;
        this.currentConfig = committedConfig;
        this.locked = undefined;
      });
      await this.withConfigMutation(commit);
      return session;
    } catch (error) {
      database?.close();
      for (const value of keyValues.values()) value.fill(0);
      throw error;
    }
  }

}
