import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AgentRun, Event, EventRevision, Source, SourceItem } from "@grudge-vault/domain";
import {
  DEFAULT_MIGRATIONS, SqliteAgentRepository, SqliteAssetRepository, SqliteJobRepository, SqliteMemoryRepository,
  SqlitePhaseSixRepository, openDatabase, runMigrations
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
      expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 24 });
      expect(database.prepare("SELECT count(*) AS count FROM pragma_module_list WHERE name = 'fts5'").get()).toEqual({ count: 1 });
      const sourceAssetColumns = database.prepare("PRAGMA table_info(redesign_record_assets)").all() as Array<{ name: string }>;
      expect(sourceAssetColumns.map(({ name }) => name)).toContain("source_id");
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

  it("sanitizes prior redesigned failure diagnostics while preserving legacy jobs", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 23));
    const privateMarker = "private-diary-path-in-old-error";
    const timestamp = "2026-09-27T00:00:00.000Z";
    database.prepare(`
      INSERT INTO redesign_search_generations
        (id, adapter_identity, adapter_version, dimensions, input_modalities_json,
         state, fragment_count, last_error, created_at)
      VALUES ('old-index', 'test', 1, 2, '["text"]', 'failed', 0, ?, ?)
    `).run(privateMarker, timestamp);
    const insertJob = database.prepare(`
      INSERT INTO jobs(id, type, payload_json, state, progress, attempts, max_attempts,
        available_at, last_error, created_at, updated_at)
      VALUES (?, ?, '{}', 'failed', 0, 1, 1, ?, ?, ?, ?)
    `);
    insertJob.run("new-job", "record.analyze", timestamp, privateMarker, timestamp, timestamp);
    insertJob.run("old-job", "dayone.import", timestamp, "legacy diagnostic", timestamp, timestamp);
    const insertAttempt = database.prepare(`
      INSERT INTO job_attempts(job_id, attempt_number, started_at, finished_at, outcome, error)
      VALUES (?, 1, ?, ?, 'failed', ?)
    `);
    insertAttempt.run("new-job", timestamp, timestamp, privateMarker);
    insertAttempt.run("old-job", timestamp, timestamp, "legacy diagnostic");

    runMigrations(database);
    expect(database.prepare("SELECT last_error FROM redesign_search_generations WHERE id = 'old-index'").pluck().get())
      .toBe("INTERNAL_ERROR");
    expect(database.prepare("SELECT id, last_error FROM jobs ORDER BY id").all()).toEqual([
      { id: "new-job", last_error: "INTERNAL_ERROR" },
      { id: "old-job", last_error: "legacy diagnostic" }
    ]);
    expect(database.prepare("SELECT job_id, error FROM job_attempts ORDER BY job_id").all()).toEqual([
      { job_id: "new-job", error: "INTERNAL_ERROR" },
      { job_id: "old-job", error: "legacy diagnostic" }
    ]);
    database.close();
  });

  it("adds report clarifications without losing existing user overrides", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 22));
    const timestamp = "2026-09-27T00:00:00.000Z";
    database.prepare(`
      INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, created_at, updated_at)
      VALUES ('record-1', 'manual', '["rights"]', '旧记录', '旧摘要', 2,
        '{"kind":"unknown"}', ?, 'stale', ?, ?)
    `).run(timestamp, timestamp, timestamp);
    database.prepare(`
      INSERT INTO redesign_field_overrides(id, record_id, field_key, value_json, actor, revision, created_at, updated_at)
      VALUES ('override-1', 'record-1', 'location', '"上海办公室"', 'user', 2, ?, ?)
    `).run(timestamp, timestamp);

    runMigrations(database);
    expect(database.prepare("SELECT field_key, value_json FROM redesign_field_overrides WHERE record_id = 'record-1'").all())
      .toEqual([{ field_key: "location", value_json: '"上海办公室"' }]);
    database.prepare(`
      INSERT INTO redesign_field_overrides(id, record_id, field_key, value_json, actor, revision, created_at, updated_at)
      VALUES ('override-2', 'record-1', 'clarifications', '[]', 'user', 3, ?, ?)
    `).run(timestamp, timestamp);
    expect(database.prepare("SELECT count(*) AS count FROM redesign_field_overrides WHERE record_id = 'record-1'").get())
      .toEqual({ count: 2 });
    database.close();
  });

  it("restores unresolved source-review flags when upgrading an existing redesigned workspace", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 19));
    const timestamp = "2026-09-24T00:00:00.000Z";
    const insertRecord = database.prepare(`
      INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, source_updated, created_at, updated_at)
      VALUES (?, 'zip', '["rights"]', '合成记录', '旧报告', ?, '{"kind":"unknown"}', ?, 'complete', 0, ?, ?)
    `);
    insertRecord.run("unretained", 2, timestamp, timestamp, timestamp);
    insertRecord.run("later-retained", 3, timestamp, timestamp, timestamp);
    const insertRevision = database.prepare(`
      INSERT INTO redesign_record_revisions(id, record_id, revision, snapshot_json, actor, reason, created_at)
      VALUES (?, ?, ?, '{}', 'source', ?, ?)
    `);
    insertRevision.run("unretained:2", "unretained", 2, "来源出现未收录的新版本", timestamp);
    insertRevision.run("later-retained:2", "later-retained", 2, "来源出现未收录的新版本", timestamp);
    insertRevision.run("later-retained:3", "later-retained", 3, "来源版本更新并重新收录", timestamp);

    runMigrations(database);
    expect(database.prepare(`
      SELECT id, source_updated, source_review_required FROM redesign_records ORDER BY id
    `).all()).toEqual([
      { id: "later-retained", source_updated: 0, source_review_required: 0 },
      { id: "unretained", source_updated: 1, source_review_required: 1 }
    ]);
    runMigrations(database);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 24 });
    database.close();
  });

  it("upgrades a Phase 0 database without changing the original migration", () => {
    const database = new Database(":memory:");
    runMigrations(database, [DEFAULT_MIGRATIONS[0]!]);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    runMigrations(database);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 24 });
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
        'agent_model_settings', 'agent_credentials', 'agent_model_calls',
        'llm_settings', 'llm_provider_settings', 'llm_provider_credentials'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "agent_actions", "agent_credentials", "agent_model_calls", "agent_model_settings",
      "agent_runs", "agent_tool_calls", "external_context_disclosures", "llm_provider_credentials",
      "llm_provider_settings", "llm_settings"
    ]);
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 24 });
    database.close();
  });

  it("adds the optional Bailian Workspace ID without changing existing model settings", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 8));
    database.prepare(`
      INSERT INTO llm_provider_settings(provider, model, region, status, last_tested_at, updated_at)
      VALUES ('bailian', 'qwen-existing', 'cn-beijing', 'needs_attention', NULL, '2026-08-30T00:00:00.000Z')
    `).run();
    runMigrations(database);
    const columns = database.prepare("PRAGMA table_info(llm_provider_settings)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("workspace_id");
    const repository = new SqliteAgentRepository(database);
    expect(repository.getLlmProviderConfig("bailian")).toMatchObject({
      model: "qwen-existing", region: "cn-beijing", status: "needs_attention"
    });
    expect(repository.getLlmProviderConfig("bailian")).not.toHaveProperty("workspaceId");
    repository.saveLlmProviderConfig({
      provider: "bailian", model: "qwen-updated", region: "cn-beijing", workspaceId: "ws-123",
      credentialConfigured: false, status: "not_configured"
    }, "2026-08-30T01:00:00.000Z");
    expect(repository.getLlmProviderConfig("bailian")?.workspaceId).toBe("ws-123");
    database.close();
  });

  it("expands the provider constraints for MiniMax without changing existing settings", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 9));
    database.prepare(`
      INSERT INTO llm_provider_settings(provider, model, region, workspace_id, status, last_tested_at, updated_at)
      VALUES ('openrouter', 'existing-model', NULL, NULL, 'ready', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO llm_settings(singleton, active_provider, updated_at)
      VALUES (1, 'openrouter', '2026-09-01T00:00:00.000Z')
    `).run();
    runMigrations(database);

    const repository = new SqliteAgentRepository(database);
    expect(repository.getLlmSettings()).toMatchObject({
      activeProvider: "openrouter", providers: { openrouter: { model: "existing-model", status: "ready" } }
    });
    repository.saveLlmProviderConfig({
      provider: "minimax", model: "MiniMax-M3", credentialConfigured: false, status: "not_configured",
      capabilities: {
        inputModalities: ["text", "image"], outputModalities: ["text"], structuredOutput: true,
        verifiedTasks: ["connection", "structured_output", "screening"],
        lastVerifiedAt: "2026-09-19T00:00:00.000Z"
      }
    }, "2026-09-19T00:00:00.000Z");
    repository.saveLlmSettings({ providers: {}, activeProvider: "minimax" }, "2026-09-19T00:00:00.000Z");
    expect(repository.getLlmSettings()).toMatchObject({
      activeProvider: "minimax", providers: { minimax: {
        model: "MiniMax-M3", status: "not_configured",
        capabilities: {
          inputModalities: ["text", "image"], outputModalities: ["text"], structuredOutput: true,
          verifiedTasks: ["connection", "structured_output", "screening"]
        }
      } }
    });
    database.close();
  });

  it("marks pre-normalization search generations for an explicit rebuild", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 16));
    database.prepare(`
      INSERT INTO redesign_search_generations(
        id, adapter_identity, adapter_version, dimensions, input_modalities_json,
        state, fragment_count, created_at
      ) VALUES ('old-generation', 'bailian:qwen3-vl-embedding:dimension-1024', 1, 1024, '["text","image"]',
        'active', 0, '2026-09-19T00:00:00.000Z')
    `).run();
    runMigrations(database);
    expect(database.prepare(
      "SELECT normalization FROM redesign_search_generations WHERE id = 'old-generation'"
    ).get()).toEqual({ normalization: "none" });
    database.close();
  });

  it("upgrades existing record attachments to source-revision associations", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 17));
    database.prepare(`
      INSERT INTO redesign_records(
        id, origin, categories_json, title, summary, revision, occurred_at_json, recorded_at,
        report_state, source_updated, created_at, updated_at
      ) VALUES ('record-upgrade', 'manual', '["rights"]', '旧记录', '旧摘要', 1,
        '{"kind":"unknown","prompt":"待补充"}', '2026-09-01T00:00:00.000Z',
        'queued', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO redesign_sources(
        id, record_id, origin, source_version, content_hash, text, recorded_at, created_at
      ) VALUES ('source-upgrade', 'record-upgrade', 'manual', 'source-v1', ?, '原文',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `).run("a".repeat(64));
    database.prepare(`
      INSERT INTO assets(
        id, sha256, byte_size, mime_type, original_file_name, vault_format, integrity_status,
        verified_at, availability_status, superseded_by_asset_id, deleted_at, created_at
      ) VALUES ('asset-upgrade', ?, 8, 'image/png', 'old.png', 2, 'verified',
        '2026-09-01T00:00:00.000Z', 'available', NULL, NULL, '2026-09-01T00:00:00.000Z')
    `).run("b".repeat(64));
    database.prepare(
      "INSERT INTO redesign_record_assets(record_id, asset_id) VALUES ('record-upgrade', 'asset-upgrade')"
    ).run();

    runMigrations(database);
    expect(database.prepare(
      "SELECT record_id, source_id, asset_id FROM redesign_record_assets"
    ).get()).toEqual({ record_id: "record-upgrade", source_id: "source-upgrade", asset_id: "asset-upgrade" });
    database.close();
  });

  it("deduplicates pre-idempotency reports before adding the unique key", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 18));
    database.prepare(`
      INSERT INTO redesign_records(
        id, origin, categories_json, title, summary, revision, occurred_at_json, recorded_at,
        report_state, source_updated, created_at, updated_at
      ) VALUES ('record-report-upgrade', 'manual', '["rights"]', '旧记录', '旧摘要', 1,
        '{"kind":"unknown","prompt":"待补充"}', '2026-09-01T00:00:00.000Z',
        'complete', 0, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `).run();
    const insert = database.prepare(`
      INSERT INTO redesign_reports(
        id, record_id, record_revision, input_hash, prompt_version, model_profile,
        content_json, state, error_code, created_at, updated_at
      ) VALUES (?, 'record-report-upgrade', 1, ?, 'report-v1', 'test:model',
        '{"summary":"报告"}', 'complete', NULL, ?, ?)
    `);
    insert.run("report-old", "c".repeat(64), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    insert.run("report-new", "c".repeat(64), "2026-09-01T00:01:00.000Z", "2026-09-01T00:01:00.000Z");

    runMigrations(database);
    expect(database.prepare("SELECT id FROM redesign_reports").all()).toEqual([{ id: "report-new" }]);
    expect(() => insert.run(
      "report-duplicate", "c".repeat(64), "2026-09-01T00:02:00.000Z", "2026-09-01T00:02:00.000Z"
    )).toThrow(/UNIQUE/);
    const insertRun = database.prepare(`
      INSERT INTO redesign_reports(
        id, record_id, record_revision, input_hash, prompt_version, model_profile,
        content_json, state, created_at, updated_at, analysis_run_id
      ) VALUES (?, 'record-report-upgrade', 1, ?, 'report-v1', 'test:model',
        '{"summary":"重跑报告"}', 'complete', '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z', ?)
    `);
    insertRun.run("report-rerun", "c".repeat(64), "job-rerun");
    expect(database.prepare("SELECT id, analysis_run_id FROM redesign_reports ORDER BY rowid").all())
      .toEqual([{ id: "report-new", analysis_run_id: null }, { id: "report-rerun", analysis_run_id: "job-rerun" }]);
    expect(() => insertRun.run("report-duplicate-run", "c".repeat(64), "job-rerun")).toThrow(/UNIQUE/);
    database.close();
  });

  it("upgrades a Phase 5 database with Phase 6 derived projections, import dedupe, automation, and reminders", () => {
    const database = new Database(":memory:");
    runMigrations(database, DEFAULT_MIGRATIONS.slice(0, 6));
    runMigrations(database);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'current_derived_artifacts', 'import_folder_entries', 'automation_runs', 'reminders'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "automation_runs", "current_derived_artifacts", "import_folder_entries", "reminders"
    ]);
    const columns = database.prepare("PRAGMA table_info(source_search_documents)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining(["derived_artifact_id", "source_asset_id"]));
    database.close();
  });

  it("retains derived history while searching only the current artifact and deduplicates reminders", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    runMigrations(database);
    const memory = new SqliteMemoryRepository(database);
    const assets = new SqliteAssetRepository(database);
    const phase6 = new SqlitePhaseSixRepository(database, memory);
    const now = "2026-08-25T00:00:00.000Z";
    assets.upsert({ id: "asset-ocr", sha256: "a".repeat(64), byteSize: 1, mimeType: "image/png", originalFileName: "note.png",
      vaultFormat: 2, integrityStatus: "verified", availabilityStatus: "available", createdAt: now });
    const activate = (id: string, inputHash: string, text: string) => phase6.activateDerivedArtifact({
      id, sourceAssetId: "asset-ocr", kind: "ocr", sha256: inputHash, byteSize: text.length,
      mimeType: "application/vnd.grudge-vault.media+json", processorIdentity: "fake-ocr", processorVersion: 1,
      configHash: inputHash, inputHash, current: false, createdAt: now
    }, { kind: "ocr", id: "derived:asset-ocr:ocr", title: "note.png · OCR", content: text,
      contentHash: inputHash, derivedArtifactId: id, sourceAssetId: "asset-ocr", sourceRefs: [] }, now);
    activate("artifact-1", "1".repeat(64), "first version phrase");
    activate("artifact-2", "2".repeat(64), "second current phrase");
    expect(phase6.getDerivedArtifact("artifact-1")?.current).toBe(false);
    expect(phase6.getCurrentDerivedArtifact("asset-ocr", "ocr")?.id).toBe("artifact-2");
    expect(memory.searchUnifiedKeyword({ text: "second current phrase" })[0]).toMatchObject({
      kind: "ocr", derivedArtifactId: "artifact-2", sourceAssetId: "asset-ocr"
    });
    expect(memory.searchUnifiedKeyword({ text: "first version phrase" })).toHaveLength(0);

    const reminder = { id: "reminder-1", kind: "monthly_review" as const, scheduleKey: "review:month:2026-07",
      status: "unread" as const, dueAt: now, reviewId: "review-1", clarificationIds: [], createdAt: now, updatedAt: now };
    phase6.saveAutomationRun({ scheduleKey: reminder.scheduleKey, kind: reminder.kind, reviewId: reminder.reviewId, createdAt: now });
    phase6.saveReminder(reminder);
    phase6.saveReminder({ ...reminder, id: "reminder-2" });
    expect(phase6.listReminders()).toHaveLength(1);
    expect(phase6.updateReminderStatus("reminder-1", "read", now).status).toBe("read");
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

  it("preserves conversation and run insertion order at identical timestamps, including updates to older runs", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON"); runMigrations(database);
      const memory = new SqliteMemoryRepository(database), agents = new SqliteAgentRepository(database);
      const now = "2026-08-24T00:00:00.000Z";
      memory.createConversation({ id: "conversation-1", sourceId: "source-1", title: "Order", createdAt: now, updatedAt: now },
        { id: "source-1", kind: "chat", name: "Order", createdAt: now });
      const messageIds = ["message-z", "message-y", "message-a", "message-b"];
      messageIds.forEach((id, index) => memory.appendMessage({
        id, conversationId: "conversation-1", sourceItemId: `item-${index}`, role: index % 2 ? "assistant" : "user",
        content: "synthetic", createdAt: now
      }, { id: `item-${index}`, sourceId: "", content: "synthetic", recordedAt: now, assetRefs: [] }));
      const runs: AgentRun[] = ["run-z", "run-a"].map((id, index) => ({
        id, conversationId: "conversation-1", userMessageId: messageIds[index * 2]!, assistantMessageId: messageIds[index * 2 + 1]!,
        intent: "review", mode: "private", status: "succeeded", toolSchemaVersion: 1,
        contextHash: "a".repeat(64), responseVersion: 1, citations: [], toolCalls: [], actions: [], createdAt: now, completedAt: now
      }));
      runs.forEach(run => agents.saveRun(run));
      expect(memory.listMessages("conversation-1").map(({ id }) => id)).toEqual(messageIds);
      expect(agents.listRuns("conversation-1").map(({ id }) => id)).toEqual(["run-z", "run-a"]);
      agents.saveRun({ ...runs[0]!, responseText: "older run updated" });
      expect(agents.listRuns("conversation-1").map(({ id }) => id)).toEqual(["run-z", "run-a"]);
    } finally { database.close(); }
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

  it("leaves queued and expired legacy jobs untouched when claiming only redesigned job types", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const oldRunning = jobs.enqueue("dayone.import", {}, "2026-01-01T00:00:00.000Z");
    jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    const oldQueued = jobs.enqueue("media.process", {}, "2026-01-01T00:00:00.000Z");
    const current = jobs.enqueue("record.analyze", {}, "2026-01-01T00:00:00.000Z");
    expect(jobs.claimNext("2026-01-01T00:00:31.000Z", "2026-01-01T00:01:01.000Z", [])).toBeUndefined();
    expect(jobs.claimNext("2026-01-01T00:00:31.000Z", "2026-01-01T00:01:01.000Z", ["record.analyze"])?.id)
      .toBe(current.id);
    expect(jobs.list().find(({ id }) => id === oldQueued.id)).toMatchObject({ state: "queued", attempts: 0 });
    expect(jobs.list().find(({ id }) => id === oldRunning.id)).toMatchObject({ state: "running", attempts: 1 });
    expect(database.prepare("SELECT outcome FROM job_attempts WHERE job_id = ?").get(oldRunning.id))
      .toEqual({ outcome: null });
    expect(jobs.claimNext("2026-01-01T00:00:31.000Z", "2026-01-01T00:01:01.000Z")?.id).toBe(oldRunning.id);
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
    expect(retried.maxAttempts).toBe(5);
    expect(jobs.claimNext("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:32.000Z")?.attempts).toBe(2);
    database.close();
  });

  it("persists queued and running job cancellation and abandons the active attempt", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("media.process", { assetId: "asset-1" }, "2026-01-01T00:00:00.000Z");
    expect(jobs.cancel(queued.id, "2026-01-01T00:00:01.000Z").state).toBe("cancelled");
    const running = jobs.enqueue("media.process", { assetId: "asset-2" }, "2026-01-01T00:00:02.000Z");
    jobs.claimNext("2026-01-01T00:00:02.000Z", "2026-01-01T00:00:32.000Z");
    expect(jobs.cancel(running.id, "2026-01-01T00:00:03.000Z").state).toBe("cancelled");
    expect(database.prepare("SELECT outcome FROM job_attempts WHERE job_id = ?").get(running.id)).toEqual({ outcome: "abandoned" });
    expect(() => jobs.cancel(running.id, "2026-01-01T00:00:04.000Z")).toThrowError(/queued or running/);
    database.close();
  });

  it("requeues an interrupted job without consuming its final processing attempt", () => {
    const database = new Database(":memory:");
    runMigrations(database);
    const jobs = new SqliteJobRepository(database);
    const queued = jobs.enqueue("media.process", { assetId: "asset-1" }, "2026-01-01T00:00:00.000Z", 1);
    jobs.claimNext("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:30.000Z");
    expect(jobs.interrupt(queued.id, "Workspace locked", "2026-01-01T00:00:01.000Z")).toMatchObject({
      state: "queued", attempts: 1, maxAttempts: 2
    });
    expect(jobs.claimNext("2026-01-01T00:00:01.000Z", "2026-01-01T00:00:31.000Z")).toMatchObject({ attempts: 2 });
    expect(database.prepare("SELECT outcome FROM job_attempts WHERE job_id = ? AND attempt_number = 1").get(queued.id))
      .toEqual({ outcome: "abandoned" });
    database.close();
  });
});
