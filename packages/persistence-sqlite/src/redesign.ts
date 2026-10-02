import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AnalysisReport,
  AnalysisReportContent,
  Asset,
  EventCategory,
  EventRecord,
  EventRecordDetail,
  FieldOverride,
  PendingReview,
  RecordSearchPage,
  RecordSearchFragment,
  RecordSearchGeneration,
  RecordSearchModality,
  RecordSearchQuery,
  RetainedSource,
  ScreenAndSaveResult,
  TimelineFilter,
  TimelinePage
} from "@grudge-vault/domain";
import type { RecordCommitInput, RecordRepositoryPort, VaultKey } from "@grudge-vault/application";
import { AppError, findCaseInsensitiveTextRange, projectRecordDate, projectRecordOccurrence, resolveRecordDateFilter,
  reportContentSearchText, type RecordOccurrenceProjection } from "@grudge-vault/shared";

function json<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

function mapRecord(row: Record<string, unknown>): EventRecord {
  const occurrence = row.date_projection_json
    ? json<{ occurrence: RecordOccurrenceProjection }>(row.date_projection_json).occurrence
    : row.occurrence_projection_json ? json<RecordOccurrenceProjection>(row.occurrence_projection_json) : undefined;
  return {
    id: String(row.id), origin: row.origin as EventRecord["origin"],
    categories: json<EventCategory[]>(row.categories_json), title: String(row.title), summary: String(row.summary),
    revision: Number(row.revision), occurredAt: occurrence?.value ?? json<EventRecord["occurredAt"]>(row.occurred_at_json),
    ...(occurrence?.source ? { occurredAtSource: occurrence.source } : {}),
    ...(occurrence?.precision ? { occurredAtPrecision: occurrence.precision } : {}),
    recordedAt: String(row.recorded_at), reportState: row.report_state as EventRecord["reportState"],
    sourceUpdated: Boolean(row.source_updated), sourceReviewRequired: Boolean(row.source_review_required),
    attachmentCount: Number(row.attachment_count ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function mapSource(row: Record<string, unknown>): RetainedSource {
  const source: RetainedSource = {
    id: String(row.id), recordId: String(row.record_id), origin: row.origin as RetainedSource["origin"],
    sourceVersion: String(row.source_version), contentHash: String(row.content_hash),
    recordedAt: String(row.recorded_at), createdAt: String(row.created_at)
  };
  if (row.connector_id) source.connectorId = String(row.connector_id);
  if (row.journal_id) source.journalId = String(row.journal_id);
  if (row.entry_id) source.entryId = String(row.entry_id);
  if (row.text !== null && row.text !== undefined) source.text = String(row.text);
  return source;
}

function mapAsset(row: Record<string, unknown>): Asset {
  const asset: Asset = {
    id: String(row.id), sha256: String(row.sha256), byteSize: Number(row.byte_size),
    mimeType: String(row.mime_type), originalFileName: String(row.original_file_name),
    vaultFormat: Number(row.vault_format), integrityStatus: row.integrity_status as Asset["integrityStatus"],
    availabilityStatus: row.availability_status as Asset["availabilityStatus"], createdAt: String(row.created_at)
  };
  if (row.verified_at) asset.verifiedAt = String(row.verified_at);
  if (row.superseded_by_asset_id) asset.supersededByAssetId = String(row.superseded_by_asset_id);
  if (row.deleted_at) asset.deletedAt = String(row.deleted_at);
  return asset;
}

function mapReport(row: Record<string, unknown>): AnalysisReport {
  const report: AnalysisReport = {
    id: String(row.id), recordId: String(row.record_id), recordRevision: Number(row.record_revision),
    inputHash: String(row.input_hash), promptVersion: String(row.prompt_version), modelProfile: String(row.model_profile),
    content: json<AnalysisReportContent>(row.content_json), state: row.state as AnalysisReport["state"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.analysis_run_id) report.analysisRunId = String(row.analysis_run_id);
  if (row.error_code) report.errorCode = String(row.error_code);
  return report;
}

function mapOverride(row: Record<string, unknown>): FieldOverride {
  const value: FieldOverride = {
    id: String(row.id), recordId: String(row.record_id), fieldKey: row.field_key as FieldOverride["fieldKey"],
    value: json(row.value_json), actor: "user", revision: Number(row.revision),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.basis) value.basis = String(row.basis);
  return value;
}

type PendingSensitive = Pick<PendingReview, "originLocator" | "excerpt" | "reason" | "categories">;

function pendingSensitive(row: Record<string, unknown>): PendingSensitive {
  return {
    ...(row.origin_locator ? { originLocator: String(row.origin_locator) } : {}),
    excerpt: String(row.excerpt), reason: String(row.reason), categories: json<EventCategory[]>(row.categories_json)
  };
}

function pendingKey(value: VaultKey, keyId?: string): { id: string; key: Buffer } {
  if (Buffer.isBuffer(value)) {
    if (keyId && keyId !== "single") throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "无法解锁待确认项。", true);
    if (value.length !== 32) throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "待确认项密钥无效。", true);
    return { id: "single", key: value };
  }
  const id = keyId ?? value.activeKeyId;
  const key = value.keys.get(id);
  if (!key || key.length !== 32) throw new AppError("WORKSPACE_KEY_UNAVAILABLE", "无法解锁待确认项。", true);
  return { id, key };
}

function sealPending(id: string, value: PendingSensitive, keyring: VaultKey, targetKeyId?: string): string {
  const { id: keyId, key } = pendingKey(keyring, targetKeyId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`redesign-pending:${id}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v1:${keyId}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

function openPending(id: string, sealed: string, keyring: VaultKey): PendingSensitive {
  try {
    const parts = sealed.split(":", 3);
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported pending payload.");
    const { key } = pendingKey(keyring, parts[1]);
    const payload = Buffer.from(parts[2]!, "base64url");
    if (payload.length < 29) throw new Error("Truncated pending payload.");
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
    decipher.setAAD(Buffer.from(`redesign-pending:${id}`, "utf8"));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")) as PendingSensitive;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("WORKSPACE_INVALID", "待确认项加密内容已损坏。", false, { cause });
  }
}

function mapSearchGeneration(row: Record<string, unknown>): RecordSearchGeneration {
  const value: RecordSearchGeneration = {
    id: String(row.id), adapterIdentity: String(row.adapter_identity), adapterVersion: Number(row.adapter_version),
    dimensions: Number(row.dimensions), normalization: row.normalization as RecordSearchGeneration["normalization"],
    inputModalities: json<RecordSearchModality[]>(row.input_modalities_json),
    state: row.state as RecordSearchGeneration["state"], fragmentCount: Number(row.fragment_count),
    createdAt: String(row.created_at)
  };
  if (row.last_error) value.lastError = String(row.last_error);
  if (row.activated_at) value.activatedAt = String(row.activated_at);
  return value;
}

function encodeCursor(sortKey: string, id: string, timeZone: string): string {
  return Buffer.from(JSON.stringify({ version: 2, sortKey, id, timeZone }), "utf8").toString("base64url");
}

function decodeCursor(value: string, timeZone: string): [string, string] {
  try {
    if (value.length > 1_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded?.version !== 2 || decoded.timeZone !== timeZone ||
      typeof decoded.sortKey !== "string" || !/^\d{9}:\d{15}$/.test(decoded.sortKey) ||
      typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 100) throw new Error("invalid");
    return [decoded.sortKey, decoded.id];
  } catch {
    throw new AppError("INVALID_INPUT", "分页游标无效或时区已变化，请重新载入。");
  }
}

function ftsQuery(value: string): string {
  return value.trim().split(/\s+/).filter(Boolean).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function reportSearchText(report: AnalysisReport | undefined): string {
  return report ? reportContentSearchText(report.content) : "";
}

const RECORD_SORT_AT_SQL = "json_extract(r.date_projection_json, '$.sortKey')";
const CURRENT_REPORT_TIME_SQL = `(SELECT json_extract(p.content_json, '$.time') FROM redesign_reports p
  WHERE p.record_id = r.id AND p.record_revision = r.revision AND p.state IN ('complete', 'partial')
  ORDER BY (p.state = 'complete') DESC, p.updated_at DESC, p.rowid DESC LIMIT 1)`;
const USER_TIME_SQL = "EXISTS (SELECT 1 FROM redesign_field_overrides o WHERE o.record_id = r.id AND o.field_key = 'occurredAt')";
const OCCURRENCE_SQL = `gv_record_occurrence(r.occurred_at_json, ${CURRENT_REPORT_TIME_SQL}, ${USER_TIME_SQL})`;

const CURRENT_ATTACHMENT_COUNT_SQL = `(SELECT count(*) FROM redesign_record_assets ra
  WHERE ra.record_id = r.id AND ra.source_id = (
    SELECT s.id FROM redesign_sources s WHERE s.record_id = r.id
    ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1
  ))`;

export class SqliteRecordRepository implements RecordRepositoryPort {
  private searchGenerationShapeStatement?: Database.Statement;
  private searchEmbeddingWriteStatement?: Database.Statement;
  private searchProjectionVersionStatement?: Database.Statement;

  constructor(private readonly database: Database.Database, private readonly getPendingKey: () => VaultKey) {
    this.database.pragma("secure_delete = ON");
    const occurrence = (stored: unknown, report: unknown, user: unknown) => projectRecordOccurrence(
      json(stored), report === null || report === undefined ? undefined : json(report), Boolean(user)
    );
    this.database.function("gv_record_occurrence", { deterministic: true }, (stored, report, user) => {
      try { return JSON.stringify(occurrence(stored, report, user)); }
      catch { throw new AppError("WORKSPACE_INVALID", "无法读取记录时间，请检查工作区。"); }
    });
    this.database.function("gv_record_date", { deterministic: true }, (occurredAt, recordedAt, timeZone, report, user) => {
      try {
        const time = occurrence(occurredAt, report, user);
        const projection = projectRecordDate({ occurredAt: time.value, recordedAt: String(recordedAt) }, String(timeZone));
        if (projection) return JSON.stringify({ ...projection, occurrence: time });
      } catch { /* Do not include stored values in diagnostics. */ }
      throw new AppError("WORKSPACE_INVALID", "无法读取记录日期，请检查工作区。");
    });
  }

  private dateRows(filter: TimelineFilter, conditions: string[] = [], values: unknown[] = []): {
    rows: Record<string, unknown>[]; limit: number; timeZone: string;
  } {
    const dates = resolveRecordDateFilter(filter);
    if (!dates) throw new AppError("INVALID_INPUT", "日期范围或时区无效。");
    const limit = Math.max(1, Math.min(filter.limit ?? 30, 100));
    if (filter.origin) { conditions.push("r.origin = ?"); values.push(filter.origin); }
    if (filter.category) { conditions.push("EXISTS (SELECT 1 FROM json_each(r.categories_json) WHERE value = ?)"); values.push(filter.category); }
    const dateConditions: string[] = [];
    const dateValues: unknown[] = [];
    if (dates.fromDay !== undefined) {
      dateConditions.push("(json_extract(r.date_projection_json, '$.upperDay') IS NULL OR json_extract(r.date_projection_json, '$.upperDay') >= ?)");
      dateValues.push(dates.fromDay);
    }
    if (dates.toDay !== undefined) {
      dateConditions.push("(json_extract(r.date_projection_json, '$.lowerDay') IS NULL OR json_extract(r.date_projection_json, '$.lowerDay') <= ?)");
      dateValues.push(dates.toDay);
    }
    if (filter.cursor) {
      const [sortKey, id] = decodeCursor(filter.cursor, dates.timeZone);
      dateConditions.push(`(${RECORD_SORT_AT_SQL} < ? OR (${RECORD_SORT_AT_SQL} = ? AND r.id < ?))`);
      dateValues.push(sortKey, sortKey, id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const dateWhere = dateConditions.length ? `WHERE ${dateConditions.join(" AND ")}` : "";
    // One ephemeral projection per candidate. Nothing is written back or given invented precision.
    const rows = this.database.prepare(`
      WITH dated_records AS MATERIALIZED (
        SELECT r.*, gv_record_date(r.occurred_at_json, r.recorded_at, ?, ${CURRENT_REPORT_TIME_SQL}, ${USER_TIME_SQL}) AS date_projection_json
        FROM redesign_records r ${where}
      )
      SELECT r.*, ${RECORD_SORT_AT_SQL} AS sort_at, ${CURRENT_ATTACHMENT_COUNT_SQL} AS attachment_count
      FROM dated_records r ${dateWhere} ORDER BY sort_at DESC, r.id DESC LIMIT ?
    `).all(dates.timeZone, ...values, ...dateValues, limit + 1) as Record<string, unknown>[];
    return { rows, limit, timeZone: dates.timeZone };
  }

  ensureKeywordProjection(): void {
    const key = "redesign.keyword-projection-v2";
    const current = this.database.prepare("SELECT value_json FROM workspace_settings WHERE key = ?").get(key) as
      { value_json: string } | undefined;
    if (current?.value_json === "2") return;
    try {
      this.database.transaction(() => {
        // Only retained formal records are projected. No screening, model calls or new jobs.
        const first = this.database.prepare("SELECT id FROM redesign_records ORDER BY id LIMIT 256");
        const next = this.database.prepare("SELECT id FROM redesign_records WHERE id > ? ORDER BY id LIMIT 256");
        let afterId: string | undefined;
        while (true) {
          // Finish each read before FTS writes; a live SQLite iterator prohibits writes.
          const rows = (afterId === undefined ? first.all() : next.all(afterId)) as Array<{ id: string }>;
          if (!rows.length) break;
          for (const row of rows) this.reindex(row.id);
          afterId = rows[rows.length - 1]!.id;
        }
        this.database.prepare(`
          INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, '2', ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run(key, new Date().toISOString());
      })();
    } catch (cause) {
      throw new AppError("WORKSPACE_INVALID", "无法更新本地关键词索引，请重试打开工作区。", true, { cause });
    }
  }

  sealExistingPending(): void {
    const plaintextRows = this.database.prepare(`
      SELECT * FROM redesign_pending_reviews WHERE sealed_payload IS NULL
    `).all() as Record<string, unknown>[];
    const state = this.database.prepare("SELECT cleanup_required FROM redesign_pending_seal_state WHERE id = 1")
      .get() as { cleanup_required: number } | undefined;
    if (!state) throw new AppError("WORKSPACE_INVALID", "待确认项加密迁移状态缺失。", false);
    if (!plaintextRows.length && state.cleanup_required === 0) return;
    if (plaintextRows.length) {
      this.database.transaction(() => {
        const update = this.database.prepare(`
          UPDATE redesign_pending_reviews SET origin_locator = NULL, excerpt = '', reason = '',
            categories_json = '[]', sealed_payload = ? WHERE id = ?
        `);
        for (const row of plaintextRows) {
          update.run(sealPending(String(row.id), pendingSensitive(row), this.getPendingKey()), row.id);
        }
        this.database.prepare("UPDATE redesign_pending_seal_state SET cleanup_required = 1 WHERE id = 1").run();
      })();
    }
    // Old plaintext can survive in free pages or a WAL after an UPDATE.
    const checkpoint = () => {
      const result = this.database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      if (result[0]?.busy) throw new AppError("WORKSPACE_INVALID", "无法清理旧待确认项的数据库日志。", true);
    };
    checkpoint();
    this.database.exec("VACUUM");
    checkpoint();
    this.database.prepare("UPDATE redesign_pending_seal_state SET cleanup_required = 0 WHERE id = 1").run();
  }

  private mapPending(row: Record<string, unknown>): PendingReview {
    if (!row.sealed_payload) throw new AppError("WORKSPACE_INVALID", "待确认项尚未完成加密迁移。", false);
    const sensitive = openPending(String(row.id), String(row.sealed_payload), this.getPendingKey());
    return {
      id: String(row.id), origin: row.origin as PendingReview["origin"],
      ...(sensitive.originLocator ? { originLocator: sensitive.originLocator } : {}),
      sourceVersion: String(row.source_version), excerpt: sensitive.excerpt, reason: sensitive.reason,
      categories: sensitive.categories, coverage: row.coverage as PendingReview["coverage"],
      sessionAvailable: false, createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    };
  }

  reencryptPending(targetKeyId: string): void {
    const rows = this.database.prepare("SELECT id, sealed_payload FROM redesign_pending_reviews").all() as
      Array<{ id: string; sealed_payload: string }>;
    this.database.transaction(() => {
      const update = this.database.prepare("UPDATE redesign_pending_reviews SET sealed_payload = ? WHERE id = ?");
      const keyring = this.getPendingKey();
      for (const row of rows) {
        const sensitive = openPending(row.id, row.sealed_payload, keyring);
        update.run(sealPending(row.id, sensitive, keyring, targetKeyId), row.id);
      }
    })();
  }

  findOperation(operationId: string): ScreenAndSaveResult | undefined {
    const row = this.database.prepare("SELECT result_json FROM redesign_operations WHERE operation_id = ?").get(operationId) as { result_json: string } | undefined;
    return row ? json<ScreenAndSaveResult>(row.result_json) : undefined;
  }

  findRecordBySource(connectorId: string, journalId: string, entryId: string): EventRecordDetail | undefined {
    const row = this.database.prepare(`
      SELECT record_id FROM redesign_sources
      WHERE connector_id = ? AND journal_id = ? AND entry_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(connectorId, journalId, entryId) as { record_id: string } | undefined;
    return row ? this.getRecord(row.record_id) : undefined;
  }

  markSourceChanged(recordId: string, now: string): EventRecordDetail {
    return this.database.transaction(() => {
      const current = this.getRecordRequired(recordId);
      if (current.record.sourceReviewRequired) return current;
      const revision = current.record.revision + 1;
      const result = this.database.prepare(`
        UPDATE redesign_records SET source_updated = 1, source_review_required = 1,
          report_state = 'stale', revision = ?, updated_at = ? WHERE id = ?
      `).run(revision, now, recordId);
      if (result.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "记录不存在。");
      this.saveRevision(recordId, revision, "source", "来源出现未收录的新版本", now);
      return this.getRecordRequired(recordId);
    })();
  }

  commitRecord(input: RecordCommitInput): EventRecord {
    return this.database.transaction(() => {
      const existing = this.findOperation(input.operationId);
      if (existing?.kind === "saved") return this.getRecordRequired(existing.recordId).record;
      if (existing) throw new AppError("REVISION_CONFLICT", "这个操作已经产生了不同结果。");
      const prior = input.source.connectorId && input.source.journalId && input.source.entryId
        ? this.findRecordBySource(input.source.connectorId, input.source.journalId, input.source.entryId)
        : undefined;
      if (prior?.source.sourceVersion === input.source.sourceVersion) {
        const duplicateResult: ScreenAndSaveResult = { kind: "saved", recordId: prior.record.id, reportState: "queued" };
        this.database.prepare("INSERT INTO redesign_operations(operation_id, result_json, entity_id, created_at) VALUES (?, ?, ?, ?)")
          .run(input.operationId, JSON.stringify(duplicateResult), prior.record.id, input.record.createdAt);
        return prior.record;
      }

      const recordId = prior?.record.id ?? input.record.id;
      const revision = prior ? prior.record.revision + 1 : input.record.revision;
      if (prior) {
        const overrides = new Set((this.database.prepare(
          "SELECT field_key FROM redesign_field_overrides WHERE record_id = ?"
        ).all(recordId) as Array<{ field_key: string }>).map(({ field_key }) => field_key));
        this.database.prepare(`
          UPDATE redesign_records SET origin = ?, categories_json = ?, title = ?, summary = ?, revision = ?,
            occurred_at_json = ?, recorded_at = ?, report_state = 'queued',
            source_updated = 1, source_review_required = 0, updated_at = ?
          WHERE id = ?
        `).run(input.record.origin, JSON.stringify(input.record.categories),
          overrides.has("title") ? prior.record.title : input.record.title, input.record.summary, revision,
          JSON.stringify(overrides.has("occurredAt") ? prior.record.occurredAt : input.record.occurredAt),
          input.record.recordedAt, input.record.updatedAt, recordId);
      } else {
        this.database.prepare(`
          INSERT INTO redesign_records(
            id, origin, categories_json, title, summary, revision, occurred_at_json, recorded_at,
            report_state, source_updated, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(recordId, input.record.origin, JSON.stringify(input.record.categories), input.record.title,
          input.record.summary, revision, JSON.stringify(input.record.occurredAt), input.record.recordedAt,
          input.record.reportState, input.record.createdAt, input.record.updatedAt);
      }
      this.database.prepare(`
        INSERT INTO redesign_sources(
          id, record_id, origin, connector_id, journal_id, entry_id, source_version,
          content_hash, text, recorded_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.source.id, recordId, input.source.origin, input.source.connectorId ?? null,
        input.source.journalId ?? null, input.source.entryId ?? null, input.source.sourceVersion,
        input.source.contentHash, input.source.text ?? null, input.source.recordedAt, input.source.createdAt);
      const storedAssetIds = new Map<string, string>();
      for (const candidate of input.attachments) {
        const inserted = this.database.prepare(`
          INSERT INTO assets(id, sha256, byte_size, mime_type, original_file_name, vault_format,
            integrity_status, verified_at, availability_status, superseded_by_asset_id, deleted_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sha256) DO NOTHING
        `).run(candidate.id, candidate.sha256, candidate.byteSize, candidate.mimeType, candidate.originalFileName,
          candidate.vaultFormat, candidate.integrityStatus, candidate.verifiedAt ?? null,
          candidate.availabilityStatus, candidate.supersededByAssetId ?? null, candidate.deletedAt ?? null, candidate.createdAt);
        const stored = this.database.prepare("SELECT id FROM assets WHERE sha256 = ?").get(candidate.sha256) as { id: string };
        storedAssetIds.set(candidate.id, stored.id);
        this.database.prepare(`
          INSERT INTO redesign_record_assets(record_id, source_id, asset_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING
        `).run(recordId, input.source.id, stored.id);
        if (inserted.changes === 1) {
          this.database.prepare(`
            INSERT INTO jobs(id, type, payload_json, state, progress, attempts, max_attempts, available_at, lease_until, last_error, created_at, updated_at)
            VALUES (?, 'asset.verify', ?, 'queued', 0, 0, 3, ?, NULL, NULL, ?, ?)
          `).run(randomUUID(), JSON.stringify({ assetId: stored.id, sha256: candidate.sha256 }),
            input.record.createdAt, input.record.createdAt, input.record.createdAt);
        }
      }
      this.database.prepare(`
        INSERT INTO redesign_screening_results(
          id, record_id, record_revision, decision, categories_json, reason, anchors_json, coverage, policy_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), recordId, revision, input.screening.decision, JSON.stringify(input.screening.categories), input.screening.reason,
        JSON.stringify(input.screening.anchors.map((anchor) => ({
          ...anchor,
          ...(anchor.assetId ? { assetId: storedAssetIds.get(anchor.assetId) ?? anchor.assetId } : {})
        }))), input.screening.coverage, input.screening.policyVersion, input.record.createdAt);
      const result: ScreenAndSaveResult = { kind: "saved", recordId, reportState: "queued" };
      this.database.prepare("INSERT INTO redesign_operations(operation_id, result_json, entity_id, created_at) VALUES (?, ?, ?, ?)")
        .run(input.operationId, JSON.stringify(result), recordId, input.record.createdAt);
      this.database.prepare(`
        INSERT INTO jobs(id, type, payload_json, state, progress, attempts, max_attempts, available_at, lease_until, last_error, created_at, updated_at)
        VALUES (?, 'record.analyze', ?, 'queued', 0, 0, 4, ?, NULL, NULL, ?, ?)
      `).run(input.analysisJob.id, JSON.stringify({ recordId, recordRevision: revision }),
        input.analysisJob.createdAt, input.analysisJob.createdAt, input.analysisJob.createdAt);
      if (input.legacyMigration) {
        this.database.prepare(`
          INSERT INTO redesign_migration_map(
            source_workspace_id, legacy_entity_id, record_id, revision_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_workspace_id, legacy_entity_id) DO UPDATE SET
            record_id = excluded.record_id, revision_count = excluded.revision_count, updated_at = excluded.updated_at
        `).run(input.legacyMigration.sourceWorkspaceId, input.legacyMigration.legacyEntityId, recordId,
          input.legacyMigration.revisions.length, input.record.createdAt, input.record.createdAt);
        for (const legacy of input.legacyMigration.revisions) {
          this.database.prepare(`
            INSERT INTO redesign_legacy_revisions(
              id, record_id, source_workspace_id, legacy_entity_id, legacy_revision,
              snapshot_json, actor, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_workspace_id, legacy_entity_id, legacy_revision) DO NOTHING
          `).run(randomUUID(), recordId, input.legacyMigration.sourceWorkspaceId,
            input.legacyMigration.legacyEntityId, legacy.revision, JSON.stringify(legacy.snapshot),
            legacy.actor, legacy.reason, legacy.createdAt);
        }
      }
      this.reindex(recordId);
      this.saveRevision(
        recordId,
        revision,
        "source",
        prior ? "来源版本更新并重新收录" : "正式收录",
        input.record.createdAt
      );
      return this.getRecordRequired(recordId).record;
    })();
  }

  createPending(item: PendingReview, operationId: string): PendingReview {
    return this.database.transaction(() => {
      const existing = this.findOperation(operationId);
      if (existing?.kind === "needs_review") return this.getPendingRequired(existing.pendingId);
      if (existing) throw new AppError("REVISION_CONFLICT", "这个操作已经产生了不同结果。");
      this.database.prepare(`
        INSERT INTO redesign_pending_reviews(
          id, origin, origin_locator, source_version, excerpt, reason, categories_json, coverage, created_at, updated_at,
          sealed_payload
        ) VALUES (?, ?, NULL, ?, '', '', '[]', ?, ?, ?, ?)
      `).run(item.id, item.origin, item.sourceVersion, item.coverage, item.createdAt, item.updatedAt,
        sealPending(item.id, item, this.getPendingKey()));
      const result: ScreenAndSaveResult = { kind: "needs_review", pendingId: item.id };
      this.database.prepare("INSERT INTO redesign_operations(operation_id, result_json, entity_id, created_at) VALUES (?, ?, ?, ?)")
        .run(operationId, JSON.stringify(result), item.id, item.createdAt);
      return item;
    })();
  }

  listPending(): PendingReview[] {
    return (this.database.prepare("SELECT * FROM redesign_pending_reviews ORDER BY created_at DESC, id DESC").all() as Record<string, unknown>[])
      .map((row) => this.mapPending(row));
  }

  getPending(id: string): PendingReview | undefined {
    const row = this.database.prepare("SELECT * FROM redesign_pending_reviews WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapPending(row) : undefined;
  }

  deletePending(id: string): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM redesign_operations WHERE entity_id = ?").run(id);
      const deleted = this.database.prepare("DELETE FROM redesign_pending_reviews WHERE id = ?").run(id);
      if (deleted.changes !== 1) throw new AppError("ENTITY_NOT_FOUND", "待确认项不存在。");
    })();
  }

  listTimeline(filter: TimelineFilter): TimelinePage {
    const { rows, limit, timeZone } = this.dateRows(filter);
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map(mapRecord);
    const last = rows[Math.min(rows.length, limit) - 1];
    return { records, ...(hasMore && last ? { nextCursor: encodeCursor(String(last.sort_at), String(last.id), timeZone) } : {}) };
  }

  getRecord(id: string): EventRecordDetail | undefined {
    const row = this.database.prepare(`
      SELECT r.*, ${OCCURRENCE_SQL} AS occurrence_projection_json, ${CURRENT_ATTACHMENT_COUNT_SQL} AS attachment_count
      FROM redesign_records r WHERE r.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const sourceRow = this.database.prepare("SELECT * FROM redesign_sources WHERE record_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as Record<string, unknown>;
    const assets = (this.database.prepare(`
      SELECT a.* FROM assets a JOIN redesign_record_assets ra ON ra.asset_id = a.id
      WHERE ra.record_id = ? AND ra.source_id = ? ORDER BY a.created_at, a.id
    `).all(id, String(sourceRow.id)) as Record<string, unknown>[]).map(mapAsset);
    const reportRow = this.database.prepare(`
      SELECT * FROM redesign_reports WHERE record_id = ? AND state IN ('complete','partial')
      ORDER BY (record_revision = ?) DESC, record_revision DESC,
        (state = 'complete') DESC, updated_at DESC, rowid DESC LIMIT 1
    `).get(id, Number(row.revision)) as Record<string, unknown> | undefined;
    const overrides = (this.database.prepare("SELECT * FROM redesign_field_overrides WHERE record_id = ? ORDER BY field_key").all(id) as Record<string, unknown>[]).map(mapOverride);
    return {
      record: mapRecord(row), source: mapSource(sourceRow), attachments: assets, overrides,
      ...(reportRow ? { report: mapReport(reportRow) } : {})
    };
  }

  patchFields(recordId: string, expectedRevision: number, patch: Partial<Record<FieldOverride["fieldKey"], unknown>>, now: string): EventRecordDetail {
    return this.database.transaction(() => {
      const detail = this.getRecordRequired(recordId);
      if (detail.record.revision !== expectedRevision) throw new AppError("REVISION_CONFLICT", "记录已更新，请重新载入后再保存。");
      const entries = Object.entries(patch).filter((entry) => entry[1] !== undefined) as Array<[FieldOverride["fieldKey"], unknown]>;
      if (entries.length === 0) throw new AppError("INVALID_INPUT", "没有可保存的补充内容。");
      const allowed = new Set<FieldOverride["fieldKey"]>(["title", "occurredAt", "location", "jurisdiction", "clarifications"]);
      if (entries.some(([key]) => !allowed.has(key))) throw new AppError("INVALID_INPUT", "补充字段无效。");
      if (patch.clarifications !== undefined) {
        const clarifications = patch.clarifications;
        if (!Array.isArray(clarifications) || clarifications.length < 1 || clarifications.length > 100 ||
          clarifications.some((item) => !item || typeof item !== "object" ||
            !["unknown", "dispute", "speculation"].includes((item as { kind?: string }).kind ?? "") ||
            typeof (item as { topic?: unknown }).topic !== "string" ||
            !(item as { topic: string }).topic.trim() || (item as { topic: string }).topic.length > 1_000 ||
            typeof (item as { response?: unknown }).response !== "string" ||
            !(item as { response: string }).response.trim() || (item as { response: string }).response.length > 2_000)) {
          throw new AppError("INVALID_INPUT", "逐项补充内容无效。");
        }
        const keys = clarifications.map((item) => {
          const value = item as { kind: string; topic: string };
          return `${value.kind}\0${value.topic}`;
        });
        if (new Set(keys).size !== keys.length) throw new AppError("INVALID_INPUT", "逐项补充不能重复。");
        if (clarifications.reduce((total, item) => {
          const value = item as { topic: string; response: string };
          return total + value.topic.length + value.response.length;
        }, 0) > 50_000) throw new AppError("INVALID_INPUT", "逐项补充超过输入上限。");
      }
      const revision = expectedRevision + 1;
      for (const [key, value] of entries) {
        this.database.prepare(`
          INSERT INTO redesign_field_overrides(id, record_id, field_key, value_json, actor, revision, basis, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'user', ?, NULL, ?, ?)
          ON CONFLICT(record_id, field_key) DO UPDATE SET value_json = excluded.value_json,
            revision = excluded.revision, updated_at = excluded.updated_at
        `).run(randomUUID(), recordId, key, JSON.stringify(value), revision, now, now);
      }
      const title = patch.title === undefined ? detail.record.title : String(patch.title).trim();
      if (!title || title.length > 200) throw new AppError("INVALID_INPUT", "标题长度无效。");
      // Other edits must not materialize the AI/date projection as stored source data.
      const occurredAt = patch.occurredAt === undefined
        ? json(this.database.prepare("SELECT occurred_at_json FROM redesign_records WHERE id = ?").pluck().get(recordId))
        : patch.occurredAt;
      this.database.prepare(`
        UPDATE redesign_records SET title = ?, occurred_at_json = ?, revision = ?, report_state = 'stale', updated_at = ? WHERE id = ?
      `).run(title, JSON.stringify(occurredAt), revision, now, recordId);
      this.reindex(recordId);
      this.saveRevision(recordId, revision, "user", `用户补充：${entries.map(([key]) => key).join("、")}`, now);
      return this.getRecordRequired(recordId);
    })();
  }

  enqueueAnalysis(recordId: string, expectedRevision: number, jobId: string, now: string): string {
    return this.database.transaction(() => {
      const detail = this.getRecordRequired(recordId);
      if (detail.record.revision !== expectedRevision) throw new AppError("REVISION_CONFLICT", "记录已更新，请重新载入后再分析。");
      const existing = this.database.prepare(`
        SELECT id FROM jobs WHERE type = 'record.analyze' AND state IN ('queued','running')
          AND json_extract(payload_json, '$.recordId') = ? AND json_extract(payload_json, '$.recordRevision') = ? LIMIT 1
      `).get(recordId, expectedRevision) as { id: string } | undefined;
      if (existing) return existing.id;
      this.database.prepare(`
        INSERT INTO jobs(id, type, payload_json, state, progress, attempts, max_attempts, available_at, lease_until, last_error, created_at, updated_at)
        VALUES (?, 'record.analyze', ?, 'queued', 0, 0, 4, ?, NULL, NULL, ?, ?)
      `).run(jobId, JSON.stringify({ recordId, recordRevision: expectedRevision }), now, now, now);
      this.database.prepare("UPDATE redesign_records SET report_state = 'queued', updated_at = ? WHERE id = ?").run(now, recordId);
      return jobId;
    })();
  }

  markAnalysisRunning(recordId: string, expectedRevision: number, now: string): EventRecordDetail {
    return this.database.transaction(() => {
      const detail = this.getRecordRequired(recordId);
      if (detail.record.revision !== expectedRevision) throw new AppError("REVISION_CONFLICT", "分析任务对应的记录版本已过期。");
      this.database.prepare("UPDATE redesign_records SET report_state = 'running', updated_at = ? WHERE id = ?").run(now, recordId);
      return this.getRecordRequired(recordId);
    })();
  }

  saveReport(report: AnalysisReport): EventRecordDetail {
    return this.database.transaction(() => {
      const detail = this.getRecordRequired(report.recordId);
      const existingRow = (report.analysisRunId
        ? this.database.prepare("SELECT * FROM redesign_reports WHERE analysis_run_id = ? LIMIT 1")
          .get(report.analysisRunId)
        : this.database.prepare(`
            SELECT * FROM redesign_reports
            WHERE record_id = ? AND record_revision = ? AND input_hash = ?
              AND prompt_version = ? AND model_profile = ? AND analysis_run_id IS NULL LIMIT 1
          `).get(report.recordId, report.recordRevision, report.inputHash, report.promptVersion, report.modelProfile)
      ) as Record<string, unknown> | undefined;
      if (existingRow && (existingRow.record_id !== report.recordId ||
        existingRow.record_revision !== report.recordRevision || existingRow.input_hash !== report.inputHash)) {
        throw new AppError("REVISION_CONFLICT", "分析任务身份与当前记录版本不匹配。");
      }
      let effective = existingRow ? mapReport(existingRow) : report;
      if (!existingRow) {
        this.database.prepare(`
          INSERT INTO redesign_reports(id, record_id, record_revision, input_hash, prompt_version, model_profile,
            content_json, state, error_code, created_at, updated_at, analysis_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(report.id, report.recordId, report.recordRevision, report.inputHash, report.promptVersion,
          report.modelProfile, JSON.stringify(report.content), report.state, report.errorCode ?? null,
          report.createdAt, report.updatedAt, report.analysisRunId ?? null);
      } else if (effective.state === "partial" && report.state === "complete") {
        // A retry may finish media coverage for the same input and pipeline. Keep
        // completed reports immutable, but allow an incomplete result to advance.
        this.database.prepare(`
          UPDATE redesign_reports SET content_json = ?, state = 'complete', error_code = NULL, updated_at = ?
          WHERE id = ? AND state = 'partial'
        `).run(JSON.stringify(report.content), report.updatedAt, effective.id);
        effective = { ...report, id: effective.id, createdAt: effective.createdAt };
      }
      if (detail.record.revision === report.recordRevision) {
        const visible = effective.state === "partial" && detail.report?.recordRevision === report.recordRevision &&
          detail.report.state === "complete" ? detail.report : effective;
        this.database.prepare(`
          UPDATE redesign_records SET summary = ?, report_state = ?,
            source_updated = source_review_required, updated_at = ? WHERE id = ?
        `)
          .run(visible.content.summary, visible.state, report.updatedAt, report.recordId);
        this.reindex(report.recordId);
      }
      return this.getRecordRequired(report.recordId);
    })();
  }

  failReport(recordId: string, expectedRevision: number, errorCode: string, now: string): EventRecordDetail {
    return this.database.transaction(() => {
      const detail = this.getRecordRequired(recordId);
      if (detail.record.revision === expectedRevision) {
        this.database.prepare("UPDATE redesign_records SET report_state = 'failed', updated_at = ? WHERE id = ?").run(now, recordId);
      }
      return this.getRecordRequired(recordId);
    })();
  }

  search(query: RecordSearchQuery): RecordSearchPage {
    const limit = Math.max(1, Math.min(query.limit ?? 30, 100));
    const text = query.text.trim();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (text) {
      conditions.push(`r.id IN (
        SELECT record_id FROM redesign_record_fts WHERE redesign_record_fts MATCH ?
        UNION SELECT record_id FROM redesign_record_fts
          WHERE title LIKE ? ESCAPE '\\' OR source_text LIKE ? ESCAPE '\\' OR report_text LIKE ? ESCAPE '\\' OR user_text LIKE ? ESCAPE '\\'
      )`);
      const escapedLike = text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      values.push(ftsQuery(text), ...Array(4).fill(`%${escapedLike}%`));
    }
    const { rows, timeZone } = this.dateRows(query, conditions, values);
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map(mapRecord);
    const hits = records.map((record) => {
      const detail = this.getRecordRequired(record.id);
      const sourceText = detail.source.text ?? "";
      const needle = text.toLocaleLowerCase("zh-CN");
      const sourceRange = findCaseInsensitiveTextRange(sourceText, text);
      const reportText = reportSearchText(detail.report?.recordRevision === record.revision ? detail.report : undefined);
      const userMatch = text ? detail.overrides.find(({ value }) =>
        JSON.stringify(value).toLocaleLowerCase("zh-CN").includes(needle)) : undefined;
      const surface = sourceRange ? "source" as const
        : userMatch ? "user" as const
          : text && reportText.toLocaleLowerCase("zh-CN").includes(needle) ? "report" as const
            : text && `${record.title}\n${record.summary}`.toLocaleLowerCase("zh-CN").includes(needle) ? "record" as const
              : undefined;
      const explanation = !text ? "符合当前筛选条件"
        : surface === "source" ? `原文中包含“${text}”`
          : surface === "report" ? `事件报告中包含“${text}”`
            : surface === "user" ? `用户补充中包含“${text}”`
              : surface === "record" ? `记录字段中包含“${text}”` : `正式记录匹配“${text}”`;
      return {
        record, explanation,
        ...(surface ? { anchor: {
          sourceVersion: detail.source.sourceVersion, surface,
          ...(surface === "source" && sourceRange ? { textRange: sourceRange } : {}),
          ...(surface === "user" && userMatch ? { fieldKey: userMatch.fieldKey } : {})
        } } : {})
      };
    });
    const last = rows[Math.min(rows.length, limit) - 1];
    return {
      hits, ...(hasMore && last ? { nextCursor: encodeCursor(String(last.sort_at), String(last.id), timeZone) } : {}),
      capabilities: { keyword: "ready", semantic: "unavailable", media: "unavailable" }
    };
  }

  getSearchRecords(ids: string[]): EventRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT r.*, ${OCCURRENCE_SQL} AS occurrence_projection_json, ${CURRENT_ATTACHMENT_COUNT_SQL} AS attachment_count
      FROM redesign_records r WHERE r.id IN (${placeholders})
    `).all(...ids) as Record<string, unknown>[];
    return rows.map(mapRecord);
  }

  isSearchIndexEnabled(): boolean {
    const row = this.database.prepare(
      "SELECT value_json FROM workspace_settings WHERE key = 'redesign.search.enabled'"
    ).get() as { value_json: string } | undefined;
    return row ? json(row.value_json) === true : false;
  }

  setSearchIndexEnabled(enabled: boolean, now: string): void {
    this.database.prepare(`
      INSERT INTO workspace_settings(key, value_json, updated_at)
      VALUES ('redesign.search.enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(enabled), now);
  }

  listIndexableRecords(): EventRecordDetail[] {
    return Array.from(this.iterateIndexableRecordBatches()).flat();
  }

  *iterateIndexableRecordBatches(): IterableIterator<EventRecordDetail[]> {
    const ids = this.database.prepare(`
      SELECT id FROM redesign_records ORDER BY created_at, id
    `).all() as Array<{ id: string }>;
    // Keep the same detail projection as getRecord without preparing five SQL statements per record.
    // Each query only considers a bounded group of formal record IDs, never pending or legacy sources.
    for (let offset = 0; offset < ids.length; offset += 256) {
      const details: EventRecordDetail[] = [];
      const batch = ids.slice(offset, offset + 256).map(({ id }) => id);
      const placeholders = batch.map(() => "?").join(",");
      const records = new Map(this.getSearchRecords(batch).map((record) => [record.id, record]));
      const sources = new Map((this.database.prepare(`
        SELECT * FROM (
          SELECT s.*, row_number() OVER (PARTITION BY record_id ORDER BY created_at DESC, rowid DESC) AS position
          FROM redesign_sources s WHERE record_id IN (${placeholders})
        ) WHERE position = 1
      `).all(...batch) as Record<string, unknown>[]).map((row) => [String(row.record_id), mapSource(row)]));
      const sourceIds = [...sources.values()].map(({ id }) => id);
      if (sourceIds.length !== batch.length) throw new AppError("WORKSPACE_INVALID", "正式记录缺少原始来源。");
      const assetsBySource = new Map<string, Asset[]>();
      for (const row of this.database.prepare(`
        SELECT a.*, ra.source_id FROM assets a JOIN redesign_record_assets ra ON ra.asset_id = a.id
        JOIN redesign_sources s ON s.id = ra.source_id AND s.record_id = ra.record_id
        WHERE ra.source_id IN (${placeholders}) ORDER BY a.created_at, a.id
      `).all(...sourceIds) as Record<string, unknown>[]) {
        const id = String(row.source_id), assets = assetsBySource.get(id) ?? [];
        assets.push(mapAsset(row)); assetsBySource.set(id, assets);
      }
      const reports = new Map((this.database.prepare(`
        SELECT * FROM (
          SELECT p.*, row_number() OVER (PARTITION BY p.record_id ORDER BY (p.record_revision = r.revision) DESC,
            p.record_revision DESC, (p.state = 'complete') DESC, p.updated_at DESC, p.rowid DESC) AS position
          FROM redesign_reports p JOIN redesign_records r ON r.id = p.record_id
          WHERE p.record_id IN (${placeholders}) AND p.state IN ('complete', 'partial')
        ) WHERE position = 1
      `).all(...batch) as Record<string, unknown>[]).map((row) => [String(row.record_id), mapReport(row)]));
      const overridesByRecord = new Map<string, FieldOverride[]>();
      for (const row of this.database.prepare(`
        SELECT * FROM redesign_field_overrides WHERE record_id IN (${placeholders}) ORDER BY field_key
      `).all(...batch) as Record<string, unknown>[]) {
        const id = String(row.record_id), overrides = overridesByRecord.get(id) ?? [];
        overrides.push(mapOverride(row)); overridesByRecord.set(id, overrides);
      }
      for (const id of batch) {
        const record = records.get(id)!, source = sources.get(id)!, report = reports.get(id);
        details.push({ record, source, attachments: assetsBySource.get(source.id) ?? [], overrides: overridesByRecord.get(id) ?? [],
          ...(report ? { report } : {}) });
      }
      // No live SQLite statement/transaction crosses the caller's asynchronous boundary.
      yield details;
    }
  }

  getSearchProjectionVersion(): string {
    // total_changes notices this connection's writes; data_version notices other connections' commits.
    // This is a read-only invalidation token, not a persisted content cache or modification timestamp.
    const row = this.searchProjectionVersions();
    return JSON.stringify([row.local_changes, row.data_version]);
  }

  getSearchExternalVersion(): string {
    // Compare only on this repository/connection. Index writes on this connection must not invalidate a build.
    return String(this.searchProjectionVersions().data_version);
  }

  private searchProjectionVersions(): { local_changes: number; data_version: number } {
    return (this.searchProjectionVersionStatement ??= this.database.prepare(
      "SELECT total_changes() AS local_changes, data_version FROM pragma_data_version"
    )).get() as { local_changes: number; data_version: number };
  }

  listSearchGenerations(): RecordSearchGeneration[] {
    return (this.database.prepare(
      "SELECT * FROM redesign_search_generations ORDER BY created_at DESC, id DESC"
    ).all() as Record<string, unknown>[]).map(mapSearchGeneration);
  }

  createSearchGeneration(generation: RecordSearchGeneration): void {
    this.database.prepare(`
      INSERT INTO redesign_search_generations(
        id, adapter_identity, adapter_version, dimensions, normalization, input_modalities_json,
        state, fragment_count, last_error, created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generation.id, generation.adapterIdentity, generation.adapterVersion, generation.dimensions,
      generation.normalization, JSON.stringify(generation.inputModalities), generation.state, generation.fragmentCount,
      generation.lastError ?? null, generation.createdAt, generation.activatedAt ?? null);
  }

  prepareSearchGeneration(id: string): RecordSearchGeneration {
    return this.database.transaction((): RecordSearchGeneration => {
      const current = this.database.prepare(
        "SELECT * FROM redesign_search_generations WHERE id = ?"
      ).get(id) as Record<string, unknown> | undefined;
      if (!current) throw new AppError("ENTITY_NOT_FOUND", "搜索索引代际不存在。");
      const generation = mapSearchGeneration(current);
      if (generation.state !== "building" && generation.state !== "failed") {
        throw new AppError("REVISION_CONFLICT", "搜索索引代际已不可重新构建。");
      }
      this.database.prepare("DELETE FROM redesign_search_embeddings WHERE generation_id = ?").run(id);
      this.database.prepare(`
        UPDATE redesign_search_generations
        SET state = 'building', fragment_count = 0, last_error = NULL, activated_at = NULL WHERE id = ?
      `).run(id);
      return {
        id: generation.id,
        adapterIdentity: generation.adapterIdentity,
        adapterVersion: generation.adapterVersion,
        dimensions: generation.dimensions,
        normalization: generation.normalization,
        inputModalities: generation.inputModalities,
        state: "building",
        fragmentCount: 0,
        createdAt: generation.createdAt
      };
    })();
  }

  putSearchEmbedding(generationId: string, fragment: RecordSearchFragment, vector: Float32Array): void {
    const generation = (this.searchGenerationShapeStatement ??= this.database.prepare(
      "SELECT dimensions, state FROM redesign_search_generations WHERE id = ?"
    )).get(generationId) as { dimensions: number; state: string } | undefined;
    if (!generation || generation.state !== "building") {
      throw new AppError("REVISION_CONFLICT", "搜索索引代际已不可写入。");
    }
    if (vector.length !== generation.dimensions) {
      throw new AppError("VALIDATION_FAILED", "搜索向量维度与索引代际不一致。");
    }
    const bytes = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    (this.searchEmbeddingWriteStatement ??= this.database.prepare(`
      INSERT INTO redesign_search_embeddings(
        generation_id, fragment_id, record_id, record_revision, source_version, modality,
        content_hash, text_content, asset_id, anchor_json, vector
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)).run(generationId, fragment.id, fragment.recordId, fragment.recordRevision, fragment.sourceVersion,
      fragment.modality, fragment.contentHash, fragment.text ?? null, fragment.assetId ?? null,
      JSON.stringify(fragment.anchor), bytes);
  }

  putSearchEmbeddings(
    generationId: string,
    entries: readonly { fragment: RecordSearchFragment; vector: Float32Array }[],
    validateBeforeWrite: () => void
  ): void {
    if (entries.length < 1 || entries.length > 64) {
      throw new AppError("VALIDATION_FAILED", "搜索向量写入批次必须包含 1 至 64 个片段。");
    }
    this.database.transaction(() => {
      // No await, corpus scan or model work under the writer lock. A thrown scope/version fence
      // or any invalid row rolls back the whole response; the active generation stays untouched.
      validateBeforeWrite();
      for (const { fragment, vector } of entries) this.putSearchEmbedding(generationId, fragment, vector);
    }).immediate();
  }

  activateSearchGeneration(
    id: string, fragmentCount: number, now: string, expectedExternalVersion?: string, validateExternalChanges?: () => void
  ): void {
    this.database.transaction(() => {
      // Acquire the writer lock before the last version check so a different connection cannot
      // commit between validating the snapshot and atomically replacing the active generation.
      if (expectedExternalVersion !== undefined && this.getSearchExternalVersion() !== expectedExternalVersion) {
        if (!validateExternalChanges) throw new AppError("REVISION_CONFLICT", "记录或报告在索引激活前更新，请重新构建。", true);
        // This synchronous fence may throw to roll back; cooperative rechecks must happen outside the writer lock.
        validateExternalChanges();
      }
      const count = Number(this.database.prepare(
        "SELECT count(*) FROM redesign_search_embeddings WHERE generation_id = ?"
      ).pluck().get(id));
      if (count !== fragmentCount) throw new AppError("VALIDATION_FAILED", "搜索索引片段计数不一致。");
      this.database.prepare(`
        UPDATE redesign_search_generations SET state = 'superseded'
        WHERE state IN ('active', 'failed') AND id <> ?
      `).run(id);
      const result = this.database.prepare(`
        UPDATE redesign_search_generations SET state = 'active', fragment_count = ?, activated_at = ?, last_error = NULL
        WHERE id = ? AND state = 'building'
      `).run(fragmentCount, now, id);
      if (result.changes !== 1) throw new AppError("REVISION_CONFLICT", "搜索索引代际已不可激活。");
    }).immediate();
  }

  failSearchGeneration(id: string, error: string): void {
    this.database.prepare(`
      UPDATE redesign_search_generations SET state = 'failed', last_error = ? WHERE id = ? AND state = 'building'
    `).run(error.slice(0, 1_000), id);
  }

  listSearchFragmentKeys(generationId: string, afterFragmentId?: string, limit?: number): Array<Omit<RecordSearchFragment, "text">> {
    const pageSize = limit === undefined ? undefined : Math.max(1, Math.min(limit, 512));
    return (this.database.prepare(`
      SELECT fragment_id, record_id, record_revision, source_version, modality, content_hash, asset_id, anchor_json
      FROM redesign_search_embeddings WHERE generation_id = ? ${afterFragmentId === undefined ? "" : "AND fragment_id > ?"}
      ORDER BY fragment_id ${pageSize === undefined ? "" : "LIMIT ?"}
    `).all(generationId, ...(afterFragmentId === undefined ? [] : [afterFragmentId]), ...(pageSize === undefined ? [] : [pageSize])) as Array<{
      fragment_id: string;
      record_id: string;
      record_revision: number;
      source_version: string;
      modality: RecordSearchModality;
      content_hash: string;
      asset_id: string | null;
      anchor_json: string;
    }>).map((row) => ({
      id: row.fragment_id,
      recordId: row.record_id,
      recordRevision: row.record_revision,
      sourceVersion: row.source_version,
      modality: row.modality,
      contentHash: row.content_hash,
      ...(row.asset_id ? { assetId: row.asset_id } : {}),
      anchor: json(row.anchor_json)
    }));
  }

  *iterateSearchFragmentKeyBatches(generationId: string): IterableIterator<Array<Omit<RecordSearchFragment, "text">>> {
    let cursor: string | undefined;
    while (true) {
      const batch = this.listSearchFragmentKeys(generationId, cursor, 512);
      if (!batch.length) return;
      yield batch;
      if (batch.length < 512) return;
      cursor = batch.at(-1)!.id;
    }
  }

  listSearchEmbeddings(
    generationId: string,
    afterFragmentId?: string,
    limit?: number
  ): Array<{ fragment: RecordSearchFragment; vector: Float32Array }> {
    const pageSize = limit === undefined ? undefined : Math.max(1, Math.min(limit, 2_048));
    const rows = pageSize === undefined
      ? this.database.prepare(`
        SELECT * FROM redesign_search_embeddings WHERE generation_id = ? ORDER BY fragment_id
      `).all(generationId) as Record<string, unknown>[]
      : this.database.prepare(`
        SELECT * FROM redesign_search_embeddings
        WHERE generation_id = ? AND fragment_id > ? ORDER BY fragment_id LIMIT ?
      `).all(generationId, afterFragmentId ?? "", pageSize) as Record<string, unknown>[];
    return rows.map((row) => {
      const fragment: RecordSearchFragment = {
        id: String(row.fragment_id), recordId: String(row.record_id), recordRevision: Number(row.record_revision),
        sourceVersion: String(row.source_version), modality: row.modality as RecordSearchModality,
        contentHash: String(row.content_hash), anchor: json(row.anchor_json)
      };
      if (row.text_content !== null && row.text_content !== undefined) fragment.text = String(row.text_content);
      if (row.asset_id) fragment.assetId = String(row.asset_id);
      const blob = row.vector as Buffer;
      const bytes = blob.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0 ? blob : Uint8Array.from(blob);
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new AppError("EMBEDDING_UNAVAILABLE", "本地语义索引的向量字节数不正确，请重建索引。", true);
      }
      return { fragment, vector: new Float32Array(bytes.buffer, bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT) };
    });
  }

  private getRecordRequired(id: string): EventRecordDetail {
    const value = this.getRecord(id);
    if (!value) throw new AppError("ENTITY_NOT_FOUND", "记录不存在。");
    return value;
  }

  private getPendingRequired(id: string): PendingReview {
    const value = this.getPending(id);
    if (!value) throw new AppError("ENTITY_NOT_FOUND", "待确认项不存在。");
    return value;
  }

  private reindex(recordId: string): void {
    const record = this.database.prepare("SELECT title, summary, revision FROM redesign_records WHERE id = ?").get(recordId) as {
      title: string; summary: string; revision: number;
    };
    const source = this.database.prepare("SELECT text FROM redesign_sources WHERE record_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(recordId) as { text: string | null };
    const overrideRows = this.database.prepare("SELECT value_json FROM redesign_field_overrides WHERE record_id = ?").all(recordId) as Array<{ value_json: string }>;
    const reportRow = this.database.prepare(`
      SELECT * FROM redesign_reports WHERE record_id = ? AND state IN ('complete','partial')
      ORDER BY record_revision DESC, (state = 'complete') DESC, updated_at DESC, rowid DESC LIMIT 1
    `).get(recordId) as Record<string, unknown> | undefined;
    this.database.prepare("DELETE FROM redesign_record_fts WHERE record_id = ?").run(recordId);
    this.database.prepare("INSERT INTO redesign_record_fts(record_id, title, source_text, report_text, user_text) VALUES (?, ?, ?, ?, ?)")
      .run(recordId, record.title, `${record.summary}\n${source.text ?? ""}`,
        reportSearchText(reportRow && Number(reportRow.record_revision) === record.revision ? mapReport(reportRow) : undefined),
        overrideRows.map(({ value_json }) => JSON.stringify(json(value_json))).join("\n"));
  }

  private saveRevision(
    recordId: string,
    revision: number,
    actor: "source" | "user",
    reason: string,
    now: string
  ): void {
    const snapshot = this.getRecordRequired(recordId).record;
    this.database.prepare(`
      INSERT INTO redesign_record_revisions(id, record_id, revision, snapshot_json, actor, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), recordId, revision, JSON.stringify(snapshot), actor, reason, now);
  }
}
