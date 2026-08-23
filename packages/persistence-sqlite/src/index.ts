import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AssetRepositoryPort, EventCommitExtras, JobRepositoryPort, MemoryRepositoryPort
} from "@grudge-vault/application";
import type {
  Asset, Clarification, Conversation, Event, EventDetail, EventRevision,
  EventSearchQuery, Job, JobState, Message, Person, Source, SourceItem, Workspace
} from "@grudge-vault/domain";
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

export class SqliteWorkspaceDatabase {
  readonly assets: SqliteAssetRepository;
  readonly jobs: SqliteJobRepository;
  readonly memory: SqliteMemoryRepository;

  constructor(readonly database: Database.Database) {
    this.assets = new SqliteAssetRepository(database);
    this.jobs = new SqliteJobRepository(database);
    this.memory = new SqliteMemoryRepository(database);
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
