import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { lookup as lookupMimeType } from "mime-types";
import type { Asset, Job, Workspace } from "@grudge-vault/domain";
import { AppError, type AssetImportResult } from "@grudge-vault/shared";

export interface StoredObject {
  sha256: string;
  byteSize: number;
  vaultFormat: number;
  deduplicated: boolean;
}

export interface ObjectVaultPort {
  put(inputPath: string, key: Buffer): Promise<StoredObject>;
  open(sha256: string, key: Buffer): Promise<NodeJS.ReadableStream>;
  verify(sha256: string, key: Buffer, onProgress?: (progress: number) => void): Promise<boolean>;
  cleanupTempFiles(): Promise<void>;
}

export interface AssetRepositoryPort {
  list(): Asset[];
  findById(id: string): Asset | undefined;
  upsert(asset: Asset): { asset: Asset; deduplicated: boolean };
  setIntegrity(id: string, status: Asset["integrityStatus"], verifiedAt?: string): Asset;
}

export interface JobRepositoryPort {
  list(): Job[];
  enqueue(type: string, payload: unknown, now: string, maxAttempts?: number): Job;
  claimNext(now: string, leaseUntil: string): Job | undefined;
  heartbeat(id: string, leaseUntil: string, now: string): void;
  updateProgress(id: string, progress: number, now: string): void;
  succeed(id: string, now: string): Job;
  fail(id: string, error: string, now: string, retryAt?: string): Job;
  retry(id: string, now: string): Job;
}

export interface WorkspaceSession {
  workspace: Workspace;
  key: Buffer;
  assets: AssetRepositoryPort;
  jobs: JobRepositoryPort;
  vault: ObjectVaultPort;
  close(): Promise<void>;
}

export interface WorkspaceManagerPort {
  current(): WorkspaceSession | undefined;
  create(rootPath: string, name: string): Promise<WorkspaceSession>;
  open(rootPath: string): Promise<WorkspaceSession>;
  close(): Promise<void>;
}

export interface KeyProtectorPort {
  assertAvailable(): Promise<void>;
  protect(key: Buffer): Promise<string>;
  unprotect(envelope: string): Promise<{ key: Buffer; refreshedEnvelope?: string }>;
}

export class GrudgeVaultApplication {
  constructor(private readonly workspaces: WorkspaceManagerPort) {}

  getCurrentWorkspace(): Workspace | null {
    return this.workspaces.current()?.workspace ?? null;
  }

  async createWorkspace(rootPath: string, name: string): Promise<Workspace> {
    return (await this.workspaces.create(rootPath, name)).workspace;
  }

  async openWorkspace(rootPath: string): Promise<Workspace> {
    return (await this.workspaces.open(rootPath)).workspace;
  }

  async importAsset(filePath: string): Promise<AssetImportResult> {
    const session = this.requireSession();
    const stat = await lstat(filePath).catch((cause: unknown) => {
      throw new AppError("FILE_NOT_REGULAR", "The selected file cannot be read.", false, { cause });
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AppError("FILE_NOT_REGULAR", "Only regular files can be imported.");
    }

    try {
      const stored = await session.vault.put(filePath, session.key);
      const now = new Date().toISOString();
      const candidate: Asset = {
        id: randomUUID(),
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        mimeType: lookupMimeType(filePath) || "application/octet-stream",
        originalFileName: basename(filePath),
        vaultFormat: stored.vaultFormat,
        integrityStatus: "pending",
        createdAt: now
      };
      const result = session.assets.upsert(candidate);
      if (!result.deduplicated) {
        session.jobs.enqueue("asset.verify", { assetId: result.asset.id, sha256: result.asset.sha256 }, now);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("ASSET_IMPORT_FAILED", "The file could not be stored in the vault.", true, { cause: error });
    }
  }

  listAssets(): Asset[] {
    return this.requireSession().assets.list();
  }

  verifyAsset(assetId: string): Job {
    const session = this.requireSession();
    const asset = session.assets.findById(assetId);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    session.assets.setIntegrity(asset.id, "pending");
    return session.jobs.enqueue(
      "asset.verify",
      { assetId: asset.id, sha256: asset.sha256 },
      new Date().toISOString()
    );
  }

  listJobs(): Job[] {
    return this.requireSession().jobs.list();
  }

  retryJob(jobId: string): Job {
    return this.requireSession().jobs.retry(jobId, new Date().toISOString());
  }

  private requireSession(): WorkspaceSession {
    const session = this.workspaces.current();
    if (!session) throw new AppError("NO_ACTIVE_WORKSPACE", "Create or open a workspace first.");
    return session;
  }
}

export interface JobHandlerContext {
  signal: AbortSignal;
  reportProgress(progress: number): void;
}

export type JobHandler = (job: Job, context: JobHandlerContext) => Promise<void>;

export interface JobRunnerOptions {
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  now?: () => Date;
  onChanged?: () => void;
}

export class JobRunner {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private readonly onChanged: () => void;
  private pollTimer: NodeJS.Timeout | undefined;
  private runningAbort: AbortController | undefined;
  private draining = false;
  private stopped = true;

  constructor(
    private readonly repository: JobRepositoryPort,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    options: JobRunnerOptions = {}
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.pollMs = options.pollMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.onChanged = options.onChanged ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => void this.drain(), this.pollMs);
    void this.drain();
  }

  wake(): void {
    if (!this.stopped) void this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.runningAbort?.abort();
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped) {
        const now = this.now();
        const job = this.repository.claimNext(now.toISOString(), new Date(now.getTime() + this.leaseMs).toISOString());
        if (!job) break;
        this.onChanged();
        await this.run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    const abort = new AbortController();
    this.runningAbort = abort;
    const heartbeat = setInterval(() => {
      const now = this.now();
      this.repository.heartbeat(job.id, new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString());
    }, this.heartbeatMs);

    try {
      if (!handler) throw new Error(`No handler registered for ${job.type}`);
      await handler(job, {
        signal: abort.signal,
        reportProgress: (progress) => {
          this.repository.updateProgress(job.id, Math.min(1, Math.max(0, progress)), this.now().toISOString());
          this.onChanged();
        }
      });
      if (!this.stopped) this.repository.succeed(job.id, this.now().toISOString());
    } catch (error) {
      if (!this.stopped) {
        const now = this.now();
        const retryDelays = [1_000, 5_000];
        const attemptWithinCycle = (job.attempts - 1) % 3;
        const delay = retryDelays[attemptWithinCycle];
        const retryAt = delay === undefined ? undefined : new Date(now.getTime() + delay).toISOString();
        this.repository.fail(job.id, error instanceof Error ? error.message : "Job failed", now.toISOString(), retryAt);
      }
    } finally {
      clearInterval(heartbeat);
      this.runningAbort = undefined;
      this.onChanged();
    }
  }
}
