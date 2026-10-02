import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  AgentCredentialEnvelope, AgentRepositoryPort, AssetRepositoryPort, DayOneRepositoryPort, EventCommitExtras,
  JobRepositoryPort, MemoryRepositoryPort, NormalizedDayOneEntry, VaultKey
} from "@grudge-vault/application";
import type {
  AgentAction, AgentExecutionMode, AgentModelCallAudit, AgentModelSettings, AgentRun, AgentToolCall, Asset, BackfillRun,
  CandidateDetail, CandidateExtraction, CandidateSummary, Clarification,
  Conversation, EmbeddingGeneration, Event, EventDetail, EventRelation, EventRevision, EventSearchQuery,
  ImportIssue, ImportRun, ImportRunDetail, Job, JobState, JournalEntry, LlmProvider, LlmProviderConfig, LlmSettings, Message, Person, PersonAlias,
  PersonMergeRecord, PersonMergeSuggestion, ReviewRun, SearchDocument, Source, SourceItem,
  SourceReferenceDetail, SourceVersion, UnifiedSearchHit, UnifiedSearchQuery, Workspace
} from "@grudge-vault/domain";
import { AppError, type CandidateMergeInput, type CandidateMergeResult } from "@grudge-vault/shared";
import { SqlitePhaseFiveRepository } from "./phase5";
import { SqlitePhaseSixRepository } from "./phase6";

export { SqlitePhaseFiveRepository } from "./phase5";
export { SqlitePhaseSixRepository } from "./phase6";
export { SqliteRecordRepository } from "./redesign";
import { SqliteRecordRepository } from "./redesign";

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
  },
  {
    version: 4,
    name: "phase-three-relations-search-review",
    sql: `
      CREATE TABLE person_aliases (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id),
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'inactive')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX person_aliases_active_value_idx
        ON person_aliases(person_id, normalized_value) WHERE status = 'active';

      CREATE TABLE person_merge_suggestions (
        id TEXT PRIMARY KEY,
        person_a_id TEXT NOT NULL REFERENCES people(id),
        person_b_id TEXT NOT NULL REFERENCES people(id),
        score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
        basis_json TEXT NOT NULL,
        algorithm_identity TEXT NOT NULL,
        algorithm_version INTEGER NOT NULL CHECK(algorithm_version > 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'rejected')),
        merge_record_id TEXT REFERENCES person_merge_records(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(person_a_id, person_b_id, algorithm_identity, algorithm_version)
      ) STRICT;

      CREATE TABLE person_merge_records (
        id TEXT PRIMARY KEY,
        source_person_id TEXT NOT NULL REFERENCES people(id),
        target_person_id TEXT NOT NULL REFERENCES people(id),
        suggestion_id TEXT REFERENCES person_merge_suggestions(id),
        status TEXT NOT NULL CHECK(status IN ('active', 'reverted')),
        created_at TEXT NOT NULL,
        reverted_at TEXT,
        CHECK(source_person_id <> target_person_id)
      ) STRICT;
      CREATE UNIQUE INDEX person_merge_active_source_idx
        ON person_merge_records(source_person_id) WHERE status = 'active';

      CREATE TABLE event_relations (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL REFERENCES events(id),
        target_event_id TEXT NOT NULL REFERENCES events(id),
        kind TEXT NOT NULL CHECK(kind IN ('similar', 'precedes', 'same_topic', 'same_case')),
        status TEXT NOT NULL CHECK(status IN ('suggested', 'confirmed', 'rejected')),
        origin TEXT NOT NULL CHECK(origin IN ('algorithm', 'user')),
        score REAL CHECK(score IS NULL OR (score >= 0 AND score <= 1)),
        basis_json TEXT NOT NULL,
        algorithm_identity TEXT,
        algorithm_version INTEGER,
        source_revision INTEGER NOT NULL CHECK(source_revision > 0),
        target_revision INTEGER NOT NULL CHECK(target_revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(source_event_id <> target_event_id),
        UNIQUE(source_event_id, target_event_id, kind)
      ) STRICT;
      CREATE INDEX event_relations_event_idx ON event_relations(source_event_id, target_event_id, status);

      CREATE TABLE source_search_documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('journal_entry', 'transcript')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        occurred_at TEXT,
        event_id TEXT REFERENCES events(id),
        source_item_id TEXT REFERENCES source_items(id),
        source_refs_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX source_search_documents_source_idx ON source_search_documents(source_item_id, kind);
      CREATE VIRTUAL TABLE fts_sources USING fts5(
        document_id UNINDEXED,
        title,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE workspace_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE embedding_generations (
        id TEXT PRIMARY KEY,
        adapter_identity TEXT NOT NULL,
        adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        state TEXT NOT NULL CHECK(state IN ('building', 'active', 'superseded', 'failed')),
        document_count INTEGER NOT NULL CHECK(document_count >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT
      ) STRICT;
      CREATE INDEX embedding_generations_state_idx ON embedding_generations(state, created_at);

      CREATE TABLE embeddings (
        generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
        document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'journal_entry', 'transcript')),
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        vector BLOB NOT NULL,
        PRIMARY KEY(generation_id, document_kind, document_id)
      ) STRICT;

      CREATE TABLE analysis_runs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        processor_identity TEXT NOT NULL,
        processor_version INTEGER NOT NULL CHECK(processor_version > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX analysis_runs_type_date_idx ON analysis_runs(type, created_at);

      INSERT INTO source_search_documents(
        id, kind, title, content, content_hash, occurred_at, event_id, source_item_id, source_refs_json, updated_at
      )
      SELECT 'journal:' || je.source_item_id, 'journal_entry',
        CASE WHEN length(COALESCE(sv.content, '')) > 80 THEN substr(COALESCE(sv.content, ''), 1, 80) ELSE COALESCE(sv.content, 'Day One entry') END,
        COALESCE(sv.content, ''), sv.content_hash, je.journal_date, NULL, je.source_item_id,
        json_array(je.source_item_id), sv.created_at
      FROM journal_entries je JOIN source_versions sv ON sv.id = je.current_version_id;

      INSERT INTO fts_sources(document_id, title, content)
      SELECT id, title, content FROM source_search_documents;
    `
  },
  {
    version: 5,
    name: "phase-four-agent-harness",
    sql: `
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        user_message_id TEXT NOT NULL REFERENCES messages(id),
        assistant_message_id TEXT REFERENCES messages(id),
        intent TEXT NOT NULL CHECK(intent IN ('record', 'retrieve', 'review', 'clarify', 'strategy')),
        mode TEXT NOT NULL CHECK(mode IN ('private', 'enhanced')),
        status TEXT NOT NULL CHECK(status IN ('awaiting_consent', 'running', 'succeeded', 'failed', 'cancelled')),
        model_identity TEXT,
        model_version INTEGER CHECK(model_version IS NULL OR model_version > 0),
        tool_schema_version INTEGER NOT NULL CHECK(tool_schema_version > 0),
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        response_version INTEGER NOT NULL CHECK(response_version > 0),
        response_text TEXT,
        analysis_json TEXT,
        citations_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX agent_runs_conversation_idx ON agent_runs(conversation_id, created_at);

      CREATE TABLE agent_tool_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        tool_name TEXT NOT NULL,
        tool_version INTEGER NOT NULL CHECK(tool_version > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        input_refs_json TEXT NOT NULL,
        output_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'proposed')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, sequence)
      ) STRICT;

      CREATE TABLE agent_actions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls(id),
        tool_name TEXT NOT NULL,
        tool_version INTEGER NOT NULL CHECK(tool_version > 0),
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expected_revision INTEGER CHECK(expected_revision IS NULL OR expected_revision > 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'stale', 'failed')),
        result_refs_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE INDEX agent_actions_status_idx ON agent_actions(status, created_at);

      CREATE TABLE external_context_disclosures (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
        policy_version INTEGER NOT NULL CHECK(policy_version > 0),
        categories_json TEXT NOT NULL,
        category_counts_json TEXT NOT NULL,
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        required INTEGER NOT NULL CHECK(required IN (0, 1)),
        accepted_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE agent_model_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        mode TEXT NOT NULL CHECK(mode IN ('private', 'enhanced')),
        private_endpoint_json TEXT,
        enhanced_endpoint_json TEXT,
        consent_policy_version INTEGER NOT NULL CHECK(consent_policy_version > 0),
        consented_categories_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE agent_credentials (
        mode TEXT PRIMARY KEY CHECK(mode IN ('private', 'enhanced')),
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE agent_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        endpoint_origin TEXT NOT NULL,
        model TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
        prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens >= 0),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, sequence)
      ) STRICT;
    `
  },
  {
    version: 6,
    name: "phase-five-evidence-cases-security",
    sql: `
      CREATE TABLE agent_runs_phase5 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        user_message_id TEXT NOT NULL REFERENCES messages(id),
        assistant_message_id TEXT REFERENCES messages(id),
        intent TEXT NOT NULL CHECK(intent IN ('record', 'retrieve', 'review', 'clarify', 'strategy', 'evidence')),
        mode TEXT NOT NULL CHECK(mode IN ('private', 'enhanced')),
        status TEXT NOT NULL CHECK(status IN ('awaiting_consent', 'running', 'succeeded', 'failed', 'cancelled')),
        model_identity TEXT,
        model_version INTEGER CHECK(model_version IS NULL OR model_version > 0),
        tool_schema_version INTEGER NOT NULL CHECK(tool_schema_version > 0),
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        response_version INTEGER NOT NULL CHECK(response_version > 0),
        response_text TEXT,
        analysis_json TEXT,
        citations_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE TABLE agent_tool_calls_phase5 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs_phase5(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        tool_name TEXT NOT NULL,
        tool_version INTEGER NOT NULL CHECK(tool_version > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        input_refs_json TEXT NOT NULL,
        output_refs_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'proposed')),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, sequence)
      ) STRICT;
      CREATE TABLE agent_actions_phase5 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs_phase5(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls_phase5(id),
        tool_name TEXT NOT NULL,
        tool_version INTEGER NOT NULL CHECK(tool_version > 0),
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expected_revision INTEGER CHECK(expected_revision IS NULL OR expected_revision > 0),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'stale', 'failed')),
        result_refs_json TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE TABLE external_context_disclosures_phase5 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs_phase5(id) ON DELETE CASCADE,
        policy_version INTEGER NOT NULL CHECK(policy_version > 0),
        categories_json TEXT NOT NULL,
        category_counts_json TEXT NOT NULL,
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        required INTEGER NOT NULL CHECK(required IN (0, 1)),
        accepted_at TEXT,
        rejected_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE agent_model_calls_phase5 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs_phase5(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence >= 0),
        endpoint_origin TEXT NOT NULL,
        model TEXT NOT NULL,
        categories_json TEXT NOT NULL,
        context_hash TEXT NOT NULL CHECK(length(context_hash) = 64),
        status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
        prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens >= 0),
        completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens >= 0),
        error_code TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE(run_id, sequence)
      ) STRICT;
      INSERT INTO agent_runs_phase5 SELECT * FROM agent_runs;
      INSERT INTO agent_tool_calls_phase5 SELECT * FROM agent_tool_calls;
      INSERT INTO agent_actions_phase5 SELECT * FROM agent_actions;
      INSERT INTO external_context_disclosures_phase5 SELECT * FROM external_context_disclosures;
      INSERT INTO agent_model_calls_phase5 SELECT * FROM agent_model_calls;
      DROP TABLE agent_actions;
      DROP TABLE external_context_disclosures;
      DROP TABLE agent_model_calls;
      DROP TABLE agent_tool_calls;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_phase5 RENAME TO agent_runs;
      ALTER TABLE agent_tool_calls_phase5 RENAME TO agent_tool_calls;
      ALTER TABLE agent_actions_phase5 RENAME TO agent_actions;
      ALTER TABLE external_context_disclosures_phase5 RENAME TO external_context_disclosures;
      ALTER TABLE agent_model_calls_phase5 RENAME TO agent_model_calls;
      CREATE INDEX agent_runs_conversation_idx ON agent_runs(conversation_id, created_at);
      CREATE INDEX agent_actions_status_idx ON agent_actions(status, created_at);

      ALTER TABLE assets ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'available'
        CHECK(availability_status IN ('available', 'missing', 'deleted', 'superseded'));
      ALTER TABLE assets ADD COLUMN superseded_by_asset_id TEXT REFERENCES assets(id);
      ALTER TABLE assets ADD COLUMN deleted_at TEXT;

      CREATE TABLE derived_artifacts (
        id TEXT PRIMARY KEY,
        source_asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK(kind IN ('ocr', 'transcript', 'key_frames', 'thumbnail', 'redacted_copy', 'other')),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        mime_type TEXT NOT NULL,
        processor_identity TEXT NOT NULL,
        processor_version INTEGER NOT NULL CHECK(processor_version > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX derived_artifacts_source_idx ON derived_artifacts(source_asset_id, created_at);

      CREATE TABLE cases (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'archived')),
        jurisdiction TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        projection_json TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK(current_revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX cases_status_idx ON cases(status, updated_at);

      CREATE TABLE case_revisions (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        revision INTEGER NOT NULL CHECK(revision > 0),
        previous_revision INTEGER NOT NULL CHECK(previous_revision >= 0),
        snapshot_json TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('user', 'agent')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(case_id, revision)
      ) STRICT;

      CREATE TABLE case_event_refs (
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES events(id),
        PRIMARY KEY(case_id, event_id)
      ) STRICT;
      CREATE TABLE case_person_refs (
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL REFERENCES people(id),
        PRIMARY KEY(case_id, person_id)
      ) STRICT;
      CREATE TABLE case_source_refs (
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        source_item_id TEXT NOT NULL REFERENCES source_items(id),
        PRIMARY KEY(case_id, source_item_id)
      ) STRICT;
      CREATE TABLE case_asset_refs (
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        PRIMARY KEY(case_id, asset_id)
      ) STRICT;
      CREATE TABLE case_evidence_links (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        event_id TEXT REFERENCES events(id),
        statement_ids_json TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        notes TEXT
      ) STRICT;
      CREATE INDEX case_evidence_links_case_idx ON case_evidence_links(case_id, asset_id);

      CREATE TABLE integrity_scans (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        cursor TEXT,
        counts_json TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
      CREATE TABLE integrity_scan_results (
        scan_id TEXT NOT NULL REFERENCES integrity_scans(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        result TEXT NOT NULL CHECK(result IN ('verified', 'corrupt', 'missing', 'skipped')),
        expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256) = 64),
        expected_byte_size INTEGER NOT NULL CHECK(expected_byte_size >= 0),
        verified_at TEXT NOT NULL,
        error TEXT,
        PRIMARY KEY(scan_id, asset_id)
      ) STRICT;

      CREATE TABLE crypto_migrations (
        id TEXT PRIMARY KEY,
        from_key_id TEXT NOT NULL,
        to_key_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed')),
        cursor TEXT,
        processed_objects INTEGER NOT NULL DEFAULT 0,
        total_objects INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE TABLE legal_verifications (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        case_revision INTEGER NOT NULL CHECK(case_revision > 0),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX legal_verifications_case_idx ON legal_verifications(case_id, created_at);

      CREATE TABLE binder_exports (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES cases(id),
        case_revision INTEGER NOT NULL CHECK(case_revision > 0),
        profile_json TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256) = 64),
        generated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX binder_exports_case_idx ON binder_exports(case_id, generated_at);
    `
  },
  {
    version: 7,
    name: "phase-six-local-intelligence",
    sql: `
      ALTER TABLE source_search_documents RENAME TO source_search_documents_phase5;
      CREATE TABLE source_search_documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('journal_entry', 'ocr', 'transcript')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        occurred_at TEXT,
        event_id TEXT REFERENCES events(id),
        source_item_id TEXT REFERENCES source_items(id),
        derived_artifact_id TEXT,
        source_asset_id TEXT REFERENCES assets(id),
        source_refs_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO source_search_documents(
        id,kind,title,content,content_hash,occurred_at,event_id,source_item_id,
        derived_artifact_id,source_asset_id,source_refs_json,updated_at
      ) SELECT id,kind,title,content,content_hash,occurred_at,event_id,source_item_id,
        NULL,NULL,source_refs_json,updated_at FROM source_search_documents_phase5;
      DROP TABLE source_search_documents_phase5;
      CREATE INDEX source_search_documents_source_idx ON source_search_documents(source_item_id, kind);
      CREATE INDEX source_search_documents_artifact_idx ON source_search_documents(derived_artifact_id, kind);

      ALTER TABLE embeddings RENAME TO embeddings_phase5;
      CREATE TABLE embeddings (
        generation_id TEXT NOT NULL REFERENCES embedding_generations(id) ON DELETE CASCADE,
        document_kind TEXT NOT NULL CHECK(document_kind IN ('event', 'journal_entry', 'ocr', 'transcript')),
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        vector BLOB NOT NULL,
        PRIMARY KEY(generation_id, document_kind, document_id)
      ) STRICT;
      INSERT INTO embeddings SELECT * FROM embeddings_phase5;
      DROP TABLE embeddings_phase5;

      ALTER TABLE derived_artifacts RENAME TO derived_artifacts_phase5;
      CREATE TABLE derived_artifacts (
        id TEXT PRIMARY KEY,
        source_asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK(kind IN ('ocr', 'transcript', 'key_frames', 'thumbnail', 'redacted_copy', 'other')),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        mime_type TEXT NOT NULL,
        processor_identity TEXT NOT NULL,
        processor_version INTEGER NOT NULL CHECK(processor_version > 0),
        config_hash TEXT NOT NULL CHECK(length(config_hash) = 64),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        created_at TEXT NOT NULL,
        UNIQUE(source_asset_id, kind, input_hash)
      ) STRICT;
      INSERT INTO derived_artifacts(
        id,source_asset_id,kind,sha256,byte_size,mime_type,processor_identity,
        processor_version,config_hash,input_hash,created_at
      ) SELECT id,source_asset_id,kind,sha256,byte_size,mime_type,processor_identity,
        processor_version,input_hash,input_hash,created_at FROM derived_artifacts_phase5;
      DROP TABLE derived_artifacts_phase5;
      CREATE INDEX derived_artifacts_source_idx ON derived_artifacts(source_asset_id, created_at);

      CREATE TABLE current_derived_artifacts (
        source_asset_id TEXT NOT NULL REFERENCES assets(id),
        kind TEXT NOT NULL CHECK(kind IN ('ocr', 'transcript')),
        artifact_id TEXT NOT NULL REFERENCES derived_artifacts(id),
        activated_at TEXT NOT NULL,
        PRIMARY KEY(source_asset_id, kind)
      ) STRICT;
      INSERT INTO current_derived_artifacts(source_asset_id,kind,artifact_id,activated_at)
      SELECT source_asset_id,kind,id,created_at FROM derived_artifacts candidate
      WHERE kind IN ('ocr','transcript') AND NOT EXISTS (
        SELECT 1 FROM derived_artifacts newer
        WHERE newer.source_asset_id = candidate.source_asset_id AND newer.kind = candidate.kind
          AND (newer.created_at > candidate.created_at OR (newer.created_at = candidate.created_at AND newer.id > candidate.id))
      );

      CREATE TABLE import_folder_entries (
        id TEXT PRIMARY KEY,
        archive_sha256 TEXT NOT NULL UNIQUE CHECK(length(archive_sha256) = 64),
        asset_id TEXT NOT NULL REFERENCES assets(id),
        import_run_id TEXT NOT NULL REFERENCES import_runs(id),
        file_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE automation_runs (
        schedule_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('monthly_review', 'quarterly_review', 'clarification_digest')),
        review_id TEXT,
        from_date TEXT,
        to_date TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('monthly_review', 'quarterly_review', 'clarification_digest')),
        schedule_key TEXT NOT NULL UNIQUE REFERENCES automation_runs(schedule_key),
        status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'dismissed')),
        due_at TEXT NOT NULL,
        review_id TEXT,
        clarification_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reminders_status_idx ON reminders(status, due_at);
    `
  },
  {
    version: 8,
    name: "llm-provider-services",
    sql: `
      CREATE TABLE llm_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        active_provider TEXT CHECK(active_provider IS NULL OR active_provider IN ('nvidia', 'openrouter', 'bailian')),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE llm_provider_settings (
        provider TEXT PRIMARY KEY CHECK(provider IN ('nvidia', 'openrouter', 'bailian')),
        model TEXT NOT NULL,
        region TEXT CHECK(region IS NULL OR region IN ('cn-beijing', 'ap-southeast-1', 'us-east-1', 'cn-hongkong')),
        status TEXT NOT NULL CHECK(status IN ('not_configured', 'ready', 'needs_attention')),
        last_tested_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE llm_provider_credentials (
        provider TEXT PRIMARY KEY CHECK(provider IN ('nvidia', 'openrouter', 'bailian')),
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 9,
    name: "bailian-workspace-catalog",
    sql: `ALTER TABLE llm_provider_settings ADD COLUMN workspace_id TEXT;`
  },
  {
    version: 10,
    name: "minimax-provider",
    sql: `
      CREATE TABLE llm_settings_v10 (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        active_provider TEXT CHECK(active_provider IS NULL OR active_provider IN ('nvidia', 'openrouter', 'bailian', 'minimax')),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO llm_settings_v10 SELECT * FROM llm_settings;
      DROP TABLE llm_settings;
      ALTER TABLE llm_settings_v10 RENAME TO llm_settings;

      CREATE TABLE llm_provider_settings_v10 (
        provider TEXT PRIMARY KEY CHECK(provider IN ('nvidia', 'openrouter', 'bailian', 'minimax')),
        model TEXT NOT NULL,
        region TEXT CHECK(region IS NULL OR region IN ('cn-beijing', 'ap-southeast-1', 'us-east-1', 'cn-hongkong')),
        status TEXT NOT NULL CHECK(status IN ('not_configured', 'ready', 'needs_attention')),
        last_tested_at TEXT,
        updated_at TEXT NOT NULL,
        workspace_id TEXT
      ) STRICT;
      INSERT INTO llm_provider_settings_v10 SELECT * FROM llm_provider_settings;
      DROP TABLE llm_provider_settings;
      ALTER TABLE llm_provider_settings_v10 RENAME TO llm_provider_settings;

      CREATE TABLE llm_provider_credentials_v10 (
        provider TEXT PRIMARY KEY CHECK(provider IN ('nvidia', 'openrouter', 'bailian', 'minimax')),
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO llm_provider_credentials_v10 SELECT * FROM llm_provider_credentials;
      DROP TABLE llm_provider_credentials;
      ALTER TABLE llm_provider_credentials_v10 RENAME TO llm_provider_credentials;
    `
  },
  {
    version: 11,
    name: "redesign-record-pipeline",
    sql: `
      CREATE TABLE redesign_records (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK(origin IN ('manual', 'dayone', 'zip', 'migration')),
        categories_json TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        occurred_at_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        report_state TEXT NOT NULL CHECK(report_state IN ('queued', 'running', 'partial', 'failed', 'complete', 'stale')),
        source_updated INTEGER NOT NULL DEFAULT 0 CHECK(source_updated IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX redesign_records_timeline_idx ON redesign_records(recorded_at DESC, id DESC);

      CREATE TABLE redesign_sources (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        origin TEXT NOT NULL CHECK(origin IN ('manual', 'dayone', 'zip', 'migration')),
        connector_id TEXT,
        journal_id TEXT,
        entry_id TEXT,
        source_version TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        text TEXT,
        recorded_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(connector_id, journal_id, entry_id)
      ) STRICT;
      CREATE INDEX redesign_sources_record_idx ON redesign_sources(record_id, created_at DESC);

      CREATE TABLE redesign_record_assets (
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        PRIMARY KEY(record_id, asset_id)
      ) STRICT;

      CREATE TABLE redesign_screening_results (
        record_id TEXT PRIMARY KEY REFERENCES redesign_records(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK(decision = 'include'),
        categories_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        coverage TEXT NOT NULL CHECK(coverage IN ('complete', 'partial')),
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE redesign_pending_reviews (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK(origin IN ('manual', 'dayone', 'zip', 'migration')),
        origin_locator TEXT,
        source_version TEXT NOT NULL,
        excerpt TEXT NOT NULL CHECK(length(excerpt) <= 160),
        reason TEXT NOT NULL CHECK(length(reason) <= 120),
        categories_json TEXT NOT NULL,
        coverage TEXT NOT NULL CHECK(coverage IN ('complete', 'partial')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE redesign_operations (
        operation_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE redesign_reports (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        record_revision INTEGER NOT NULL CHECK(record_revision > 0),
        input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
        prompt_version TEXT NOT NULL,
        model_profile TEXT NOT NULL,
        content_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('partial', 'failed', 'complete')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX redesign_reports_record_idx ON redesign_reports(record_id, record_revision DESC, updated_at DESC);

      CREATE TABLE redesign_field_overrides (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        field_key TEXT NOT NULL CHECK(field_key IN ('title', 'occurredAt', 'location', 'jurisdiction')),
        value_json TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor = 'user'),
        revision INTEGER NOT NULL CHECK(revision > 1),
        basis TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(record_id, field_key)
      ) STRICT;

      CREATE VIRTUAL TABLE redesign_record_fts USING fts5(
        record_id UNINDEXED,
        title,
        source_text,
        report_text,
        user_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE redesign_connector_states (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('dayone', 'zip')),
        selected_journals_json TEXT NOT NULL,
        committed_cursor TEXT,
        scan_boundary TEXT,
        policy_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('idle', 'running', 'paused', 'cancelled', 'failed')),
        counts_json TEXT NOT NULL,
        last_success TEXT,
        next_check TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 12,
    name: "redesign-source-version-history",
    sql: `
      CREATE TABLE redesign_sources_v12 (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        origin TEXT NOT NULL CHECK(origin IN ('manual', 'dayone', 'zip', 'migration')),
        connector_id TEXT,
        journal_id TEXT,
        entry_id TEXT,
        source_version TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        text TEXT,
        recorded_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(connector_id, journal_id, entry_id, source_version)
      ) STRICT;
      INSERT INTO redesign_sources_v12 SELECT * FROM redesign_sources;
      DROP TABLE redesign_sources;
      ALTER TABLE redesign_sources_v12 RENAME TO redesign_sources;
      CREATE INDEX redesign_sources_record_idx ON redesign_sources(record_id, created_at DESC);
      CREATE INDEX redesign_sources_locator_idx
        ON redesign_sources(connector_id, journal_id, entry_id, created_at DESC);
    `
  },
  {
    version: 13,
    name: "redesign-record-revision-history",
    sql: `
      CREATE TABLE redesign_screening_results_v13 (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        record_revision INTEGER NOT NULL CHECK(record_revision > 0),
        decision TEXT NOT NULL CHECK(decision = 'include'),
        categories_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        anchors_json TEXT NOT NULL,
        coverage TEXT NOT NULL CHECK(coverage IN ('complete', 'partial')),
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(record_id, record_revision)
      ) STRICT;
      INSERT INTO redesign_screening_results_v13(
        id, record_id, record_revision, decision, categories_json, reason,
        anchors_json, coverage, policy_version, created_at
      )
      SELECT record_id || ':1', record_id, 1, decision, categories_json, reason,
        anchors_json, coverage, policy_version, created_at
      FROM redesign_screening_results;
      DROP TABLE redesign_screening_results;
      ALTER TABLE redesign_screening_results_v13 RENAME TO redesign_screening_results;
      CREATE INDEX redesign_screening_results_record_idx
        ON redesign_screening_results(record_id, record_revision DESC);

      CREATE TABLE redesign_record_revisions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        snapshot_json TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('source', 'user')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(record_id, revision)
      ) STRICT;
      INSERT INTO redesign_record_revisions(id, record_id, revision, snapshot_json, actor, reason, created_at)
      SELECT id || ':' || revision, id, revision,
        json_object(
          'id', id,
          'origin', origin,
          'categories', json(categories_json),
          'title', title,
          'summary', summary,
          'revision', revision,
          'occurredAt', json(occurred_at_json),
          'recordedAt', recorded_at,
          'reportState', report_state,
          'sourceUpdated', CASE source_updated WHEN 1 THEN json('true') ELSE json('false') END,
          'attachmentCount', (SELECT count(*) FROM redesign_record_assets ra WHERE ra.record_id = redesign_records.id),
          'createdAt', created_at,
          'updatedAt', updated_at
        ),
        'source', 'Initial redesigned record', created_at
      FROM redesign_records;
    `
  },
  {
    version: 14,
    name: "redesign-legacy-migration-provenance",
    sql: `
      CREATE TABLE redesign_migration_map (
        source_workspace_id TEXT NOT NULL,
        legacy_entity_id TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        revision_count INTEGER NOT NULL CHECK(revision_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source_workspace_id, legacy_entity_id)
      ) STRICT;
      CREATE INDEX redesign_migration_map_record_idx ON redesign_migration_map(record_id);

      CREATE TABLE redesign_legacy_revisions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        source_workspace_id TEXT NOT NULL,
        legacy_entity_id TEXT NOT NULL,
        legacy_revision INTEGER NOT NULL CHECK(legacy_revision > 0),
        snapshot_json TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_workspace_id, legacy_entity_id, legacy_revision)
      ) STRICT;
      CREATE INDEX redesign_legacy_revisions_record_idx
        ON redesign_legacy_revisions(record_id, legacy_revision);
    `
  },
  {
    version: 15,
    name: "llm-verified-task-capabilities",
    sql: `
      ALTER TABLE llm_provider_settings ADD COLUMN capabilities_json TEXT;
    `
  },
  {
    version: 16,
    name: "redesign-multimodal-search-index",
    sql: `
      CREATE TABLE redesign_search_generations (
        id TEXT PRIMARY KEY,
        adapter_identity TEXT NOT NULL,
        adapter_version INTEGER NOT NULL CHECK(adapter_version > 0),
        dimensions INTEGER NOT NULL CHECK(dimensions > 0),
        input_modalities_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('building','active','superseded','failed')),
        fragment_count INTEGER NOT NULL CHECK(fragment_count >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT
      ) STRICT;
      CREATE INDEX redesign_search_generations_state_idx
        ON redesign_search_generations(state, created_at DESC);

      CREATE TABLE redesign_search_embeddings (
        generation_id TEXT NOT NULL REFERENCES redesign_search_generations(id) ON DELETE CASCADE,
        fragment_id TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        record_revision INTEGER NOT NULL CHECK(record_revision > 0),
        source_version TEXT NOT NULL,
        modality TEXT NOT NULL CHECK(modality IN ('text','image','audio','video')),
        content_hash TEXT NOT NULL,
        text_content TEXT,
        asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
        anchor_json TEXT NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY(generation_id, fragment_id)
      ) STRICT;
      CREATE INDEX redesign_search_embeddings_record_idx
        ON redesign_search_embeddings(generation_id, record_id);
    `
  },
  {
    version: 17,
    name: "redesign-search-normalization",
    sql: `
      ALTER TABLE redesign_search_generations
      ADD COLUMN normalization TEXT NOT NULL DEFAULT 'none' CHECK(normalization IN ('none','l2'));
    `
  },
  {
    version: 18,
    name: "redesign-source-asset-revisions",
    sql: `
      CREATE TABLE redesign_record_assets_v18 (
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES redesign_sources(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id),
        PRIMARY KEY(source_id, asset_id)
      ) STRICT;
      INSERT INTO redesign_record_assets_v18(record_id, source_id, asset_id)
      SELECT ra.record_id,
        (SELECT s.id FROM redesign_sources s WHERE s.record_id = ra.record_id
          ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1),
        ra.asset_id
      FROM redesign_record_assets ra
      WHERE EXISTS (SELECT 1 FROM redesign_sources s WHERE s.record_id = ra.record_id);
      DROP TABLE redesign_record_assets;
      ALTER TABLE redesign_record_assets_v18 RENAME TO redesign_record_assets;
      CREATE INDEX redesign_record_assets_record_idx ON redesign_record_assets(record_id, source_id);
    `
  },
  {
    version: 19,
    name: "redesign-report-idempotency",
    sql: `
      DELETE FROM redesign_reports
      WHERE rowid NOT IN (
        SELECT max(rowid) FROM redesign_reports
        GROUP BY record_id, record_revision, input_hash, prompt_version, model_profile
      );
      CREATE UNIQUE INDEX redesign_reports_idempotency_idx
        ON redesign_reports(record_id, record_revision, input_hash, prompt_version, model_profile);
    `
  },
  {
    version: 20,
    name: "redesign-unretained-source-review",
    sql: `
      ALTER TABLE redesign_records ADD COLUMN source_review_required INTEGER NOT NULL DEFAULT 0
        CHECK(source_review_required IN (0, 1));
      UPDATE redesign_records SET source_review_required = 1, source_updated = 1
      WHERE EXISTS (
        SELECT 1 FROM redesign_record_revisions skipped
        WHERE skipped.record_id = redesign_records.id
          AND skipped.reason = '来源出现未收录的新版本'
          AND skipped.revision > COALESCE((
            SELECT MAX(retained.revision) FROM redesign_record_revisions retained
            WHERE retained.record_id = redesign_records.id
              AND retained.reason = '来源版本更新并重新收录'
          ), 0)
      );
    `
  },
  {
    version: 21,
    name: "redesign-sealed-pending-reviews",
    sql: `
      ALTER TABLE redesign_pending_reviews ADD COLUMN sealed_payload TEXT;
      CREATE TABLE redesign_pending_seal_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0, 1))
      ) STRICT;
      INSERT INTO redesign_pending_seal_state(id, cleanup_required) VALUES (1, 0);
    `
  },
  {
    version: 22,
    name: "redesign-report-analysis-runs",
    sql: `
      ALTER TABLE redesign_reports ADD COLUMN analysis_run_id TEXT;
      DROP INDEX redesign_reports_idempotency_idx;
      CREATE UNIQUE INDEX redesign_reports_legacy_idempotency_idx
        ON redesign_reports(record_id, record_revision, input_hash, prompt_version, model_profile)
        WHERE analysis_run_id IS NULL;
      CREATE UNIQUE INDEX redesign_reports_run_id_idx
        ON redesign_reports(analysis_run_id) WHERE analysis_run_id IS NOT NULL;
    `
  },
  {
    version: 23,
    name: "redesign-report-clarifications",
    sql: `
      CREATE TABLE redesign_field_overrides_v23 (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL REFERENCES redesign_records(id) ON DELETE CASCADE,
        field_key TEXT NOT NULL CHECK(field_key IN ('title', 'occurredAt', 'location', 'jurisdiction', 'clarifications')),
        value_json TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor = 'user'),
        revision INTEGER NOT NULL CHECK(revision > 1),
        basis TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(record_id, field_key)
      ) STRICT;
      INSERT INTO redesign_field_overrides_v23
        (id, record_id, field_key, value_json, actor, revision, basis, created_at, updated_at)
      SELECT id, record_id, field_key, value_json, actor, revision, basis, created_at, updated_at
      FROM redesign_field_overrides;
      DROP TABLE redesign_field_overrides;
      ALTER TABLE redesign_field_overrides_v23 RENAME TO redesign_field_overrides;
    `
  },
  {
    version: 24,
    name: "redesign-sanitize-failure-diagnostics",
    sql: `
      UPDATE redesign_search_generations
      SET last_error = 'INTERNAL_ERROR' WHERE last_error IS NOT NULL;
      UPDATE jobs
      SET last_error = 'INTERNAL_ERROR'
      WHERE type IN ('record.analyze', 'record.search-index-rebuild') AND last_error IS NOT NULL;
      UPDATE job_attempts
      SET error = 'INTERNAL_ERROR'
      WHERE error IS NOT NULL AND job_id IN (
        SELECT id FROM jobs WHERE type IN ('record.analyze', 'record.search-index-rebuild')
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
    availabilityStatus: (row.availability_status ?? "available") as Asset["availabilityStatus"],
    createdAt: String(row.created_at)
  };
  if (row.superseded_by_asset_id) asset.supersededByAssetId = String(row.superseded_by_asset_id);
  if (row.deleted_at) asset.deletedAt = String(row.deleted_at);
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

  findBySha256(sha256: string): Asset | undefined {
    const row = this.database.prepare("SELECT * FROM assets WHERE sha256 = ?").get(sha256) as Record<string, unknown> | undefined;
    return row ? mapAsset(row) : undefined;
  }

  upsert(asset: Asset): { asset: Asset; deduplicated: boolean } {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM assets WHERE sha256 = ?").get(asset.sha256) as Record<string, unknown> | undefined;
      if (existing) return { asset: mapAsset(existing), deduplicated: true };
      this.database.prepare(`
        INSERT INTO assets(
          id, sha256, byte_size, mime_type, original_file_name, vault_format,
          integrity_status, verified_at, availability_status, superseded_by_asset_id, deleted_at, created_at
        ) VALUES (@id, @sha256, @byteSize, @mimeType, @originalFileName, @vaultFormat,
          @integrityStatus, @verifiedAt, @availabilityStatus, @supersededByAssetId, @deletedAt, @createdAt)
      `).run({ ...asset, verifiedAt: asset.verifiedAt ?? null,
        supersededByAssetId: asset.supersededByAssetId ?? null, deletedAt: asset.deletedAt ?? null });
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

  setVaultFormat(id: string, vaultFormat: number): Asset {
    const result = this.database.prepare("UPDATE assets SET vault_format = ? WHERE id = ?").run(vaultFormat, id);
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

  claimNext(now: string, leaseUntil: string, allowedTypes?: readonly string[]): Job | undefined {
    if (allowedTypes?.length === 0) return undefined;
    const typeFilter = allowedTypes ? `AND type IN (${allowedTypes.map(() => "?").join(",")})` : "";
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM jobs
        WHERE ((state = 'queued' AND available_at <= ?)
           OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?))
          ${typeFilter}
        ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, available_at, created_at
        LIMIT 1
      `).get(now, now, ...(allowedTypes ?? [])) as Record<string, unknown> | undefined;
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
      if (current.state === "cancelled") return current;
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
      UPDATE jobs SET state = 'queued', progress = 0, max_attempts = attempts + 4,
        available_at = ?, lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.getRequired(id);
  }

  cancel(id: string, now: string): Job {
    const current = this.getRequired(id);
    if (current.state !== "queued" && current.state !== "running") {
      throw new AppError("JOB_STATE_CONFLICT", "Only queued or running jobs can be cancelled.");
    }
    return this.database.transaction(() => {
      this.database.prepare(`UPDATE jobs SET state='cancelled',lease_until=NULL,updated_at=? WHERE id=?`).run(now, id);
      this.database.prepare(`UPDATE job_attempts SET finished_at=?,outcome='abandoned',error='Cancelled by user.'
        WHERE job_id=? AND finished_at IS NULL`).run(now, id);
      return this.getRequired(id);
    })();
  }

  interrupt(id: string, error: string, now: string): Job {
    const current = this.getRequired(id);
    if (current.state === "cancelled") return current;
    if (current.state !== "running") {
      throw new AppError("JOB_STATE_CONFLICT", "Only a running job can be interrupted.");
    }
    return this.database.transaction(() => {
      this.database.prepare(`UPDATE jobs SET state='queued',progress=0,max_attempts=max_attempts+1,
        available_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE id=?`).run(now, error, now, id);
      this.database.prepare(`UPDATE job_attempts SET finished_at=?,outcome='abandoned',error=?
        WHERE job_id=? AND finished_at IS NULL`).run(now, error, id);
      return this.getRequired(id);
    })();
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

function mapPersonAlias(row: Record<string, unknown>): PersonAlias {
  return {
    id: String(row.id), personId: String(row.person_id), value: String(row.value),
    normalizedValue: String(row.normalized_value), sourceRefs: JSON.parse(String(row.source_refs_json)) as string[],
    status: row.status as PersonAlias["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapPersonMergeSuggestion(row: Record<string, unknown>): PersonMergeSuggestion {
  const value: PersonMergeSuggestion = {
    id: String(row.id), personAId: String(row.person_a_id), personBId: String(row.person_b_id),
    score: Number(row.score), basis: JSON.parse(String(row.basis_json)) as string[],
    algorithmIdentity: String(row.algorithm_identity), algorithmVersion: Number(row.algorithm_version),
    status: row.status as PersonMergeSuggestion["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.merge_record_id) value.mergeRecordId = String(row.merge_record_id);
  return value;
}

function mapPersonMergeRecord(row: Record<string, unknown>): PersonMergeRecord {
  const value: PersonMergeRecord = {
    id: String(row.id), sourcePersonId: String(row.source_person_id), targetPersonId: String(row.target_person_id),
    status: row.status as PersonMergeRecord["status"], createdAt: String(row.created_at)
  };
  if (row.suggestion_id) value.suggestionId = String(row.suggestion_id);
  if (row.reverted_at) value.revertedAt = String(row.reverted_at);
  return value;
}

function mapEventRelation(row: Record<string, unknown>): EventRelation {
  const value: EventRelation = {
    id: String(row.id), sourceEventId: String(row.source_event_id), targetEventId: String(row.target_event_id),
    kind: row.kind as EventRelation["kind"], status: row.status as EventRelation["status"],
    origin: row.origin as EventRelation["origin"], basis: JSON.parse(String(row.basis_json)) as EventRelation["basis"],
    sourceRevision: Number(row.source_revision), targetRevision: Number(row.target_revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.score !== null && row.score !== undefined) value.score = Number(row.score);
  if (row.algorithm_identity) value.algorithmIdentity = String(row.algorithm_identity);
  if (row.algorithm_version) value.algorithmVersion = Number(row.algorithm_version);
  return value;
}

function mapSearchDocument(row: Record<string, unknown>): SearchDocument {
  const value: SearchDocument = {
    kind: row.kind as SearchDocument["kind"], id: String(row.id), title: String(row.title), content: String(row.content),
    contentHash: String(row.content_hash), sourceRefs: JSON.parse(String(row.source_refs_json)) as string[]
  };
  if (row.occurred_at) value.occurredAt = String(row.occurred_at);
  if (row.event_id) value.eventId = String(row.event_id);
  if (row.source_item_id) value.sourceItemId = String(row.source_item_id);
  if (row.derived_artifact_id) value.derivedArtifactId = String(row.derived_artifact_id);
  if (row.source_asset_id) value.sourceAssetId = String(row.source_asset_id);
  return value;
}

function mapEmbeddingGeneration(row: Record<string, unknown>): EmbeddingGeneration {
  const value: EmbeddingGeneration = {
    id: String(row.id), adapterIdentity: String(row.adapter_identity), adapterVersion: Number(row.adapter_version),
    dimensions: Number(row.dimensions), state: row.state as EmbeddingGeneration["state"],
    documentCount: Number(row.document_count), createdAt: String(row.created_at)
  };
  if (row.last_error) value.lastError = String(row.last_error);
  if (row.activated_at) value.activatedAt = String(row.activated_at);
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
    const personIds = query.personIds?.length ? query.personIds : query.personId ? [query.personId] : [];
    if (personIds.length) {
      conditions.push(`EXISTS (SELECT 1 FROM event_people ep WHERE ep.event_id = e.id AND ep.person_id IN (${personIds.map(() => "?").join(",")}))`);
      parameters.push(...personIds);
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

  listPersonAliases(personId?: string, includeInactive = false): PersonAlias[] {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (personId) { conditions.push("person_id = ?"); parameters.push(personId); }
    if (!includeInactive) conditions.push("status = 'active'");
    return (this.database.prepare(`
      SELECT * FROM person_aliases ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY value
    `).all(...parameters) as Record<string, unknown>[]).map(mapPersonAlias);
  }

  createPersonAlias(alias: PersonAlias): PersonAlias {
    try {
      this.database.prepare(`
        INSERT INTO person_aliases(id, person_id, value, normalized_value, source_refs_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(alias.id, alias.personId, alias.value, alias.normalizedValue, JSON.stringify(alias.sourceRefs),
        alias.status, alias.createdAt, alias.updatedAt);
      return alias;
    } catch (error) {
      throw new AppError("VALIDATION_FAILED", "That active alias already exists for this person.", false, { cause: error });
    }
  }

  deactivatePersonAlias(id: string, now: string): PersonAlias {
    const result = this.database.prepare(
      "UPDATE person_aliases SET status = 'inactive', updated_at = ? WHERE id = ?"
    ).run(now, id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The alias no longer exists.");
    return mapPersonAlias(this.database.prepare("SELECT * FROM person_aliases WHERE id = ?").get(id) as Record<string, unknown>);
  }

  listPersonMergeSuggestions(): PersonMergeSuggestion[] {
    return (this.database.prepare(
      "SELECT * FROM person_merge_suggestions ORDER BY status, score DESC, updated_at DESC"
    ).all() as Record<string, unknown>[]).map(mapPersonMergeSuggestion);
  }

  upsertPersonMergeSuggestion(suggestion: PersonMergeSuggestion): PersonMergeSuggestion {
    const existing = this.database.prepare(`
      SELECT * FROM person_merge_suggestions
      WHERE person_a_id = ? AND person_b_id = ? AND algorithm_identity = ? AND algorithm_version = ?
    `).get(suggestion.personAId, suggestion.personBId, suggestion.algorithmIdentity, suggestion.algorithmVersion) as Record<string, unknown> | undefined;
    if (existing) {
      const mapped = mapPersonMergeSuggestion(existing);
      if (mapped.status !== "pending") return mapped;
      this.database.prepare(`
        UPDATE person_merge_suggestions SET score = ?, basis_json = ?, updated_at = ? WHERE id = ?
      `).run(suggestion.score, JSON.stringify(suggestion.basis), suggestion.updatedAt, mapped.id);
      return { ...mapped, score: suggestion.score, basis: suggestion.basis, updatedAt: suggestion.updatedAt };
    }
    this.database.prepare(`
      INSERT INTO person_merge_suggestions(
        id, person_a_id, person_b_id, score, basis_json, algorithm_identity, algorithm_version,
        status, merge_record_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(suggestion.id, suggestion.personAId, suggestion.personBId, suggestion.score, JSON.stringify(suggestion.basis),
      suggestion.algorithmIdentity, suggestion.algorithmVersion, suggestion.status, suggestion.mergeRecordId ?? null,
      suggestion.createdAt, suggestion.updatedAt);
    return suggestion;
  }

  updatePersonMergeSuggestion(
    id: string, status: PersonMergeSuggestion["status"], now: string, mergeRecordId?: string
  ): PersonMergeSuggestion {
    const result = this.database.prepare(`
      UPDATE person_merge_suggestions SET status = ?, merge_record_id = COALESCE(?, merge_record_id), updated_at = ? WHERE id = ?
    `).run(status, mergeRecordId ?? null, now, id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The merge suggestion no longer exists.");
    return mapPersonMergeSuggestion(this.database.prepare(
      "SELECT * FROM person_merge_suggestions WHERE id = ?"
    ).get(id) as Record<string, unknown>);
  }

  listPersonMergeRecords(includeReverted = false): PersonMergeRecord[] {
    const rows = includeReverted
      ? this.database.prepare("SELECT * FROM person_merge_records ORDER BY created_at DESC").all()
      : this.database.prepare("SELECT * FROM person_merge_records WHERE status = 'active' ORDER BY created_at DESC").all();
    return (rows as Record<string, unknown>[]).map(mapPersonMergeRecord);
  }

  createPersonMerge(record: PersonMergeRecord): PersonMergeRecord {
    try {
      this.database.prepare(`
        INSERT INTO person_merge_records(
          id, source_person_id, target_person_id, suggestion_id, status, created_at, reverted_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(record.id, record.sourcePersonId, record.targetPersonId, record.suggestionId ?? null, record.status, record.createdAt);
      return record;
    } catch (error) {
      throw new AppError("PERSON_MERGE_CONFLICT", "This person already has an active identity merge.", false, { cause: error });
    }
  }

  revertPersonMerge(id: string, now: string): PersonMergeRecord {
    const result = this.database.prepare(`
      UPDATE person_merge_records SET status = 'reverted', reverted_at = ? WHERE id = ? AND status = 'active'
    `).run(now, id);
    if (result.changes !== 1) throw new AppError("PERSON_MERGE_CONFLICT", "The identity merge is no longer active.");
    return mapPersonMergeRecord(this.database.prepare(
      "SELECT * FROM person_merge_records WHERE id = ?"
    ).get(id) as Record<string, unknown>);
  }

  resolveCanonicalPersonId(id: string): string {
    let current = id;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) throw new AppError("PERSON_MERGE_CONFLICT", "The person identity graph contains a cycle.");
      visited.add(current);
      const row = this.database.prepare(`
        SELECT target_person_id FROM person_merge_records WHERE source_person_id = ? AND status = 'active'
      `).get(current) as { target_person_id: string } | undefined;
      if (!row) return current;
      current = row.target_person_id;
    }
  }

  listIdentityPersonIds(id: string): string[] {
    const canonical = this.resolveCanonicalPersonId(id);
    const people = this.listPeople(true).map(({ id: personId }) => personId);
    return people.filter((personId) => this.resolveCanonicalPersonId(personId) === canonical);
  }

  listEventRelations(eventId?: string, includeRejected = false): EventRelation[] {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (eventId) {
      conditions.push("(source_event_id = ? OR target_event_id = ?)");
      parameters.push(eventId, eventId);
    }
    if (!includeRejected) conditions.push("status <> 'rejected'");
    return (this.database.prepare(`
      SELECT * FROM event_relations ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY status, score DESC, updated_at DESC
    `).all(...parameters) as Record<string, unknown>[]).map(mapEventRelation);
  }

  getEventRelation(id: string): EventRelation | undefined {
    const row = this.database.prepare("SELECT * FROM event_relations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapEventRelation(row) : undefined;
  }

  upsertEventRelation(relation: EventRelation): EventRelation {
    const existing = this.database.prepare(`
      SELECT * FROM event_relations WHERE source_event_id = ? AND target_event_id = ? AND kind = ?
    `).get(relation.sourceEventId, relation.targetEventId, relation.kind) as Record<string, unknown> | undefined;
    if (existing) {
      const mapped = mapEventRelation(existing);
      if (relation.origin === "user") {
        this.database.prepare(`
          UPDATE event_relations SET status = 'confirmed', origin = 'user', score = NULL, basis_json = ?,
            algorithm_identity = NULL, algorithm_version = NULL, source_revision = ?, target_revision = ?, updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(relation.basis), relation.sourceRevision, relation.targetRevision, relation.updatedAt, mapped.id);
        return this.getEventRelation(mapped.id)!;
      }
      if (mapped.status !== "suggested" || mapped.origin !== "algorithm") return mapped;
      this.database.prepare(`
        UPDATE event_relations SET score = ?, basis_json = ?, source_revision = ?, target_revision = ?, updated_at = ? WHERE id = ?
      `).run(relation.score ?? null, JSON.stringify(relation.basis), relation.sourceRevision,
        relation.targetRevision, relation.updatedAt, mapped.id);
      return this.getEventRelation(mapped.id)!;
    }
    this.database.prepare(`
      INSERT INTO event_relations(
        id, source_event_id, target_event_id, kind, status, origin, score, basis_json,
        algorithm_identity, algorithm_version, source_revision, target_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(relation.id, relation.sourceEventId, relation.targetEventId, relation.kind, relation.status,
      relation.origin, relation.score ?? null, JSON.stringify(relation.basis), relation.algorithmIdentity ?? null,
      relation.algorithmVersion ?? null, relation.sourceRevision, relation.targetRevision, relation.createdAt, relation.updatedAt);
    return relation;
  }

  updateEventRelationStatus(id: string, status: EventRelation["status"], now: string): EventRelation {
    const result = this.database.prepare(
      "UPDATE event_relations SET status = ?, updated_at = ? WHERE id = ?"
    ).run(status, now, id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The event relation no longer exists.");
    return this.getEventRelation(id)!;
  }

  deleteEventRelation(id: string): void {
    const result = this.database.prepare("DELETE FROM event_relations WHERE id = ?").run(id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The event relation no longer exists.");
  }

  searchUnifiedKeyword(query: UnifiedSearchQuery): UnifiedSearchHit[] {
    const limit = Math.min(200, Math.max(1, query.limit ?? 100));
    const eventQuery: EventSearchQuery = {
      text: query.text, limit, ...(query.status ? { status: query.status } : {}),
      ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {})
    };
    if (query.personId) eventQuery.personIds = this.listIdentityPersonIds(query.personId);
    const includeEvents = !query.kinds?.length || query.kinds.includes("event");
    const eventHits = includeEvents ? this.searchEvents(eventQuery).map((event, index): UnifiedSearchHit => {
      const occurredAt = temporalBounds(event).from;
      return {
        kind: "event", id: event.id, eventId: event.id, title: event.title,
        excerpt: (event.narrative ?? event.facts.map(({ text }) => text).join(" ")).slice(0, 360),
        ...(occurredAt ? { occurredAt } : {}), sourceRefs: event.sourceRefs,
        keywordScore: 1 / (index + 1), combinedScore: 1 / (index + 1)
      };
    }) : [];
    const sourceKinds = (query.kinds ?? ["journal_entry", "ocr", "transcript"]).filter((kind) => kind !== "event");
    if (!sourceKinds.length) return eventHits.slice(0, limit);
    const conditions = [`d.kind IN (${sourceKinds.map(() => "?").join(",")})`];
    const parameters: unknown[] = [...sourceKinds];
    const hasText = Boolean(query.text.trim());
    if (hasText) { conditions.push("fts_sources MATCH ?"); parameters.push(ftsQuery(query.text)); }
    if (query.from) { conditions.push("d.occurred_at IS NOT NULL AND d.occurred_at >= ?"); parameters.push(query.from); }
    if (query.to) { conditions.push("d.occurred_at IS NOT NULL AND d.occurred_at <= ?"); parameters.push(query.to); }
    if (query.status) {
      conditions.push(`(EXISTS (
        SELECT 1 FROM event_sources es JOIN events linked ON linked.id = es.event_id
        WHERE es.source_item_id = d.source_item_id AND linked.status = ?
      ) OR EXISTS (
        SELECT 1 FROM event_assets ea JOIN events linked ON linked.id = ea.event_id
        WHERE ea.asset_id = d.source_asset_id AND linked.status = ?
      ))`);
      parameters.push(query.status, query.status);
    }
    if (query.personId) {
      const personIds = this.listIdentityPersonIds(query.personId);
      conditions.push(`(EXISTS (
        SELECT 1 FROM event_sources es JOIN event_people ep ON ep.event_id = es.event_id
        WHERE es.source_item_id = d.source_item_id AND ep.person_id IN (${personIds.map(() => "?").join(",")})
      ) OR EXISTS (
        SELECT 1 FROM event_assets ea JOIN event_people ep ON ep.event_id = ea.event_id
        WHERE ea.asset_id = d.source_asset_id AND ep.person_id IN (${personIds.map(() => "?").join(",")})
      ))`);
      parameters.push(...personIds, ...personIds);
    }
    parameters.push(limit);
    const rows = this.database.prepare(`
      SELECT d.*${hasText ? ", bm25(fts_sources) AS rank" : ""}
      FROM source_search_documents d ${hasText ? "JOIN fts_sources ON fts_sources.document_id = d.id" : ""}
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${hasText ? "rank, d.updated_at DESC" : "d.updated_at DESC"} LIMIT ?
    `).all(...parameters) as Record<string, unknown>[];
    const sourceHits = rows.map((row, index): UnifiedSearchHit => {
      const document = mapSearchDocument(row);
      return {
        kind: document.kind, id: document.id, title: document.title, excerpt: document.content.slice(0, 360),
        ...(document.occurredAt ? { occurredAt: document.occurredAt } : {}),
        ...(document.eventId ? { eventId: document.eventId } : {}),
        ...(document.sourceItemId ? { sourceItemId: document.sourceItemId } : {}),
        ...(document.derivedArtifactId ? { derivedArtifactId: document.derivedArtifactId } : {}),
        ...(document.sourceAssetId ? { sourceAssetId: document.sourceAssetId } : {}),
        sourceRefs: document.sourceRefs, keywordScore: 1 / (index + 1), combinedScore: 1 / (index + 1)
      };
    });
    return [...eventHits, ...sourceHits].sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0)).slice(0, limit);
  }

  listSearchDocuments(): SearchDocument[] {
    const events = (this.database.prepare("SELECT * FROM events WHERE status <> 'archived'").all() as Record<string, unknown>[])
      .map(mapEvent).map((event): SearchDocument => {
        const content = [event.title, event.narrative ?? "", ...event.facts.map(({ text }) => text),
          ...event.interpretations.map(({ text }) => text), ...event.interests.map(({ label }) => label)].join("\n");
        const occurredAt = temporalBounds(event).from;
        return {
          kind: "event", id: event.id, eventId: event.id, title: event.title, content,
          contentHash: createHash("sha256").update(content).digest("hex"),
          ...(occurredAt ? { occurredAt } : {}), sourceRefs: event.sourceRefs
        };
      });
    const sources = (this.database.prepare("SELECT * FROM source_search_documents").all() as Record<string, unknown>[]).map(mapSearchDocument);
    return [...events, ...sources];
  }

  upsertSearchDocument(document: SearchDocument, now: string): void {
    if (document.kind === "event") throw new AppError("VALIDATION_FAILED", "Event search documents are derived from Event projections.");
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO source_search_documents(
          id, kind, title, content, content_hash, occurred_at, event_id, source_item_id,
          derived_artifact_id, source_asset_id, source_refs_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, content = excluded.content,
          content_hash = excluded.content_hash, occurred_at = excluded.occurred_at, event_id = excluded.event_id,
          source_item_id = excluded.source_item_id, derived_artifact_id = excluded.derived_artifact_id,
          source_asset_id = excluded.source_asset_id, source_refs_json = excluded.source_refs_json,
          updated_at = excluded.updated_at
      `).run(document.id, document.kind, document.title, document.content, document.contentHash,
        document.occurredAt ?? null, document.eventId ?? null, document.sourceItemId ?? null,
        document.derivedArtifactId ?? null, document.sourceAssetId ?? null,
        JSON.stringify(document.sourceRefs), now);
      this.database.prepare("DELETE FROM fts_sources WHERE document_id = ?").run(document.id);
      this.database.prepare("INSERT INTO fts_sources(document_id, title, content) VALUES (?, ?, ?)")
        .run(document.id, document.title, document.content);
    })();
  }

  getSourceReference(id: string): SourceReferenceDetail | undefined {
    const row = this.database.prepare(`
      SELECT si.*, s.kind AS source_kind, s.name AS source_name,
        m.id AS message_id, m.conversation_id,
        je.journal_date, je.current_version,
        sv.content AS version_content, sv.content_hash
      FROM source_items si JOIN sources s ON s.id = si.source_id
      LEFT JOIN messages m ON m.source_item_id = si.id
      LEFT JOIN journal_entries je ON je.source_item_id = si.id
      LEFT JOIN source_versions sv ON sv.id = je.current_version_id
      WHERE si.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      const derived = this.database.prepare(
        "SELECT * FROM source_search_documents WHERE (id = ? OR derived_artifact_id = ?) AND kind IN ('ocr','transcript')"
      ).get(id, id) as Record<string, unknown> | undefined;
      if (!derived) return undefined;
      const document = mapSearchDocument(derived);
      return {
        sourceItemId: document.sourceItemId ?? document.id, kind: document.kind as "ocr" | "transcript", title: document.title,
        excerpt: document.content.slice(0, 4000), recordedAt: document.occurredAt ?? String(derived.updated_at),
        ...(document.derivedArtifactId ? { derivedArtifactId: document.derivedArtifactId } : {}),
        eventIds: document.eventId ? [document.eventId] : [], assetIds: document.sourceAssetId ? [document.sourceAssetId] : []
      };
    }
    const eventIds = (this.database.prepare("SELECT event_id FROM event_sources WHERE source_item_id = ? ORDER BY event_id")
      .all(id) as Array<{ event_id: string }>).map(({ event_id }) => event_id);
    const directAssets = (this.database.prepare("SELECT asset_id FROM source_item_assets WHERE source_item_id = ?")
      .all(id) as Array<{ asset_id: string }>).map(({ asset_id }) => asset_id);
    const versionAssets = (this.database.prepare(`
      SELECT sva.asset_id FROM journal_entries je JOIN source_version_assets sva ON sva.source_version_id = je.current_version_id
      WHERE je.source_item_id = ?
    `).all(id) as Array<{ asset_id: string }>).map(({ asset_id }) => asset_id);
    const isJournal = Boolean(row.journal_date);
    const isMessage = Boolean(row.message_id);
    const value: SourceReferenceDetail = {
      sourceItemId: id, kind: isJournal ? "journal_entry" : isMessage ? "message" : "manual",
      title: isJournal ? `Day One · ${String(row.journal_date)}` : String(row.source_name),
      excerpt: String(row.version_content ?? row.content ?? "").slice(0, 4000), recordedAt: String(row.recorded_at),
      eventIds, assetIds: [...new Set([...directAssets, ...versionAssets])]
    };
    if (row.current_version) value.sourceVersion = Number(row.current_version);
    if (row.content_hash) value.contentHash = String(row.content_hash);
    if (row.conversation_id) value.conversationId = String(row.conversation_id);
    if (row.message_id) value.messageId = String(row.message_id);
    return value;
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.database.prepare("SELECT value_json FROM workspace_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  setSetting(key: string, value: unknown, now: string): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), now);
    })();
  }

  listEmbeddingGenerations(): EmbeddingGeneration[] {
    return (this.database.prepare("SELECT * FROM embedding_generations ORDER BY created_at DESC").all() as Record<string, unknown>[])
      .map(mapEmbeddingGeneration);
  }

  createEmbeddingGeneration(generation: EmbeddingGeneration): void {
    this.database.prepare(`
      INSERT INTO embedding_generations(
        id, adapter_identity, adapter_version, dimensions, state, document_count, last_error, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generation.id, generation.adapterIdentity, generation.adapterVersion, generation.dimensions,
      generation.state, generation.documentCount, generation.lastError ?? null, generation.createdAt, generation.activatedAt ?? null);
  }

  putEmbedding(generationId: string, document: SearchDocument, vector: Float32Array): void {
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.database.prepare(`
      INSERT INTO embeddings(generation_id, document_kind, document_id, content_hash, vector)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(generation_id, document_kind, document_id)
      DO UPDATE SET content_hash = excluded.content_hash, vector = excluded.vector
    `).run(generationId, document.kind, document.id, document.contentHash, bytes);
  }

  activateEmbeddingGeneration(id: string, documentCount: number, now: string): void {
    this.database.transaction(() => {
      this.database.prepare("UPDATE embedding_generations SET state = 'superseded' WHERE state = 'active'").run();
      const result = this.database.prepare(`
        UPDATE embedding_generations SET state = 'active', document_count = ?, activated_at = ?, last_error = NULL
        WHERE id = ? AND state = 'building'
      `).run(documentCount, now, id);
      if (result.changes !== 1) throw new AppError("VALIDATION_FAILED", "The embedding generation is no longer buildable.");
    })();
  }

  failEmbeddingGeneration(id: string, error: string): void {
    this.database.prepare(
      "UPDATE embedding_generations SET state = 'failed', last_error = ? WHERE id = ? AND state = 'building'"
    ).run(error.slice(0, 1000), id);
  }

  listEmbeddings(generationId: string): Array<{ document: SearchDocument; vector: Float32Array }> {
    const documents = new Map(this.listSearchDocuments().map((document) => [`${document.kind}:${document.id}`, document]));
    const rows = this.database.prepare("SELECT * FROM embeddings WHERE generation_id = ?").all(generationId) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const document = documents.get(`${String(row.document_kind)}:${String(row.document_id)}`);
      if (!document || document.contentHash !== String(row.content_hash)) return [];
      const buffer = row.vector as Buffer;
      const copy = Uint8Array.from(buffer);
      return [{ document, vector: new Float32Array(copy.buffer) }];
    });
  }

  listReviews(): ReviewRun[] {
    return (this.database.prepare(
      "SELECT output_json FROM analysis_runs WHERE type = 'review.periodic' ORDER BY created_at DESC"
    ).all() as Array<{ output_json: string }>).map(({ output_json }) => JSON.parse(output_json) as ReviewRun);
  }

  getReview(id: string): ReviewRun | undefined {
    const row = this.database.prepare(
      "SELECT output_json FROM analysis_runs WHERE id = ? AND type = 'review.periodic'"
    ).get(id) as { output_json: string } | undefined;
    return row ? JSON.parse(row.output_json) as ReviewRun : undefined;
  }

  saveReview(review: ReviewRun): ReviewRun {
    this.database.prepare(`
      INSERT INTO analysis_runs(
        id, type, processor_identity, processor_version, input_hash, from_date, to_date, output_json, created_at
      ) VALUES (?, 'review.periodic', ?, ?, ?, ?, ?, ?, ?)
    `).run(review.id, review.generatorIdentity, review.generatorVersion, review.inputHash,
      review.from, review.to, JSON.stringify(review), review.createdAt);
    return review;
  }

  listClarifications(eventId?: string): Clarification[] {
    const rows = eventId
      ? this.database.prepare("SELECT * FROM clarifications WHERE event_id = ? ORDER BY created_at").all(eventId)
      : this.database.prepare(`
          SELECT * FROM clarifications ORDER BY
            CASE status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
            CASE priority WHEN 'rights_related' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            created_at
        `).all();
    return (rows as Record<string, unknown>[]).map(mapClarification);
  }

  getClarification(id: string): Clarification | undefined {
    const row = this.database.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapClarification(row) : undefined;
  }

  setClarificationPriority(id: string, priority: Clarification["priority"], now: string): Clarification {
    const result = this.database.prepare(
      "UPDATE clarifications SET priority = ?, updated_at = ? WHERE id = ?"
    ).run(priority, now, id);
    if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "The clarification no longer exists.");
    return mapClarification(this.database.prepare("SELECT * FROM clarifications WHERE id = ?").get(id) as Record<string, unknown>);
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
      const title = entry.text.trim().split(/[。！？.!?\n]/, 1)[0]?.slice(0, 120) || `Day One · ${entry.journalDate}`;
      this.memory.upsertSearchDocument({
        kind: "journal_entry", id: `journal:${sourceItemId}`, title, content: entry.text,
        contentHash: entry.contentHash, occurredAt: entry.journalDate, sourceItemId,
        sourceRefs: [sourceItemId]
      }, now);
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

export class SqliteAgentRepository implements AgentRepositoryPort {
  constructor(private readonly database: Database.Database) {}

  listRuns(conversationId: string): AgentRun[] {
    const rows = this.database.prepare(
      "SELECT id FROM agent_runs WHERE conversation_id = ? ORDER BY created_at, id"
    ).all(conversationId) as Array<{ id: string }>;
    return rows.map(({ id }) => this.getRun(id)).filter((run): run is AgentRun => Boolean(run));
  }

  getRun(id: string): AgentRun | undefined {
    const row = this.database.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const toolCalls = (this.database.prepare(
      "SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY sequence"
    ).all(id) as Record<string, unknown>[]).map((tool): AgentToolCall => ({
      id: String(tool.id), runId: String(tool.run_id), sequence: Number(tool.sequence),
      toolName: String(tool.tool_name), toolVersion: Number(tool.tool_version), inputHash: String(tool.input_hash),
      inputRefs: JSON.parse(String(tool.input_refs_json)) as string[],
      outputRefs: JSON.parse(String(tool.output_refs_json)) as string[],
      status: tool.status as AgentToolCall["status"], startedAt: String(tool.started_at),
      ...(tool.error_code ? { errorCode: String(tool.error_code) } : {}),
      ...(tool.finished_at ? { finishedAt: String(tool.finished_at) } : {})
    }));
    const actions = (this.database.prepare(
      "SELECT * FROM agent_actions WHERE run_id = ? ORDER BY created_at, id"
    ).all(id) as Record<string, unknown>[]).map((action): AgentAction => ({
      id: String(action.id), runId: String(action.run_id), toolCallId: String(action.tool_call_id),
      toolName: String(action.tool_name), toolVersion: Number(action.tool_version), summary: String(action.summary),
      payload: JSON.parse(String(action.payload_json)), status: action.status as AgentAction["status"],
      resultRefs: JSON.parse(String(action.result_refs_json)) as string[], createdAt: String(action.created_at),
      ...(action.expected_revision ? { expectedRevision: Number(action.expected_revision) } : {}),
      ...(action.resolved_at ? { resolvedAt: String(action.resolved_at) } : {}),
      ...(action.error_code ? { errorCode: String(action.error_code) } : {})
    }));
    const disclosureRow = this.database.prepare(
      "SELECT * FROM external_context_disclosures WHERE run_id = ?"
    ).get(id) as Record<string, unknown> | undefined;
    const disclosure = disclosureRow ? {
      id: String(disclosureRow.id), runId: String(disclosureRow.run_id), policyVersion: Number(disclosureRow.policy_version),
      categories: JSON.parse(String(disclosureRow.categories_json)),
      categoryCounts: JSON.parse(String(disclosureRow.category_counts_json)), contextHash: String(disclosureRow.context_hash),
      required: Boolean(disclosureRow.required), createdAt: String(disclosureRow.created_at),
      ...(disclosureRow.accepted_at ? { acceptedAt: String(disclosureRow.accepted_at) } : {}),
      ...(disclosureRow.rejected_at ? { rejectedAt: String(disclosureRow.rejected_at) } : {})
    } as NonNullable<AgentRun["disclosure"]> : undefined;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), userMessageId: String(row.user_message_id),
      intent: row.intent as AgentRun["intent"], mode: row.mode as AgentRun["mode"], status: row.status as AgentRun["status"],
      toolSchemaVersion: Number(row.tool_schema_version), contextHash: String(row.context_hash),
      responseVersion: Number(row.response_version), citations: JSON.parse(String(row.citations_json)), toolCalls, actions,
      createdAt: String(row.created_at),
      ...(row.assistant_message_id ? { assistantMessageId: String(row.assistant_message_id) } : {}),
      ...(row.model_identity ? { modelIdentity: String(row.model_identity) } : {}),
      ...(row.model_version ? { modelVersion: Number(row.model_version) } : {}),
      ...(row.response_text ? { responseText: String(row.response_text) } : {}),
      ...(row.analysis_json ? { analysis: JSON.parse(String(row.analysis_json)) } : {}),
      ...(disclosure ? { disclosure } : {}),
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {})
    };
  }

  saveRun(run: AgentRun): AgentRun {
    return this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_runs(
          id, conversation_id, user_message_id, assistant_message_id, intent, mode, status, model_identity,
          model_version, tool_schema_version, context_hash, response_version, response_text, analysis_json,
          citations_json, error_code, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET assistant_message_id = excluded.assistant_message_id,
          intent = excluded.intent, mode = excluded.mode, status = excluded.status,
          model_identity = excluded.model_identity, model_version = excluded.model_version,
          tool_schema_version = excluded.tool_schema_version, context_hash = excluded.context_hash,
          response_version = excluded.response_version, response_text = excluded.response_text,
          analysis_json = excluded.analysis_json, citations_json = excluded.citations_json,
          error_code = excluded.error_code, completed_at = excluded.completed_at
      `).run(run.id, run.conversationId, run.userMessageId, run.assistantMessageId ?? null, run.intent, run.mode,
        run.status, run.modelIdentity ?? null, run.modelVersion ?? null, run.toolSchemaVersion, run.contextHash,
        run.responseVersion, run.responseText ?? null, run.analysis ? JSON.stringify(run.analysis) : null,
        JSON.stringify(run.citations), run.errorCode ?? null, run.createdAt, run.completedAt ?? null);

      this.database.prepare("DELETE FROM agent_actions WHERE run_id = ?").run(run.id);
      this.database.prepare("DELETE FROM external_context_disclosures WHERE run_id = ?").run(run.id);
      this.database.prepare("DELETE FROM agent_tool_calls WHERE run_id = ?").run(run.id);
      for (const call of run.toolCalls) {
        this.database.prepare(`
          INSERT INTO agent_tool_calls(id, run_id, sequence, tool_name, tool_version, input_hash,
            input_refs_json, output_refs_json, status, error_code, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(call.id, call.runId, call.sequence, call.toolName, call.toolVersion, call.inputHash,
          JSON.stringify(call.inputRefs), JSON.stringify(call.outputRefs), call.status, call.errorCode ?? null,
          call.startedAt, call.finishedAt ?? null);
      }
      for (const action of run.actions) {
        this.database.prepare(`
          INSERT INTO agent_actions(id, run_id, tool_call_id, tool_name, tool_version, summary, payload_json,
            expected_revision, status, result_refs_json, error_code, created_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(action.id, action.runId, action.toolCallId, action.toolName, action.toolVersion, action.summary,
          JSON.stringify(action.payload), action.expectedRevision ?? null, action.status, JSON.stringify(action.resultRefs),
          action.errorCode ?? null, action.createdAt, action.resolvedAt ?? null);
      }
      if (run.disclosure) {
        const value = run.disclosure;
        this.database.prepare(`
          INSERT INTO external_context_disclosures(id, run_id, policy_version, categories_json,
            category_counts_json, context_hash, required, accepted_at, rejected_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(value.id, value.runId, value.policyVersion, JSON.stringify(value.categories),
          JSON.stringify(value.categoryCounts), value.contextHash, value.required ? 1 : 0,
          value.acceptedAt ?? null, value.rejectedAt ?? null, value.createdAt);
      }
      return this.getRun(run.id)!;
    })();
  }

  listModelCallAudits(runId: string): AgentModelCallAudit[] {
    return (this.database.prepare(
      "SELECT * FROM agent_model_calls WHERE run_id = ? ORDER BY sequence"
    ).all(runId) as Record<string, unknown>[]).map((row): AgentModelCallAudit => ({
      id: String(row.id), runId: String(row.run_id), sequence: Number(row.sequence),
      endpointOrigin: String(row.endpoint_origin), model: String(row.model),
      categories: JSON.parse(String(row.categories_json)), contextHash: String(row.context_hash),
      status: row.status as AgentModelCallAudit["status"], startedAt: String(row.started_at),
      ...(row.prompt_tokens !== null ? { promptTokens: Number(row.prompt_tokens) } : {}),
      ...(row.completion_tokens !== null ? { completionTokens: Number(row.completion_tokens) } : {}),
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
      ...(row.finished_at ? { finishedAt: String(row.finished_at) } : {})
    }));
  }

  saveModelCallAudit(audit: AgentModelCallAudit): AgentModelCallAudit {
    this.database.prepare(`
      INSERT INTO agent_model_calls(id, run_id, sequence, endpoint_origin, model, categories_json,
        context_hash, status, prompt_tokens, completion_tokens, error_code, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, prompt_tokens = excluded.prompt_tokens,
        completion_tokens = excluded.completion_tokens, error_code = excluded.error_code,
        finished_at = excluded.finished_at
    `).run(audit.id, audit.runId, audit.sequence, audit.endpointOrigin, audit.model,
      JSON.stringify(audit.categories), audit.contextHash, audit.status, audit.promptTokens ?? null,
      audit.completionTokens ?? null, audit.errorCode ?? null, audit.startedAt, audit.finishedAt ?? null);
    return this.listModelCallAudits(audit.runId).find(({ id }) => id === audit.id)!;
  }

  getSettings(): AgentModelSettings | undefined {
    const row = this.database.prepare("SELECT * FROM agent_model_settings WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      mode: row.mode as AgentModelSettings["mode"], consentPolicyVersion: Number(row.consent_policy_version),
      consentedDataCategories: JSON.parse(String(row.consented_categories_json)),
      ...(row.private_endpoint_json ? { privateEndpoint: JSON.parse(String(row.private_endpoint_json)) } : {}),
      ...(row.enhanced_endpoint_json ? { enhancedEndpoint: JSON.parse(String(row.enhanced_endpoint_json)) } : {})
    };
  }

  saveSettings(settings: AgentModelSettings, now: string): AgentModelSettings {
    this.database.prepare(`
      INSERT INTO agent_model_settings(singleton, mode, private_endpoint_json, enhanced_endpoint_json,
        consent_policy_version, consented_categories_json, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET mode = excluded.mode,
        private_endpoint_json = excluded.private_endpoint_json,
        enhanced_endpoint_json = excluded.enhanced_endpoint_json,
        consent_policy_version = excluded.consent_policy_version,
        consented_categories_json = excluded.consented_categories_json,
        updated_at = excluded.updated_at
    `).run(settings.mode, settings.privateEndpoint ? JSON.stringify(settings.privateEndpoint) : null,
      settings.enhancedEndpoint ? JSON.stringify(settings.enhancedEndpoint) : null,
      settings.consentPolicyVersion, JSON.stringify(settings.consentedDataCategories), now);
    return this.getSettings()!;
  }

  getCredential(mode: AgentExecutionMode): AgentCredentialEnvelope | undefined {
    const row = this.database.prepare("SELECT envelope_json FROM agent_credentials WHERE mode = ?")
      .get(mode) as { envelope_json: string } | undefined;
    return row ? JSON.parse(row.envelope_json) as AgentCredentialEnvelope : undefined;
  }

  saveCredential(mode: AgentExecutionMode, envelope: AgentCredentialEnvelope | undefined, now: string): void {
    if (!envelope) {
      this.database.prepare("DELETE FROM agent_credentials WHERE mode = ?").run(mode);
      return;
    }
    this.database.prepare(`
      INSERT INTO agent_credentials(mode, envelope_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(mode) DO UPDATE SET envelope_json = excluded.envelope_json, updated_at = excluded.updated_at
    `).run(mode, JSON.stringify(envelope), now);
  }

  withLlmConfigurationTransaction(write: () => LlmSettings): LlmSettings {
    return this.database.transaction(write)();
  }

  getLlmSettings(): LlmSettings | undefined {
    const row = this.database.prepare("SELECT active_provider FROM llm_settings WHERE singleton = 1")
      .get() as { active_provider: string | null } | undefined;
    if (!row) return undefined;
    const configs = this.database.prepare("SELECT * FROM llm_provider_settings ORDER BY provider")
      .all() as Record<string, unknown>[];
    const providers: LlmSettings["providers"] = {};
    for (const config of configs) {
      const provider = String(config.provider) as LlmProvider;
      providers[provider] = {
        provider, model: String(config.model), status: config.status as LlmProviderConfig["status"],
        credentialConfigured: Boolean(this.getLlmCredential(provider)),
        ...(config.region ? { region: String(config.region) as NonNullable<LlmProviderConfig["region"]> } : {}),
        ...(config.workspace_id ? { workspaceId: String(config.workspace_id) } : {}),
        ...(config.last_tested_at ? { lastTestedAt: String(config.last_tested_at) } : {}),
        ...(config.capabilities_json ? { capabilities: JSON.parse(String(config.capabilities_json)) as NonNullable<LlmProviderConfig["capabilities"]> } : {})
      };
    }
    return { ...(row.active_provider ? { activeProvider: row.active_provider as LlmProvider } : {}), providers };
  }

  saveLlmSettings(settings: LlmSettings, now: string): LlmSettings {
    this.database.prepare(`
      INSERT INTO llm_settings(singleton, active_provider, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET active_provider = excluded.active_provider, updated_at = excluded.updated_at
    `).run(settings.activeProvider ?? null, now);
    return this.getLlmSettings()!;
  }

  getLlmProviderConfig(provider: LlmProvider): LlmProviderConfig | undefined {
    const row = this.database.prepare("SELECT * FROM llm_provider_settings WHERE provider = ?")
      .get(provider) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      provider, model: String(row.model), status: row.status as LlmProviderConfig["status"],
      credentialConfigured: Boolean(this.getLlmCredential(provider)),
      ...(row.region ? { region: String(row.region) as NonNullable<LlmProviderConfig["region"]> } : {}),
      ...(row.workspace_id ? { workspaceId: String(row.workspace_id) } : {}),
      ...(row.last_tested_at ? { lastTestedAt: String(row.last_tested_at) } : {}),
      ...(row.capabilities_json ? { capabilities: JSON.parse(String(row.capabilities_json)) as NonNullable<LlmProviderConfig["capabilities"]> } : {})
    };
  }

  saveLlmProviderConfig(config: LlmProviderConfig, now: string): void {
    this.database.prepare(`
      INSERT INTO llm_provider_settings(provider, model, region, workspace_id, status, last_tested_at, capabilities_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET model = excluded.model, region = excluded.region,
        workspace_id = excluded.workspace_id, status = excluded.status,
        last_tested_at = excluded.last_tested_at, capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at
    `).run(config.provider, config.model, config.region ?? null, config.workspaceId ?? null,
      config.status, config.lastTestedAt ?? null, config.capabilities ? JSON.stringify(config.capabilities) : null, now);
  }

  deleteLlmProviderConfig(provider: LlmProvider): void {
    this.database.prepare("DELETE FROM llm_provider_settings WHERE provider = ?").run(provider);
  }

  getLlmCredential(provider: LlmProvider): AgentCredentialEnvelope | undefined {
    const row = this.database.prepare("SELECT envelope_json FROM llm_provider_credentials WHERE provider = ?")
      .get(provider) as { envelope_json: string } | undefined;
    return row ? JSON.parse(row.envelope_json) as AgentCredentialEnvelope : undefined;
  }

  saveLlmCredential(provider: LlmProvider, envelope: AgentCredentialEnvelope | undefined, now: string): void {
    if (!envelope) {
      this.database.prepare("DELETE FROM llm_provider_credentials WHERE provider = ?").run(provider);
      return;
    }
    this.database.prepare(`
      INSERT INTO llm_provider_credentials(provider, envelope_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET envelope_json = excluded.envelope_json, updated_at = excluded.updated_at
    `).run(provider, JSON.stringify(envelope), now);
  }
}

export class SqliteWorkspaceDatabase {
  readonly assets: SqliteAssetRepository;
  readonly jobs: SqliteJobRepository;
  readonly memory: SqliteMemoryRepository;
  readonly dayOne: SqliteDayOneRepository;
  readonly agents: SqliteAgentRepository;
  readonly phase5: SqlitePhaseFiveRepository;
  readonly phase6: SqlitePhaseSixRepository;
  readonly records: SqliteRecordRepository;

  constructor(readonly database: Database.Database, pendingKey: () => VaultKey) {
    this.assets = new SqliteAssetRepository(database);
    this.jobs = new SqliteJobRepository(database);
    this.memory = new SqliteMemoryRepository(database);
    this.dayOne = new SqliteDayOneRepository(database, this.memory);
    this.agents = new SqliteAgentRepository(database);
    this.phase5 = new SqlitePhaseFiveRepository(database, this.memory);
    this.phase6 = new SqlitePhaseSixRepository(database, this.memory);
    this.records = new SqliteRecordRepository(database, pendingKey);
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
    const hasAvailability = Boolean(database.prepare("SELECT 1 FROM pragma_table_info('assets') WHERE name = 'availability_status'").get());
    const assets = database.prepare(hasAvailability
      ? "SELECT sha256 FROM assets WHERE availability_status != 'deleted' ORDER BY sha256"
      : "SELECT sha256 FROM assets ORDER BY sha256").all() as Array<{ sha256: string }>;
    const hasDerived = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'derived_artifacts'").get());
    const derived = hasDerived
      ? database.prepare("SELECT sha256 FROM derived_artifacts ORDER BY sha256").all() as Array<{ sha256: string }>
      : [];
    return { workspaceId: workspace.workspace_id, assetHashes: [...new Set([...assets, ...derived].map(({ sha256 }) => sha256))].sort() };
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
