import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AgentRun, Event, EventRevision, Source, SourceItem } from "@grudge-vault/domain";
import {
  DEFAULT_MIGRATIONS, SqliteAgentRepository, SqliteJobRepository, SqliteMemoryRepository, openDatabase, runMigrations
} from "./index";

function sampleEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "event-1", title: "Project attribution dispute", status: "candidate",
    occurredAt: { kind: "month", value: "2026-08" },
    recordedAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
    narrative: "A project attribution dispute happened with Alex.",
    facts: [{ id: "fact-1", kind: "fact.confirmed", text: "The report omitted my name.", sourceRefs: ["item-1"] }],
    interpretations: [], emotions: [], interests: [], participants: [{ personId: "person-1" }],
    sourceRefs: ["item-1"], assetRefs: [],
    completeness: { missingFields: [], openClarificationCount: 0 }, currentRevision: 1,
    ...overrides
  };
}

function revisionFor(event: Event, previousRevision = 0): EventRevision {
  return {
    id: `revision-${event.currentRevision}`, eventId: event.id, revision: event.currentRevision,
    previousRevision, snapshot: event, actor: "user", reason: "test",
    sourceRefs: event.sourceRefs, createdAt: event.updatedAt
  };
}

describe("SQLite foundation", () => {
  it("applies migrations repeatedly and configures durable pragmas", async () => {
    const root = await mkdtemp(join(tmpdir(), "grudge-vault-db-"));
    try {
      const database = await openDatabase(join(root, "db", "test.sqlite3"));
      runMigrations(database);
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
      expect(database.prepare("SELECT count(*) AS count FROM pragma_module_list WHERE name = 'fts5'").get()).toEqual({ count: 1 });
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a changed migration checksum", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const changed = [{ ...DEFAULT_MIGRATIONS[0]!, sql: `${DEFAULT_MIGRATIONS[0]!.sql}\n-- changed` }];
    expect(() => runMigrations(database, changed)).toThrow(/checksum/);
    database.close();
  });

  it("upgrades a Phase 0 database without changing the original migration", () => {
    const database = new Database(":memory:");
    runMigrations(database, [DEFAULT_MIGRATIONS[0]!]);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    runMigrations(database);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toEqual({ name: "events" });
    database.close();
  });

  it("upgrades a Phase 1 database with all Phase 2 import and backfill tables", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 2));
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 2 });
    runMigrations(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'import_runs', 'import_issues', 'import_run_entries', 'source_versions',
        'journal_entries', 'source_version_assets', 'backfill_runs', 'candidate_extractions'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "backfill_runs", "candidate_extractions", "import_issues", "import_run_entries",
      "import_runs", "journal_entries", "source_version_assets", "source_versions"
    ]);
    database.close();
  });

  it("upgrades a Phase 2 database with reversible identity, relation, search, and review storage", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 3));
    runMigrations(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN (
        'person_aliases', 'person_merge_suggestions', 'person_merge_records', 'event_relations',
        'source_search_documents', 'fts_sources', 'workspace_settings', 'embedding_generations',
        'embeddings', 'analysis_runs'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "analysis_runs", "embedding_generations", "embeddings", "event_relations", "fts_sources",
      "person_aliases", "person_merge_records", "person_merge_suggestions", "source_search_documents",
      "workspace_settings"
    ]);
    database.close();
  });

  it("upgrades a Phase 3 database with Agent runs, actions, settings, credentials, and external-call audits", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 4));
    runMigrations(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'agent_runs', 'agent_tool_calls', 'agent_actions', 'external_context_disclosures',
        'agent_model_settings', 'agent_credentials', 'agent_model_calls'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "agent_actions", "agent_credentials", "agent_model_calls", "agent_model_settings",
      "agent_runs", "agent_tool_calls", "external_context_disclosures"
    ]);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
    database.close();
  });

  it("round-trips structured Agent state without storing model prompts or source bodies in audit rows", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const agents = new SqliteAgentRepository(database);
    const now = "2026-08-24T00:00:00.000Z";
    memory.createConversation({
      id: "conversation-1", sourceId: "source-1", title: "Inbox", createdAt: now, updatedAt: now
    }, { id: "source-1", kind: "chat", name: "Inbox", createdAt: now });
    memory.appendMessage({
      id: "message-1", conversationId: "conversation-1", sourceItemId: "source-item-1",
      role: "user", content: "private prompt body", createdAt: now
    }, { id: "source-item-1", sourceId: "", content: "private prompt body", recordedAt: now, assetRefs: [] });
    const run: AgentRun = {
      id: "run-1", conversationId: "conversation-1", userMessageId: "message-1", intent: "record",
      mode: "enhanced", status: "awaiting_consent", modelIdentity: "fake", modelVersion: 1,
      toolSchemaVersion: 1, contextHash: "a".repeat(64), responseVersion: 1,
      citations: [{ id: "citation-1", kind: "source", targetId: "source-item-1", label: "Message", available: true }],
      toolCalls: [{
        id: "call-1", runId: "run-1", sequence: 0, toolName: "propose_event", toolVersion: 1,
        inputHash: "b".repeat(64), inputRefs: ["source-item-1"], outputRefs: [], status: "proposed", startedAt: now
      }],
      actions: [{
        id: "action-1", runId: "run-1", toolCallId: "call-1", toolName: "propose_event", toolVersion: 1,
        summary: "Create candidate", payload: { title: "Candidate" }, status: "pending", resultRefs: [], createdAt: now
      }],
      disclosure: {
        id: "disclosure-1", runId: "run-1", policyVersion: 1, categories: ["conversation_text"],
        categoryCounts: { conversation_text: 1 }, contextHash: "a".repeat(64), required: true, createdAt: now
      }, createdAt: now
    };
    agents.saveRun(run);
    agents.saveModelCallAudit({
      id: "audit-1", runId: run.id, sequence: 0, endpointOrigin: "https://model.example", model: "fake",
      categories: ["conversation_text"], contextHash: run.contextHash, status: "failed",
      errorCode: "AGENT_MODEL_UNAVAILABLE", startedAt: now, finishedAt: now
    });
    agents.saveSettings({
      mode: "enhanced", enhancedEndpoint: {
        baseUrl: "https://model.example/v1", model: "fake", credentialConfigured: true
      }, consentPolicyVersion: 1, consentedDataCategories: ["conversation_text"]
    }, now);
    agents.saveCredential("enhanced", {
      algorithm: "aes-256-gcm", version: 1, iv: "iv", authTag: "tag", ciphertext: "encrypted"
    }, now);

    expect(agents.getRun(run.id)).toEqual(run);
    expect(agents.listModelCallAudits(run.id)[0]).toMatchObject({
      endpointOrigin: "https://model.example", status: "failed", errorCode: "AGENT_MODEL_UNAVAILABLE"
    });
    expect(agents.getSettings()?.consentedDataCategories).toEqual(["conversation_text"]);
    expect(agents.getCredential("enhanced")?.ciphertext).toBe("encrypted");
    const auditColumns = database.prepare("PRAGMA table_info(agent_model_calls)").all() as Array<{ name: string }>;
    expect(auditColumns.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["prompt", "body", "source_text"]));
    database.close();
  });

  it("commits event projections, revisions, links, and FTS atomically", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const source: Source = { id: "source-1", kind: "chat", name: "Inbox", createdAt: "2026-08-24T00:00:00.000Z" };
    memory.createConversation({
      id: "conversation-1", sourceId: source.id, title: "Inbox",
      createdAt: source.createdAt, updatedAt: source.createdAt
    }, source);
    const sourceItem: SourceItem = {
      id: "item-1", sourceId: "", content: "raw message", recordedAt: source.createdAt, assetRefs: []
    };
    memory.appendMessage({
      id: "message-1", conversationId: "conversation-1", sourceItemId: sourceItem.id,
      role: "user", content: "raw message", createdAt: source.createdAt
    }, sourceItem);
    memory.createPerson({
      id: "person-1", displayName: "Alex", status: "active",
      createdAt: source.createdAt, updatedAt: source.createdAt
    });
    const event = sampleEvent();
    memory.commitEvent(event, revisionFor(event));

    expect(memory.searchEvents({ text: "attribution" }).map(({ id }) => id)).toEqual([event.id]);
    expect(memory.searchEvents({ personId: "person-1", status: "candidate", from: "2026-08-01", to: "2026-08-31" })).toHaveLength(1);
    expect(memory.getEventDetail(event.id)?.people[0]?.displayName).toBe("Alex");
    expect(memory.listEventRevisions(event.id)).toHaveLength(1);

    const updated = { ...event, title: "Updated attribution dispute", currentRevision: 2, updatedAt: "2026-08-24T01:00:00.000Z" };
    memory.commitEvent(updated, revisionFor(updated, 1));
    expect(memory.getEvent(event.id)?.title).toBe(updated.title);
    expect(memory.listEventRevisions(event.id)).toHaveLength(2);
    expect(() => memory.commitEvent(updated, revisionFor(updated, 1))).toThrow(/changed/);
    database.close();
  });

  it("tombstones deleted conversation text while preserving source identities", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const now = "2026-08-24T00:00:00.000Z";
    memory.createConversation({ id: "conversation-1", sourceId: "source-1", title: "Sensitive", createdAt: now, updatedAt: now },
      { id: "source-1", kind: "chat", name: "Sensitive", createdAt: now });
    memory.appendMessage({
      id: "message-1", conversationId: "conversation-1", sourceItemId: "item-1",
      role: "user", content: "private text", createdAt: now
    }, { id: "item-1", sourceId: "", content: "private text", recordedAt: now, assetRefs: [] });
    const deleted = memory.deleteConversation("conversation-1", "2026-08-24T01:00:00.000Z");
    expect(deleted.deletedAt).toBeDefined();
    expect(memory.listConversations()).toEqual([]);
    expect(memory.listMessages("conversation-1")[0]?.content).toBeUndefined();
    expect(database.prepare("SELECT id, content, deleted_at FROM source_items WHERE id = 'item-1'").get()).toEqual({
      id: "item-1", content: null, deleted_at: "2026-08-24T01:00:00.000Z"
    });
    database.close();
  });

  it("recovers expired leases and preserves attempt history", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("asset.verify", { assetId: "asset-1" }, "2026-01-01T00:00:00.000Z");
    const first = jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    expect(first?.id).toBe(queued.id);
    expect(first?.attempts).toBe(1);

    const recovered = jobs.claimNext("2026-01-01T00:00:31.000Z", "2026-01-01T00:01:01.000Z");
    expect(recovered?.attempts).toBe(2);
    const attempts = database.prepare("SELECT outcome FROM job_attempts ORDER BY attempt_number").all();
    expect(attempts).toEqual([{ outcome: "abandoned" }, { outcome: null }]);
    database.close();
  });

  it("allows a failed job to start a new manual retry cycle without reusing attempt numbers", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("asset.verify", {}, "2026-01-01T00:00:00.000Z", 1);
    jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    jobs.fail(queued.id, "failed", "2026-01-01T00:00:01.000Z");
    const retried = jobs.retry(queued.id, "2026-01-01T00:00:02.000Z");
    expect(retried.attempts).toBe(1);
    expect(retried.maxAttempts).toBe(4);
    expect(jobs.claimNext("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:32.000Z")?.attempts).toBe(2);
    database.close();
  });
});
