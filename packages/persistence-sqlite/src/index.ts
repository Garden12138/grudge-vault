import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AssetRepositoryPort, DayOneRepositoryPort, EventCommitExtras, JobRepositoryPort, MemoryRepositoryPort,
  NormalizedDayOneEntry
} from "@grudge-vault/application";
import type {
  Asset, BackfillRun, CandidateDetail, CandidateExtraction, CandidateSummary, Clarification,
  Conversation, Event, EventDetail, EventRevision, EventSearchQuery, ImportIssue, ImportRun,
  ImportRunDetail, Job, JobState, JournalEntry, Message, Person, Source, SourceItem,
  SourceVersion, Workspace
} from "@grudge-vault/domain";
import { AppError, type CandidateMergeInput, type CandidateMergeResult } from "@grudge-vault/shared";

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
  },
  {
    version: 2,
    name: "phase-one-event-recording",
    sql: `
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('chat', 'dayone', 'manual', 'manual-file')),
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE source_items (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        external_id TEXT,
        content TEXT,
        recorded_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX source_items_source_idx ON source_items(source_id, recorded_at);

      CREATE TABLE source_item_assets (
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        PRIMARY KEY(source_item_id, asset_id)
      ) STRICT;

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        source_item_id TEXT NOT NULL UNIQUE REFERENCES source_items(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);

      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'confirmed', 'archived')),
        occurred_from TEXT,
        occurred_to TEXT,
        recorded_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK(current_revision > 0),
        snapshot_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX events_filter_idx ON events(status, occurred_from, occurred_to, updated_at);

      CREATE TABLE event_revisions (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        previous_revision INTEGER NOT NULL CHECK(previous_revision >= 0),
        snapshot_json TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('user', 'importer', 'agent')),
        reason TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(event_id, revision)
      ) STRICT;

      CREATE TABLE event_sources (
        event_id TEXT NOT NULL REFERENCES events(id),
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        PRIMARY KEY(event_id, source_item_id)
      ) STRICT;

      CREATE TABLE event_assets (
        event_id TEXT NOT NULL REFERENCES events(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        PRIMARY KEY(event_id, asset_id)
      ) STRICT;

      CREATE TABLE event_people (
        event_id TEXT NOT NULL REFERENCES events(id),
        person_id TEXT NOT NULL REFERENCES people(id),
        role TEXT,
        PRIMARY KEY(event_id, person_id)
      ) STRICT;
      CREATE INDEX event_people_person_idx ON event_people(person_id, event_id);

      CREATE TABLE clarifications (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id),
        field_path TEXT,
        question TEXT NOT NULL,
        reason TEXT NOT NULL,
        priority TEXT NOT NULL CHECK(priority IN ('normal', 'important', 'rights_related')),
        status TEXT NOT NULL CHECK(status IN ('open', 'answered', 'dismissed')),
        answer_source_ref TEXT REFERENCES source_items(id),
        source_refs_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX clarifications_event_idx ON clarifications(event_id, status, priority);

      CREATE VIRTUAL TABLE fts_events USING fts5(
        event_id UNINDEXED,
        title,
        narrative,
        statements,
        emotions,
        interests,
        people,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `
  },
  {
    version: 3,
    name: "phase-two-dayone-backfill",
    sql: `
      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY,
        archive_asset_id TEXT NOT NULL REFERENCES assets(id),
        archive_file_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed')),
        progress REAL NOT NULL CHECK(progress >= 0 AND progress <= 1),
        total_entries INTEGER NOT NULL DEFAULT 0 CHECK(total_entries >= 0),
        new_entries INTEGER NOT NULL DEFAULT 0 CHECK(new_entries >= 0),
        updated_entries INTEGER NOT NULL DEFAULT 0 CHECK(updated_entries >= 0),
        skipped_entries INTEGER NOT NULL DEFAULT 0 CHECK(skipped_entries >= 0),
        media_imported INTEGER NOT NULL DEFAULT 0 CHECK(media_imported >= 0),
        media_missing INTEGER NOT NULL DEFAULT 0 CHECK(media_missing >= 0),
        error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0),
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE import_issues (
        id TEXT PRIMARY KEY,
        import_run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
        severity TEXT NOT NULL CHECK(severity IN ('warning', 'error')),
        code TEXT NOT NULL,
        entry_external_id TEXT,
        archive_path TEXT,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX import_issues_run_idx ON import_issues(import_run_id, created_at);

      CREATE UNIQUE INDEX source_items_external_idx
        ON source_items(source_id, external_id) WHERE external_id IS NOT NULL;

      CREATE TABLE source_versions (
        id TEXT PRIMARY KEY,
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        version INTEGER NOT NULL CHECK(version > 0),
        content TEXT,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        external_modified_at TEXT,
        raw_json TEXT NOT NULL,
        import_run_id TEXT NOT NULL REFERENCES import_runs(id),
        created_at TEXT NOT NULL,
        UNIQUE(source_item_id, version)
      ) STRICT;

      CREATE TABLE journal_entries (
        source_item_id TEXT PRIMARY KEY REFERENCES source_items(id),
        external_id TEXT NOT NULL UNIQUE,
        entry_uuid TEXT,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
        creation_date TEXT NOT NULL,
        journal_date TEXT NOT NULL,
        modified_date TEXT,
        time_zone TEXT,
        tags_json TEXT NOT NULL,
        location_json TEXT,
        current_version_id TEXT NOT NULL REFERENCES source_versions(id),
        current_version INTEGER NOT NULL CHECK(current_version > 0),
        import_run_id TEXT NOT NULL REFERENCES import_runs(id)
      ) STRICT;
      CREATE INDEX journal_entries_date_idx ON journal_entries(journal_date, source_item_id);

      CREATE TABLE import_run_entries (
        import_run_id TEXT NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        outcome TEXT NOT NULL CHECK(outcome IN ('new', 'updated', 'skipped')),
        PRIMARY KEY(import_run_id, source_item_id)
      ) STRICT;
      CREATE INDEX import_run_entries_source_idx ON import_run_entries(source_item_id, import_run_id);

      CREATE TABLE source_version_assets (
        source_version_id TEXT NOT NULL REFERENCES source_versions(id),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        archive_path TEXT NOT NULL,
        PRIMARY KEY(source_version_id, asset_id, archive_path)
      ) STRICT;

      CREATE TABLE backfill_runs (
        id TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        detector_identity TEXT NOT NULL,
        detector_version INTEGER NOT NULL CHECK(detector_version > 0),
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'paused', 'completed', 'cancelled', 'failed')),
        total_items INTEGER NOT NULL CHECK(total_items >= 0),
        processed_items INTEGER NOT NULL CHECK(processed_items >= 0),
        candidate_count INTEGER NOT NULL CHECK(candidate_count >= 0),
        cursor TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE TABLE candidate_extractions (
        id TEXT PRIMARY KEY,
        source_version_id TEXT NOT NULL REFERENCES source_versions(id),
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        detector_identity TEXT NOT NULL,
        detector_version INTEGER NOT NULL CHECK(detector_version > 0),
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        anchor_start INTEGER NOT NULL CHECK(anchor_start >= 0),
        anchor_end INTEGER NOT NULL CHECK(anchor_end >= anchor_start),
        temporal_basis TEXT NOT NULL CHECK(temporal_basis IN ('source-text', 'relative', 'journal-date')),
        review_state TEXT NOT NULL CHECK(review_state IN ('pending', 'confirmed', 'ignored', 'merged', 'superseded')),
        merged_into_event_id TEXT REFERENCES events(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_version_id, detector_identity, detector_version, ordinal)
      ) STRICT;
      CREATE INDEX candidate_extractions_review_idx ON candidate_extractions(review_state, created_at);
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

function mapConversation(row: Record<string, unknown>): Conversation {
  const value: Conversation = {
    id: String(row.id), sourceId: String(row.source_id), title: String(row.title),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.deleted_at) value.deletedAt = String(row.deleted_at);
  return value;
}

function mapMessage(row: Record<string, unknown>): Message {
  const value: Message = {
    id: String(row.id), conversationId: String(row.conversation_id),
    sourceItemId: String(row.source_item_id), role: row.role as Message["role"],
    createdAt: String(row.created_at)
  };
  if (row.content !== null && row.content !== undefined) value.content = String(row.content);
  if (row.deleted_at) value.deletedAt = String(row.deleted_at);
  return value;
}

function mapPerson(row: Record<string, unknown>): Person {
  const value: Person = {
    id: String(row.id), displayName: String(row.display_name), status: row.status as Person["status"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.notes) value.notes = String(row.notes);
  return value;
}

function mapEvent(row: Record<string, unknown>): Event {
  return JSON.parse(String(row.snapshot_json)) as Event;
}

function mapRevision(row: Record<string, unknown>): EventRevision {
  return {
    id: String(row.id), eventId: String(row.event_id), revision: Number(row.revision),
    previousRevision: Number(row.previous_revision), snapshot: JSON.parse(String(row.snapshot_json)) as Event,
    actor: row.actor as EventRevision["actor"], reason: String(row.reason),
    sourceRefs: JSON.parse(String(row.source_refs_json)) as string[], createdAt: String(row.created_at)
  };
}

function mapClarification(row: Record<string, unknown>): Clarification {
  const value: Clarification = {
    id: String(row.id), eventId: String(row.event_id), question: String(row.question),
    reason: String(row.reason), priority: row.priority as Clarification["priority"],
    status: row.status as Clarification["status"],
    sourceRefs: JSON.parse(String(row.source_refs_json)) as string[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.field_path) value.fieldPath = String(row.field_path);
  if (row.answer_source_ref) value.answerSourceRef = String(row.answer_source_ref);
  return value;
}

function mapImportRun(row: Record<string, unknown>): ImportRun {
  const run: ImportRun = {
    id: String(row.id), archiveAssetId: String(row.archive_asset_id), archiveFileName: String(row.archive_file_name),
    state: row.state as ImportRun["state"], progress: Number(row.progress),
    counts: {
      totalEntries: Number(row.total_entries), newEntries: Number(row.new_entries),
      updatedEntries: Number(row.updated_entries), skippedEntries: Number(row.skipped_entries),
      mediaImported: Number(row.media_imported), mediaMissing: Number(row.media_missing),
      errorCount: Number(row.error_count)
    },
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.started_at) run.startedAt = String(row.started_at);
  if (row.finished_at) run.finishedAt = String(row.finished_at);
  if (row.last_error) run.lastError = String(row.last_error);
  return run;
}

function mapImportIssue(row: Record<string, unknown>): ImportIssue {
  const issue: ImportIssue = {
    id: String(row.id), importRunId: String(row.import_run_id), severity: row.severity as ImportIssue["severity"],
    code: String(row.code), message: String(row.message), createdAt: String(row.created_at)
  };
  if (row.entry_external_id) issue.entryExternalId = String(row.entry_external_id);
  if (row.archive_path) issue.archivePath = String(row.archive_path);
  return issue;
}

function mapSourceVersion(row: Record<string, unknown>): SourceVersion {
  const version: SourceVersion = {
    id: String(row.id), sourceItemId: String(row.source_item_id), version: Number(row.version),
    contentHash: String(row.content_hash), raw: JSON.parse(String(row.raw_json)),
    importRunId: String(row.import_run_id), createdAt: String(row.created_at)
  };
  if (row.content !== null && row.content !== undefined) version.content = String(row.content);
  if (row.external_modified_at) version.externalModifiedAt = String(row.external_modified_at);
  return version;
}

function mapJournalEntry(row: Record<string, unknown>): JournalEntry {
  const entry: JournalEntry = {
    sourceItemId: String(row.source_item_id), externalId: String(row.external_id),
    fingerprint: String(row.fingerprint), creationDate: String(row.creation_date), journalDate: String(row.journal_date),
    tags: JSON.parse(String(row.tags_json)) as string[], currentVersionId: String(row.current_version_id),
    currentVersion: Number(row.current_version), importRunId: String(row.import_run_id)
  };
  if (row.entry_uuid) entry.entryUuid = String(row.entry_uuid);
  if (row.modified_date) entry.modifiedDate = String(row.modified_date);
  if (row.time_zone) entry.timeZone = String(row.time_zone);
  if (row.location_json) {
    const location = JSON.parse(String(row.location_json)) as JournalEntry["location"];
    if (location) entry.location = location;
  }
  return entry;
}

function mapBackfillRun(row: Record<string, unknown>): BackfillRun {
  const run: BackfillRun = {
    id: String(row.id), scope: JSON.parse(String(row.scope_json)) as BackfillRun["scope"],
    detectorIdentity: String(row.detector_identity), detectorVersion: Number(row.detector_version),
    state: row.state as BackfillRun["state"], totalItems: Number(row.total_items),
    processedItems: Number(row.processed_items), candidateCount: Number(row.candidate_count),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.cursor) run.cursor = String(row.cursor);
  if (row.last_error) run.lastError = String(row.last_error);
  if (row.finished_at) run.finishedAt = String(row.finished_at);
  return run;
}

function mapExtraction(row: Record<string, unknown>): CandidateExtraction {
  const extraction: CandidateExtraction = {
    id: String(row.id), sourceVersionId: String(row.source_version_id), eventId: String(row.event_id),
    detectorIdentity: String(row.detector_identity), detectorVersion: Number(row.detector_version),
    ordinal: Number(row.ordinal), anchorStart: Number(row.anchor_start), anchorEnd: Number(row.anchor_end),
    temporalBasis: row.temporal_basis as CandidateExtraction["temporalBasis"],
    reviewState: row.review_state as CandidateExtraction["reviewState"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.merged_into_event_id) extraction.mergedIntoEventId = String(row.merged_into_event_id);
  return extraction;
}

function temporalBounds(event: Event): { from: string | null; to: string | null } {
  const temporal = event.occurredAt;
  if (temporal.kind === "instant" || temporal.kind === "date") {
    const value = temporal.value.slice(0, 10);
    return { from: value, to: value };
  }
  if (temporal.kind === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(temporal.value);
    if (!match?.[1] || !match[2]) return { from: null, to: null };
    const year = Number(match[1]);
    const month = Number(match[2]);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}` };
  }
  if (temporal.kind === "range") return { from: temporal.from?.slice(0, 10) ?? null, to: temporal.to?.slice(0, 10) ?? null };
  return { from: null, to: null };
}

function ftsQuery(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

export class SqliteMemoryRepository implements MemoryRepositoryPort {
  constructor(private readonly database: Database.Database) {}

  listConversations(): Conversation[] {
    return (this.database.prepare(
      "SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC"
    ).all() as Record<string, unknown>[]).map(mapConversation);
  }

  createConversation(conversation: Conversation, source: Source): Conversation {
    return this.database.transaction(() => {
      this.insertSource(source);
      this.database.prepare(`
        INSERT INTO conversations(id, source_id, title, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(conversation.id, conversation.sourceId, conversation.title, conversation.createdAt, conversation.updatedAt);
      return conversation;
    })();
  }

  renameConversation(id: string, title: string, now: string): Conversation {
    return this.database.transaction(() => {
      const result = this.database.prepare(
        "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      ).run(title, now, id);
      if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The conversation no longer exists.");
      this.database.prepare(
        "UPDATE sources SET name = ? WHERE id = (SELECT source_id FROM conversations WHERE id = ?)"
      ).run(title, id);
      return this.getConversationRequired(id);
    })();
  }

  deleteConversation(id: string, now: string): Conversation {
    return this.database.transaction(() => {
      const conversation = this.getConversationRequired(id);
      if (conversation.deletedAt) return conversation;
      this.database.prepare(
        "UPDATE conversations SET title = 'Deleted conversation', deleted_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, id);
      this.database.prepare(
        "UPDATE sources SET name = 'Deleted conversation' WHERE id = ?"
      ).run(conversation.sourceId);
      this.database.prepare(
        "UPDATE messages SET content = NULL, deleted_at = ? WHERE conversation_id = ?"
      ).run(now, id);
      this.database.prepare(`
        UPDATE source_items SET content = NULL, deleted_at = ?
        WHERE id IN (SELECT source_item_id FROM messages WHERE conversation_id = ?)
      `).run(now, id);
      return this.getConversationRequired(id);
    })();
  }

  listMessages(conversationId: string): Message[] {
    this.getConversationRequired(conversationId);
    return (this.database.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, id"
    ).all(conversationId) as Record<string, unknown>[]).map(mapMessage);
  }

  appendMessage(message: Message, sourceItem: SourceItem): Message {
    return this.database.transaction(() => {
      const row = this.database.prepare(
        "SELECT source_id FROM conversations WHERE id = ? AND deleted_at IS NULL"
      ).get(message.conversationId) as { source_id: string } | undefined;
      if (!row) throw new AppError("ENTITY_NOT_FOUND", "The conversation no longer exists.");
      this.insertSourceItem({ ...sourceItem, sourceId: row.source_id });
      this.database.prepare(`
        INSERT INTO messages(id, conversation_id, source_item_id, role, content, created_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(message.id, message.conversationId, message.sourceItemId, message.role, message.content ?? null, message.createdAt);
      this.database.prepare(
        "UPDATE conversations SET updated_at = ? WHERE id = ?"
      ).run(message.createdAt, message.conversationId);
      return message;
    })();
  }

  searchEvents(query: EventSearchQuery): Event[] {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    const hasText = Boolean(query.text?.trim());
    if (hasText) {
      conditions.push("fts_events MATCH ?");
      parameters.push(ftsQuery(query.text!));
    }
    if (query.status) {
      conditions.push("e.status = ?");
      parameters.push(query.status);
    }
    if (query.personId) {
      conditions.push("EXISTS (SELECT 1 FROM event_people ep WHERE ep.event_id = e.id AND ep.person_id = ?)");
      parameters.push(query.personId);
    }
    if (query.from) {
      conditions.push("e.occurred_to IS NOT NULL AND e.occurred_to >= ?");
      parameters.push(query.from);
    }
    if (query.to) {
      conditions.push("e.occurred_from IS NOT NULL AND e.occurred_from <= ?");
      parameters.push(query.to);
    }
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    parameters.push(limit);
    const rows = this.database.prepare(`
      SELECT e.* FROM events e
      ${hasText ? "JOIN fts_events ON fts_events.event_id = e.id" : ""}
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY ${hasText ? "bm25(fts_events), e.updated_at DESC" : "e.updated_at DESC"}
      LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map(mapEvent);
  }

  getEvent(id: string): Event | undefined {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapEvent(row) : undefined;
  }

  getEventDetail(id: string): EventDetail | undefined {
    const event = this.getEvent(id);
    if (!event) return undefined;
    const people = (this.database.prepare(`
      SELECT p.* FROM people p JOIN event_people ep ON ep.person_id = p.id
      WHERE ep.event_id = ? ORDER BY p.display_name
    `).all(id) as Record<string, unknown>[]).map(mapPerson);
    const assets = (this.database.prepare(`
      SELECT a.* FROM assets a JOIN event_assets ea ON ea.asset_id = a.id
      WHERE ea.event_id = ? ORDER BY a.created_at
    `).all(id) as Record<string, unknown>[]).map(mapAsset);
    return { event, people, assets, clarifications: this.listClarifications(id) };
  }

  listEventRevisions(id: string): EventRevision[] {
    return (this.database.prepare(
      "SELECT * FROM event_revisions WHERE event_id = ? ORDER BY revision DESC"
    ).all(id) as Record<string, unknown>[]).map(mapRevision);
  }

  commitEvent(event: Event, revision: EventRevision, extras: EventCommitExtras = {}): Event {
    return this.database.transaction(() => {
      for (const source of extras.sources ?? []) this.insertSource(source);
      for (const item of extras.sourceItems ?? []) this.insertSourceItem(item);
      const current = this.database.prepare(
        "SELECT current_revision FROM events WHERE id = ?"
      ).get(event.id) as { current_revision: number } | undefined;
      if (current) {
        if (current.current_revision !== revision.previousRevision || event.currentRevision !== current.current_revision + 1) {
          throw new AppError("EVENT_REVISION_CONFLICT", "The event changed after it was opened. Reload it before saving.", true);
        }
        const bounds = temporalBounds(event);
        this.database.prepare(`
          UPDATE events SET title = ?, status = ?, occurred_from = ?, occurred_to = ?,
            updated_at = ?, current_revision = ?, snapshot_json = ? WHERE id = ?
        `).run(event.title, event.status, bounds.from, bounds.to, event.updatedAt,
          event.currentRevision, JSON.stringify(event), event.id);
      } else {
        if (revision.previousRevision !== 0 || event.currentRevision !== 1) {
          throw new AppError("EVENT_REVISION_CONFLICT", "A new event must start at revision 1.");
        }
        const bounds = temporalBounds(event);
        this.database.prepare(`
          INSERT INTO events(id, title, status, occurred_from, occurred_to, recorded_at,
            updated_at, current_revision, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(event.id, event.title, event.status, bounds.from, bounds.to, event.recordedAt,
          event.updatedAt, event.currentRevision, JSON.stringify(event));
      }
      if (revision.eventId !== event.id || revision.revision !== event.currentRevision) {
        throw new AppError("VALIDATION_FAILED", "The event revision does not match its projection.");
      }
      this.database.prepare(`
        INSERT INTO event_revisions(id, event_id, revision, previous_revision, snapshot_json,
          actor, reason, source_refs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.eventId, revision.revision, revision.previousRevision,
        JSON.stringify(revision.snapshot), revision.actor, revision.reason,
        JSON.stringify(revision.sourceRefs), revision.createdAt);
      this.replaceLinks(event);
      for (const clarification of extras.clarifications ?? []) this.upsertClarification(clarification);
      this.refreshFts(event.id);
      return event;
    })();
  }

  listPeople(includeArchived = false): Person[] {
    const sql = includeArchived
      ? "SELECT * FROM people ORDER BY display_name"
      : "SELECT * FROM people WHERE status = 'active' ORDER BY display_name";
    return (this.database.prepare(sql).all() as Record<string, unknown>[]).map(mapPerson);
  }

  getPerson(id: string): Person | undefined {
    const row = this.database.prepare("SELECT * FROM people WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapPerson(row) : undefined;
  }

  createPerson(person: Person): Person {
    this.database.prepare(`
      INSERT INTO people(id, display_name, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(person.id, person.displayName, person.notes ?? null, person.status, person.createdAt, person.updatedAt);
    return person;
  }

  updatePerson(person: Person): Person {
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE people SET display_name = ?, notes = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(person.displayName, person.notes ?? null, person.status, person.updatedAt, person.id);
      if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The person no longer exists.");
      const eventIds = this.database.prepare(
        "SELECT event_id FROM event_people WHERE person_id = ?"
      ).all(person.id) as Array<{ event_id: string }>;
      for (const { event_id } of eventIds) this.refreshFts(event_id);
      return person;
    })();
  }

  listClarifications(eventId?: string): Clarification[] {
    const rows = eventId
      ? this.database.prepare("SELECT * FROM clarifications WHERE event_id = ? ORDER BY created_at").all(eventId)
      : this.database.prepare("SELECT * FROM clarifications ORDER BY status, priority DESC, created_at").all();
    return (rows as Record<string, unknown>[]).map(mapClarification);
  }

  getClarification(id: string): Clarification | undefined {
    const row = this.database.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapClarification(row) : undefined;
  }

  private getConversationRequired(id: string): Conversation {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("ENTITY_NOT_FOUND", "The conversation no longer exists.");
    return mapConversation(row);
  }

  private insertSource(source: Source): void {
    this.database.prepare(
      "INSERT INTO sources(id, kind, name, created_at) VALUES (?, ?, ?, ?)"
    ).run(source.id, source.kind, source.name, source.createdAt);
  }

  private insertSourceItem(item: SourceItem): void {
    this.database.prepare(`
      INSERT INTO source_items(id, source_id, external_id, content, recorded_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(item.id, item.sourceId, item.externalId ?? null, item.content ?? null, item.recordedAt, item.deletedAt ?? null);
    for (const assetId of item.assetRefs) {
      this.database.prepare(
        "INSERT INTO source_item_assets(source_item_id, asset_id) VALUES (?, ?)"
      ).run(item.id, assetId);
    }
  }

  private replaceLinks(event: Event): void {
    this.database.prepare("DELETE FROM event_sources WHERE event_id = ?").run(event.id);
    this.database.prepare("DELETE FROM event_assets WHERE event_id = ?").run(event.id);
    this.database.prepare("DELETE FROM event_people WHERE event_id = ?").run(event.id);
    for (const sourceRef of event.sourceRefs) {
      this.database.prepare("INSERT INTO event_sources(event_id, source_item_id) VALUES (?, ?)").run(event.id, sourceRef);
    }
    for (const assetRef of event.assetRefs) {
      this.database.prepare("INSERT INTO event_assets(event_id, asset_id) VALUES (?, ?)").run(event.id, assetRef);
    }
    for (const participant of event.participants) {
      this.database.prepare("INSERT INTO event_people(event_id, person_id, role) VALUES (?, ?, ?)")
        .run(event.id, participant.personId, participant.role ?? null);
    }
  }

  private upsertClarification(value: Clarification): void {
    this.database.prepare(`
      INSERT INTO clarifications(id, event_id, field_path, question, reason, priority, status,
        answer_source_ref, source_refs_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status,
        answer_source_ref = excluded.answer_source_ref, updated_at = excluded.updated_at
    `).run(value.id, value.eventId, value.fieldPath ?? null, value.question, value.reason,
      value.priority, value.status, value.answerSourceRef ?? null, JSON.stringify(value.sourceRefs),
      value.createdAt, value.updatedAt);
  }

  private refreshFts(eventId: string): void {
    const event = this.getEvent(eventId);
    if (!event) return;
    const people = (this.database.prepare(`
      SELECT p.display_name FROM people p JOIN event_people ep ON ep.person_id = p.id
      WHERE ep.event_id = ? ORDER BY p.display_name
    `).all(eventId) as Array<{ display_name: string }>).map(({ display_name }) => display_name).join(" ");
    const statements = [...event.facts, ...event.interpretations].map(({ text }) => text).join(" ");
    const emotions = event.emotions.map(({ label }) => label).join(" ");
    const interests = event.interests.map(({ label, description }) => `${label} ${description ?? ""}`).join(" ");
    this.database.prepare("DELETE FROM fts_events WHERE event_id = ?").run(eventId);
    this.database.prepare(`
      INSERT INTO fts_events(event_id, title, narrative, statements, emotions, interests, people)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, event.title, event.narrative ?? "", statements, emotions, interests, people);
  }
}

export class SqliteDayOneRepository implements DayOneRepositoryPort {
  constructor(private readonly database: Database.Database, private readonly memory: SqliteMemoryRepository) {}

  createImportRun(run: ImportRun): ImportRun {
    this.database.prepare(`
      INSERT INTO import_runs(id, archive_asset_id, archive_file_name, state, progress,
        total_entries, new_entries, updated_entries, skipped_entries, media_imported,
        media_missing, error_count, started_at, finished_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.archiveAssetId, run.archiveFileName, run.state, run.progress,
      run.counts.totalEntries, run.counts.newEntries, run.counts.updatedEntries, run.counts.skippedEntries,
      run.counts.mediaImported, run.counts.mediaMissing, run.counts.errorCount,
      run.startedAt ?? null, run.finishedAt ?? null, run.lastError ?? null, run.createdAt, run.updatedAt);
    return run;
  }

  listImportRuns(): ImportRun[] {
    return (this.database.prepare("SELECT * FROM import_runs ORDER BY created_at DESC").all() as Record<string, unknown>[]).map(mapImportRun);
  }

  getImportRun(id: string): ImportRun | undefined {
    const row = this.database.prepare("SELECT * FROM import_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapImportRun(row) : undefined;
  }

  getImportRunDetail(id: string): ImportRunDetail | undefined {
    const run = this.getImportRun(id);
    if (!run) return undefined;
    const issues = (this.database.prepare(
      "SELECT * FROM import_issues WHERE import_run_id = ? ORDER BY created_at, id"
    ).all(id) as Record<string, unknown>[]).map(mapImportIssue);
    return { run, issues };
  }

  startImportRun(id: string, now: string): ImportRun {
    const run = this.getImportRun(id);
    if (!run) throw new AppError("ENTITY_NOT_FOUND", "The import run no longer exists.");
    if (run.state !== "queued" && run.state !== "failed" && run.state !== "running") {
      throw new AppError("IMPORT_RUN_STATE_CONFLICT", "The import run cannot be started from its current state.");
    }
    return this.updateImportRun({ ...run, state: "running", startedAt: run.startedAt ?? now, updatedAt: now, progress: 0 });
  }

  updateImportRun(run: ImportRun): ImportRun {
    const result = this.database.prepare(`
      UPDATE import_runs SET state = ?, progress = ?, total_entries = ?, new_entries = ?,
        updated_entries = ?, skipped_entries = ?, media_imported = ?, media_missing = ?,
        error_count = ?, started_at = ?, finished_at = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(run.state, run.progress, run.counts.totalEntries, run.counts.newEntries,
      run.counts.updatedEntries, run.counts.skippedEntries, run.counts.mediaImported,
      run.counts.mediaMissing, run.counts.errorCount, run.startedAt ?? null, run.finishedAt ?? null,
      run.lastError ?? null, run.updatedAt, run.id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The import run no longer exists.");
    return this.getImportRun(run.id)!;
  }

  addImportIssue(issue: ImportIssue): ImportIssue {
    this.database.prepare(`
      INSERT INTO import_issues(id, import_run_id, severity, code, entry_external_id, archive_path, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(issue.id, issue.importRunId, issue.severity, issue.code, issue.entryExternalId ?? null,
      issue.archivePath ?? null, issue.message, issue.createdAt);
    return issue;
  }

  upsertEntry(importRunId: string, entry: NormalizedDayOneEntry, now: string) {
    return this.database.transaction(() => {
      let source = this.database.prepare("SELECT id FROM sources WHERE kind = 'dayone' ORDER BY created_at LIMIT 1")
        .get() as { id: string } | undefined;
      if (!source) {
        source = { id: randomUUID() };
        this.database.prepare("INSERT INTO sources(id, kind, name, created_at) VALUES (?, 'dayone', 'Day One', ?)")
          .run(source.id, now);
      }
      const existingRow = this.database.prepare(`
        SELECT je.*, sv.content AS sv_content, sv.content_hash, sv.external_modified_at,
          sv.raw_json, sv.import_run_id AS sv_import_run_id, sv.created_at AS sv_created_at
        FROM journal_entries je JOIN source_versions sv ON sv.id = je.current_version_id
        WHERE je.external_id = ?
      `).get(entry.externalId) as Record<string, unknown> | undefined;
      if (existingRow && String(existingRow.content_hash) === entry.contentHash) {
        this.database.prepare(`
          INSERT INTO import_run_entries(import_run_id, source_item_id, outcome) VALUES (?, ?, 'skipped')
          ON CONFLICT(import_run_id, source_item_id) DO UPDATE SET outcome = excluded.outcome
        `).run(importRunId, existingRow.source_item_id);
        return {
          outcome: "skipped" as const,
          journalEntry: mapJournalEntry(existingRow),
          sourceVersion: mapSourceVersion({
            id: existingRow.current_version_id, source_item_id: existingRow.source_item_id,
            version: existingRow.current_version, content: existingRow.sv_content,
            content_hash: existingRow.content_hash, external_modified_at: existingRow.external_modified_at,
            raw_json: existingRow.raw_json, import_run_id: existingRow.sv_import_run_id,
            created_at: existingRow.sv_created_at
          })
        };
      }

      const sourceItemId = existingRow ? String(existingRow.source_item_id) : randomUUID();
      const versionNumber = existingRow ? Number(existingRow.current_version) + 1 : 1;
      if (existingRow) {
        const pending = this.database.prepare(`
          SELECT event_id FROM candidate_extractions
          WHERE source_version_id = ? AND review_state = 'pending'
        `).all(existingRow.current_version_id) as Array<{ event_id: string }>;
        for (const { event_id: eventId } of pending) {
          const candidate = this.memory.getEvent(eventId);
          if (candidate) {
            const archived: Event = {
              ...candidate, status: "archived", currentRevision: candidate.currentRevision + 1, updatedAt: now
            };
            this.memory.commitEvent(archived, {
              id: randomUUID(), eventId, revision: archived.currentRevision,
              previousRevision: candidate.currentRevision, snapshot: archived, actor: "importer",
              reason: "Superseded by a newer Day One source version", sourceRefs: candidate.sourceRefs, createdAt: now
            });
          }
          this.database.prepare(`
            UPDATE candidate_extractions SET review_state = 'superseded', updated_at = ? WHERE event_id = ?
          `).run(now, eventId);
        }
      }
      if (!existingRow) {
        this.database.prepare(`
          INSERT INTO source_items(id, source_id, external_id, content, recorded_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, NULL)
        `).run(sourceItemId, source.id, entry.externalId, entry.text, entry.creationDate);
      } else {
        this.database.prepare("UPDATE source_items SET content = ?, recorded_at = ?, deleted_at = NULL WHERE id = ?")
          .run(entry.text, entry.creationDate, sourceItemId);
      }
      const sourceVersion: SourceVersion = {
        id: randomUUID(), sourceItemId, version: versionNumber, content: entry.text,
        contentHash: entry.contentHash, raw: entry.raw, importRunId, createdAt: now,
        ...(entry.modifiedDate ? { externalModifiedAt: entry.modifiedDate } : {})
      };
      this.database.prepare(`
        INSERT INTO source_versions(id, source_item_id, version, content, content_hash,
          external_modified_at, raw_json, import_run_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sourceVersion.id, sourceItemId, versionNumber, entry.text, entry.contentHash,
        entry.modifiedDate ?? null, JSON.stringify(entry.raw), importRunId, now);
      if (existingRow) {
        this.database.prepare(`
          UPDATE journal_entries SET entry_uuid = ?, fingerprint = ?, creation_date = ?, journal_date = ?, modified_date = ?,
            time_zone = ?, tags_json = ?, location_json = ?, current_version_id = ?, current_version = ?, import_run_id = ?
          WHERE source_item_id = ?
        `).run(entry.entryUuid ?? null, entry.fingerprint, entry.creationDate, entry.journalDate, entry.modifiedDate ?? null,
          entry.timeZone ?? null, JSON.stringify(entry.tags), entry.location ? JSON.stringify(entry.location) : null,
          sourceVersion.id, versionNumber, importRunId, sourceItemId);
      } else {
        this.database.prepare(`
          INSERT INTO journal_entries(source_item_id, external_id, entry_uuid, fingerprint, creation_date,
            journal_date, modified_date, time_zone, tags_json, location_json, current_version_id, current_version, import_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sourceItemId, entry.externalId, entry.entryUuid ?? null, entry.fingerprint, entry.creationDate,
          entry.journalDate, entry.modifiedDate ?? null, entry.timeZone ?? null, JSON.stringify(entry.tags),
          entry.location ? JSON.stringify(entry.location) : null, sourceVersion.id, versionNumber, importRunId);
      }
      const journalRow = this.database.prepare("SELECT * FROM journal_entries WHERE source_item_id = ?")
        .get(sourceItemId) as Record<string, unknown>;
      this.database.prepare(`
        INSERT INTO import_run_entries(import_run_id, source_item_id, outcome) VALUES (?, ?, ?)
        ON CONFLICT(import_run_id, source_item_id) DO UPDATE SET outcome = excluded.outcome
      `).run(importRunId, sourceItemId, existingRow ? "updated" : "new");
      return { outcome: existingRow ? "updated" as const : "new" as const, journalEntry: mapJournalEntry(journalRow), sourceVersion };
    })();
  }

  linkMedia(importRunId: string, externalIds: string[], assetId: string, archivePath: string, now: string): void {
    void importRunId;
    void now;
    this.database.transaction(() => {
      for (const externalId of externalIds) {
        const row = this.database.prepare(
          "SELECT source_item_id, current_version_id FROM journal_entries WHERE external_id = ?"
        ).get(externalId) as { source_item_id: string; current_version_id: string } | undefined;
        if (!row) continue;
        this.database.prepare("INSERT OR IGNORE INTO source_item_assets(source_item_id, asset_id) VALUES (?, ?)")
          .run(row.source_item_id, assetId);
        this.database.prepare(`
          INSERT OR IGNORE INTO source_version_assets(source_version_id, asset_id, archive_path) VALUES (?, ?, ?)
        `).run(row.current_version_id, assetId, archivePath);
      }
    })();
  }

  createBackfillRun(run: BackfillRun): BackfillRun {
    this.database.prepare(`
      INSERT INTO backfill_runs(id, scope_json, detector_identity, detector_version, state,
        total_items, processed_items, candidate_count, cursor, last_error, created_at, updated_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, JSON.stringify(run.scope), run.detectorIdentity, run.detectorVersion, run.state,
      run.totalItems, run.processedItems, run.candidateCount, run.cursor ?? null, run.lastError ?? null,
      run.createdAt, run.updatedAt, run.finishedAt ?? null);
    return run;
  }

  listBackfillRuns(): BackfillRun[] {
    return (this.database.prepare("SELECT * FROM backfill_runs ORDER BY created_at DESC").all() as Record<string, unknown>[])
      .map(mapBackfillRun);
  }

  getBackfillRun(id: string): BackfillRun | undefined {
    const row = this.database.prepare("SELECT * FROM backfill_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapBackfillRun(row) : undefined;
  }

  updateBackfillRun(run: BackfillRun): BackfillRun {
    const result = this.database.prepare(`
      UPDATE backfill_runs SET scope_json = ?, state = ?, total_items = ?, processed_items = ?,
        candidate_count = ?, cursor = ?, last_error = ?, updated_at = ?, finished_at = ? WHERE id = ?
    `).run(JSON.stringify(run.scope), run.state, run.totalItems, run.processedItems, run.candidateCount,
      run.cursor ?? null, run.lastError ?? null, run.updatedAt, run.finishedAt ?? null, run.id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The backfill run no longer exists.");
    return this.getBackfillRun(run.id)!;
  }

  listBackfillSourceVersions(run: BackfillRun): Array<{ journalEntry: JournalEntry; sourceVersion: SourceVersion; assetRefs: string[] }> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (run.scope.importRunId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM import_run_entries ire
        WHERE ire.import_run_id = ? AND ire.source_item_id = je.source_item_id
      )`);
      parameters.push(run.scope.importRunId);
    }
    if (run.scope.from) { conditions.push("je.journal_date >= ?"); parameters.push(run.scope.from); }
    if (run.scope.to) { conditions.push("je.journal_date <= ?"); parameters.push(run.scope.to); }
    const rows = this.database.prepare(`
      SELECT je.*, sv.id AS sv_id, sv.source_item_id AS sv_source_item_id, sv.version AS sv_version,
        sv.content AS sv_content, sv.content_hash, sv.external_modified_at, sv.raw_json,
        sv.import_run_id AS sv_import_run_id, sv.created_at AS sv_created_at
      FROM journal_entries je JOIN source_versions sv ON sv.id = je.current_version_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY je.source_item_id
    `).all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => {
      const journalEntry = mapJournalEntry(row);
      return {
        journalEntry,
        sourceVersion: mapSourceVersion({
          id: row.sv_id, source_item_id: row.sv_source_item_id, version: row.sv_version,
          content: row.sv_content, content_hash: row.content_hash, external_modified_at: row.external_modified_at,
          raw_json: row.raw_json, import_run_id: row.sv_import_run_id, created_at: row.sv_created_at
        }),
        assetRefs: (this.database.prepare(
          "SELECT asset_id FROM source_version_assets WHERE source_version_id = ? ORDER BY asset_id"
        ).all(row.sv_id) as Array<{ asset_id: string }>).map(({ asset_id }) => asset_id)
      };
    }).filter(({ journalEntry }) => run.scope.tags.length === 0 || run.scope.tags.some((tag) => journalEntry.tags.includes(tag)));
  }

  findExtraction(sourceVersionId: string, detectorIdentity: string, detectorVersion: number, ordinal: number): CandidateExtraction | undefined {
    const row = this.database.prepare(`
      SELECT * FROM candidate_extractions WHERE source_version_id = ? AND detector_identity = ?
        AND detector_version = ? AND ordinal = ?
    `).get(sourceVersionId, detectorIdentity, detectorVersion, ordinal) as Record<string, unknown> | undefined;
    return row ? mapExtraction(row) : undefined;
  }

  listCandidates(memoryGetEvent: (id: string) => Event | undefined): CandidateSummary[] {
    const rows = this.database.prepare(`
      SELECT ce.*, sv.content, je.* FROM candidate_extractions ce
      JOIN source_versions sv ON sv.id = ce.source_version_id
      JOIN journal_entries je ON je.source_item_id = sv.source_item_id
      WHERE ce.review_state = 'pending' ORDER BY je.journal_date DESC, ce.created_at DESC
    `).all() as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const event = memoryGetEvent(String(row.event_id));
      if (!event) return [];
      const content = String(row.content ?? "");
      const extraction = mapExtraction(row);
      return [{ extraction, event, journalEntry: mapJournalEntry(row), excerpt: content.slice(extraction.anchorStart, extraction.anchorEnd) }];
    });
  }

  getCandidate(eventId: string, memoryGetDetail: (id: string) => CandidateDetail["detail"] | undefined): CandidateDetail | undefined {
    const row = this.database.prepare(`
      SELECT ce.*, sv.id AS sv_id, sv.source_item_id AS sv_source_item_id, sv.version AS sv_version,
        sv.content AS sv_content, sv.content_hash, sv.external_modified_at, sv.raw_json,
        sv.import_run_id AS sv_import_run_id, sv.created_at AS sv_created_at, je.*
      FROM candidate_extractions ce JOIN source_versions sv ON sv.id = ce.source_version_id
      JOIN journal_entries je ON je.source_item_id = sv.source_item_id WHERE ce.event_id = ?
    `).get(eventId) as Record<string, unknown> | undefined;
    const detail = memoryGetDetail(eventId);
    if (!row || !detail) return undefined;
    const extraction = mapExtraction(row);
    const sourceVersion = mapSourceVersion({
      id: row.sv_id, source_item_id: row.sv_source_item_id, version: row.sv_version,
      content: row.sv_content, content_hash: row.content_hash, external_modified_at: row.external_modified_at,
      raw_json: row.raw_json, import_run_id: row.sv_import_run_id, created_at: row.sv_created_at
    });
    const content = sourceVersion.content ?? "";
    return {
      extraction, event: detail.event, detail, sourceVersion, journalEntry: mapJournalEntry(row),
      excerpt: content.slice(extraction.anchorStart, extraction.anchorEnd)
    };
  }

  commitCandidate(event: Event, extraction: CandidateExtraction, clarification: Clarification | undefined): Event {
    return this.database.transaction(() => {
      const revision: EventRevision = {
        id: randomUUID(), eventId: event.id, revision: 1, previousRevision: 0, snapshot: event,
        actor: "importer", reason: "Proposed from Day One source", sourceRefs: event.sourceRefs,
        createdAt: event.updatedAt
      };
      this.memory.commitEvent(event, revision, clarification ? { clarifications: [clarification] } : {});
      this.database.prepare(`
        INSERT INTO candidate_extractions(id, source_version_id, event_id, detector_identity,
          detector_version, ordinal, anchor_start, anchor_end, temporal_basis, review_state,
          merged_into_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(extraction.id, extraction.sourceVersionId, extraction.eventId, extraction.detectorIdentity,
        extraction.detectorVersion, extraction.ordinal, extraction.anchorStart, extraction.anchorEnd,
        extraction.temporalBasis, extraction.reviewState, extraction.createdAt, extraction.updatedAt);
      return event;
    })();
  }

  commitCandidateReview(event: Event, revision: EventRevision, state: "confirmed" | "ignored"): Event {
    return this.database.transaction(() => {
      const extraction = this.database.prepare("SELECT * FROM candidate_extractions WHERE event_id = ?")
        .get(event.id) as Record<string, unknown> | undefined;
      if (!extraction || extraction.review_state !== "pending") {
        throw new AppError("CANDIDATE_STATE_CONFLICT", "The candidate has already been reviewed.");
      }
      this.memory.commitEvent(event, revision);
      this.database.prepare("UPDATE candidate_extractions SET review_state = ?, updated_at = ? WHERE event_id = ?")
        .run(state, revision.createdAt, event.id);
      return event;
    })();
  }

  setCandidateReview(eventId: string, state: CandidateExtraction["reviewState"], now: string, mergedIntoEventId?: string): void {
    const result = this.database.prepare(`
      UPDATE candidate_extractions SET review_state = ?, merged_into_event_id = ?, updated_at = ? WHERE event_id = ?
    `).run(state, mergedIntoEventId ?? null, now, eventId);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The candidate extraction no longer exists.");
  }

  mergeCandidate(input: CandidateMergeInput, now: string): CandidateMergeResult {
    return this.database.transaction(() => {
      const candidate = this.memory.getEvent(input.candidateEventId);
      const target = this.memory.getEvent(input.targetEventId);
      if (!candidate || !target) throw new AppError("ENTITY_NOT_FOUND", "The candidate or target event no longer exists.");
      if (candidate.currentRevision !== input.candidateExpectedRevision || target.currentRevision !== input.targetExpectedRevision) {
        throw new AppError("EVENT_REVISION_CONFLICT", "An event changed after it was opened. Reload it before merging.", true);
      }
      const extraction = this.database.prepare("SELECT review_state FROM candidate_extractions WHERE event_id = ?")
        .get(candidate.id) as { review_state: string } | undefined;
      if (!extraction || extraction.review_state !== "pending") {
        throw new AppError("CANDIDATE_STATE_CONFLICT", "The candidate has already been reviewed.");
      }
      const nextTarget: Event = {
        ...target, sourceRefs: [...new Set([...target.sourceRefs, ...candidate.sourceRefs])],
        assetRefs: [...new Set([...target.assetRefs, ...candidate.assetRefs])],
        currentRevision: target.currentRevision + 1, updatedAt: now
      };
      const nextCandidate: Event = {
        ...candidate, status: "archived", currentRevision: candidate.currentRevision + 1, updatedAt: now
      };
      const targetRevision: EventRevision = {
        id: randomUUID(), eventId: target.id, revision: nextTarget.currentRevision,
        previousRevision: target.currentRevision, snapshot: nextTarget, actor: "user",
        reason: "Merged Day One candidate sources", sourceRefs: candidate.sourceRefs, createdAt: now
      };
      const candidateRevision: EventRevision = {
        id: randomUUID(), eventId: candidate.id, revision: nextCandidate.currentRevision,
        previousRevision: candidate.currentRevision, snapshot: nextCandidate, actor: "user",
        reason: `Merged into event ${target.id}`, sourceRefs: candidate.sourceRefs, createdAt: now
      };
      this.memory.commitEvent(nextTarget, targetRevision);
      this.memory.commitEvent(nextCandidate, candidateRevision);
      this.setCandidateReview(candidate.id, "merged", now, target.id);
      return { candidate: nextCandidate, target: nextTarget };
    })();
  }
}

export class SqliteWorkspaceDatabase {
  readonly assets: SqliteAssetRepository;
  readonly jobs: SqliteJobRepository;
  readonly memory: SqliteMemoryRepository;
  readonly dayOne: SqliteDayOneRepository;

  constructor(readonly database: Database.Database) {
    this.assets = new SqliteAssetRepository(database);
    this.jobs = new SqliteJobRepository(database);
    this.memory = new SqliteMemoryRepository(database);
    this.dayOne = new SqliteDayOneRepository(database, this.memory);
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

  async backup(destinationPath: string): Promise<void> {
    await this.database.backup(destinationPath);
  }

  close(): void {
    this.database.close();
  }
}

export function inspectWorkspaceSnapshot(path: string): { workspaceId: string; assetHashes: string[] } {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const workspace = database.prepare("SELECT workspace_id FROM workspace_meta LIMIT 1").get() as
      | { workspace_id: string }
      | undefined;
    if (!workspace) throw new Error("Workspace metadata is missing.");
    const assets = database.prepare("SELECT sha256 FROM assets ORDER BY sha256").all() as Array<{ sha256: string }>;
    return { workspaceId: workspace.workspace_id, assetHashes: assets.map(({ sha256 }) => sha256) };
  } finally {
    database.close();
  }
}

export function prepareRestoredSnapshot(path: string, now: string): void {
  const database = new Database(path, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.transaction(() => {
      database.prepare(`
        UPDATE job_attempts SET finished_at = ?, outcome = 'abandoned', error = 'Restored from backup.'
        WHERE finished_at IS NULL
      `).run(now);
      database.prepare(`
        UPDATE jobs SET state = 'queued', progress = 0, available_at = ?, lease_until = NULL,
          last_error = NULL, updated_at = ? WHERE state = 'running'
      `).run(now, now);
    })();
  } finally {
    database.close();
  }
}
