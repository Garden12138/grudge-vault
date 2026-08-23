import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AssetRepositoryPort, JobRepositoryPort } from "@grudge-vault/application";
import type { Asset, Job, JobState, Workspace } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const DEFAULT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "phase-zero-foundation",
    sql: `
      CREATE TABLE workspace_meta (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256) = 64),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        mime_type TEXT NOT NULL,
        original_file_name TEXT NOT NULL,
        vault_format INTEGER NOT NULL,
        integrity_status TEXT NOT NULL CHECK(integrity_status IN ('pending', 'verified', 'corrupt')),
        verified_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        progress REAL CHECK(progress IS NULL OR (progress >= 0 AND progress <= 1)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts > 0),
        available_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX jobs_claimable_idx ON jobs(state, available_at, lease_until);

      CREATE TABLE job_attempts (
        id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN ('succeeded', 'failed', 'abandoned')),
        error TEXT,
        UNIQUE(job_id, attempt_number)
      ) STRICT;
    `
  }
];

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export function runMigrations(database: Database.Database, migrations = DEFAULT_MIGRATIONS): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
    checksum: string;
  }>;
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const expectedChecksum = checksum(migration.sql);
    const existing = appliedByVersion.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== expectedChecksum) {
        throw new Error(`Applied migration ${migration.version} no longer matches its recorded checksum.`);
      }
      continue;
    }
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      ).run(migration.version, migration.name, expectedChecksum, new Date().toISOString());
    })();
  }
}

export async function openDatabase(path: string): Promise<Database.Database> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { timeout: 5_000 });
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  runMigrations(database);
  return database;
}

function mapAsset(row: Record<string, unknown>): Asset {
  const asset: Asset = {
    id: String(row.id),
    sha256: String(row.sha256),
    byteSize: Number(row.byte_size),
    mimeType: String(row.mime_type),
    originalFileName: String(row.original_file_name),
    vaultFormat: Number(row.vault_format),
    integrityStatus: row.integrity_status as Asset["integrityStatus"],
    createdAt: String(row.created_at)
  };
  if (row.verified_at) asset.verifiedAt = String(row.verified_at);
  return asset;
}

function mapJob(row: Record<string, unknown>): Job {
  const job: Job = {
    id: String(row.id),
    type: String(row.type),
    payload: JSON.parse(String(row.payload_json)),
    state: row.state as JobState,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
  if (row.progress !== null && row.progress !== undefined) job.progress = Number(row.progress);
  if (row.lease_until) job.leaseUntil = String(row.lease_until);
  if (row.last_error) job.lastError = String(row.last_error);
  return job;
}

export class SqliteAssetRepository implements AssetRepositoryPort {
  constructor(private readonly database: Database.Database) {}

  list(): Asset[] {
    return (this.database.prepare("SELECT * FROM assets ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(mapAsset);
  }

  findById(id: string): Asset | undefined {
    const row = this.database.prepare("SELECT * FROM assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapAsset(row) : undefined;
  }

  upsert(asset: Asset): { asset: Asset; deduplicated: boolean } {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM assets WHERE sha256 = ?").get(asset.sha256) as Record<string, unknown> | undefined;
      if (existing) return { asset: mapAsset(existing), deduplicated: true };
      this.database.prepare(`
        INSERT INTO assets(
          id, sha256, byte_size, mime_type, original_file_name, vault_format,
          integrity_status, verified_at, created_at
        ) VALUES (@id, @sha256, @byteSize, @mimeType, @originalFileName, @vaultFormat,
          @integrityStatus, @verifiedAt, @createdAt)
      `).run({ ...asset, verifiedAt: asset.verifiedAt ?? null });
      return { asset, deduplicated: false };
    })();
  }

  setIntegrity(id: string, status: Asset["integrityStatus"], verifiedAt?: string): Asset {
    const result = this.database.prepare(
      "UPDATE assets SET integrity_status = ?, verified_at = ? WHERE id = ?"
    ).run(status, verifiedAt ?? null, id);
    if (result.changes !== 1) throw new AppError("ASSET_NOT_FOUND", "The asset no longer exists.");
    return this.findById(id)!;
  }
}

export class SqliteJobRepository implements JobRepositoryPort {
  constructor(private readonly database: Database.Database) {}

  list(): Job[] {
    return (this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(mapJob);
  }

  enqueue(type: string, payload: unknown, now: string, maxAttempts = 3): Job {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO jobs(
        id, type, payload_json, state, progress, attempts, max_attempts,
        available_at, lease_until, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, ?, ?)
    `).run(id, type, JSON.stringify(payload), maxAttempts, now, now, now);
    return this.getRequired(id);
  }

  claimNext(now: string, leaseUntil: string): Job | undefined {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM jobs
        WHERE (state = 'queued' AND available_at <= ?)
           OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
        ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, available_at, created_at
        LIMIT 1
      `).get(now, now) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const id = String(row.id);
      if (row.state === "running") {
        this.database.prepare(`
          UPDATE job_attempts
          SET finished_at = ?, outcome = 'abandoned', error = 'Lease expired before completion.'
          WHERE job_id = ? AND finished_at IS NULL
        `).run(now, id);
      }
      this.database.prepare(`
        UPDATE jobs
        SET state = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(leaseUntil, now, id);
      const claimed = this.getRequired(id);
      this.database.prepare(`
        INSERT INTO job_attempts(job_id, attempt_number, started_at)
        VALUES (?, ?, ?)
      `).run(id, claimed.attempts, now);
      return claimed;
    })();
  }

  heartbeat(id: string, leaseUntil: string, now: string): void {
    this.database.prepare(
      "UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'running'"
    ).run(leaseUntil, now, id);
  }

  updateProgress(id: string, progress: number, now: string): void {
    this.database.prepare(
      "UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND state = 'running'"
    ).run(progress, now, id);
  }

  succeed(id: string, now: string): Job {
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE jobs SET state = 'succeeded', progress = 1, lease_until = NULL,
          last_error = NULL, updated_at = ? WHERE id = ? AND state = 'running'
      `).run(now, id);
      this.database.prepare(`
        UPDATE job_attempts SET finished_at = ?, outcome = 'succeeded'
        WHERE job_id = ? AND finished_at IS NULL
      `).run(now, id);
      return this.getRequired(id);
    })();
  }

  fail(id: string, error: string, now: string, retryAt?: string): Job {
    return this.database.transaction(() => {
      const current = this.getRequired(id);
      const willRetry = retryAt !== undefined && current.attempts < current.maxAttempts;
      this.database.prepare(`
        UPDATE jobs SET state = ?, progress = 0, available_at = ?, lease_until = NULL,
          last_error = ?, updated_at = ? WHERE id = ?
      `).run(willRetry ? "queued" : "failed", willRetry ? retryAt : now, error, now, id);
      this.database.prepare(`
        UPDATE job_attempts SET finished_at = ?, outcome = 'failed', error = ?
        WHERE job_id = ? AND finished_at IS NULL
      `).run(now, error, id);
      return this.getRequired(id);
    })();
  }

  retry(id: string, now: string): Job {
    const job = this.getRequired(id);
    if (job.state !== "failed") {
      throw new AppError("JOB_NOT_RETRYABLE", "Only failed jobs can be retried.");
    }
    this.database.prepare(`
      UPDATE jobs SET state = 'queued', progress = 0, max_attempts = attempts + 3,
        available_at = ?, lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.getRequired(id);
  }

  private getRequired(id: string): Job {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("JOB_NOT_RETRYABLE", "The job no longer exists.");
    return mapJob(row);
  }
}

export class SqliteWorkspaceDatabase {
  readonly assets: SqliteAssetRepository;
  readonly jobs: SqliteJobRepository;

  constructor(readonly database: Database.Database) {
    this.assets = new SqliteAssetRepository(database);
    this.jobs = new SqliteJobRepository(database);
  }

  ensureWorkspace(workspace: Workspace): void {
    this.database.transaction(() => {
      const existing = this.database.prepare("SELECT workspace_id FROM workspace_meta LIMIT 1").get() as { workspace_id: string } | undefined;
      if (existing && existing.workspace_id !== workspace.id) {
        throw new AppError("WORKSPACE_INVALID", "The database belongs to a different workspace.");
      }
      if (!existing) {
        this.database.prepare(`
          INSERT INTO workspace_meta(workspace_id, name, format_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(workspace.id, workspace.name, workspace.formatVersion, workspace.createdAt, workspace.updatedAt);
      }
    })();
  }

  close(): void {
    this.database.close();
  }
}
