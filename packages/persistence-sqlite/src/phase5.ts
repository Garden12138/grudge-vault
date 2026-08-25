import type Database from "better-sqlite3";
import type { CryptoMigrationRecord, PhaseFiveRepositoryPort } from "@grudge-vault/application";
import type {
  Asset, Case, CaseBinderProfile, CaseRevision, DerivedArtifact, EvidenceDetail,
  EvidenceReferenceImpact, IntegrityScan, IntegrityScanItemResult, LegalVerificationResult
} from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import type { SqliteMemoryRepository } from "./index";

function assetFromRow(row: Record<string, unknown>): Asset {
  const value: Asset = {
    id: String(row.id), sha256: String(row.sha256), byteSize: Number(row.byte_size),
    mimeType: String(row.mime_type), originalFileName: String(row.original_file_name),
    vaultFormat: Number(row.vault_format), integrityStatus: row.integrity_status as Asset["integrityStatus"],
    availabilityStatus: (row.availability_status ?? "available") as Asset["availabilityStatus"],
    createdAt: String(row.created_at)
  };
  if (row.verified_at) value.verifiedAt = String(row.verified_at);
  if (row.superseded_by_asset_id) value.supersededByAssetId = String(row.superseded_by_asset_id);
  if (row.deleted_at) value.deletedAt = String(row.deleted_at);
  return value;
}

function artifactFromRow(row: Record<string, unknown>): DerivedArtifact {
  return {
    id: String(row.id), sourceAssetId: String(row.source_asset_id), kind: row.kind as DerivedArtifact["kind"],
    sha256: String(row.sha256), byteSize: Number(row.byte_size), mimeType: String(row.mime_type),
    processorIdentity: String(row.processor_identity), processorVersion: Number(row.processor_version),
    inputHash: String(row.input_hash), createdAt: String(row.created_at)
  };
}

function scanFromRow(row: Record<string, unknown>, results?: IntegrityScanItemResult[]): IntegrityScan {
  const value: IntegrityScan = {
    id: String(row.id), state: row.state as IntegrityScan["state"],
    counts: JSON.parse(String(row.counts_json)) as IntegrityScan["counts"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(results ? { results } : {})
  };
  if (row.cursor) value.cursor = String(row.cursor);
  if (row.last_error) value.lastError = String(row.last_error);
  if (row.finished_at) value.finishedAt = String(row.finished_at);
  return value;
}

function cryptoMigrationFromRow(row: Record<string, unknown>): CryptoMigrationRecord {
  const value: CryptoMigrationRecord = {
    id: String(row.id), fromKeyId: String(row.from_key_id), toKeyId: String(row.to_key_id),
    state: row.state as CryptoMigrationRecord["state"], processedObjects: Number(row.processed_objects),
    totalObjects: Number(row.total_objects), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
  if (row.cursor) value.cursor = String(row.cursor);
  if (row.last_error) value.lastError = String(row.last_error);
  if (row.finished_at) value.finishedAt = String(row.finished_at);
  return value;
}

export class SqlitePhaseFiveRepository implements PhaseFiveRepositoryPort {
  constructor(private readonly database: Database.Database, private readonly memory: SqliteMemoryRepository) {}

  listCases(): Case[] {
    return (this.database.prepare("SELECT projection_json FROM cases ORDER BY updated_at DESC").all() as Array<{ projection_json: string }>)
      .map(({ projection_json }) => JSON.parse(projection_json) as Case);
  }

  getCase(id: string): Case | undefined {
    const row = this.database.prepare("SELECT projection_json FROM cases WHERE id = ?").get(id) as { projection_json: string } | undefined;
    return row ? JSON.parse(row.projection_json) as Case : undefined;
  }

  listCaseRevisions(id: string): CaseRevision[] {
    return (this.database.prepare("SELECT * FROM case_revisions WHERE case_id = ? ORDER BY revision DESC").all(id) as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id), caseId: String(row.case_id), revision: Number(row.revision), previousRevision: Number(row.previous_revision),
        snapshot: JSON.parse(String(row.snapshot_json)) as Case, actor: row.actor as CaseRevision["actor"],
        reason: String(row.reason), createdAt: String(row.created_at)
      }));
  }

  commitCase(value: Case, revision: CaseRevision): Case {
    return this.database.transaction(() => {
      const existing = this.database.prepare("SELECT current_revision FROM cases WHERE id = ?").get(value.id) as { current_revision: number } | undefined;
      if (existing && existing.current_revision !== revision.previousRevision) {
        throw new AppError("CASE_REVISION_CONFLICT", "The Case changed before it could be committed.", true);
      }
      this.database.prepare(`
        INSERT INTO cases(id, title, status, jurisdiction, as_of_date, projection_json, current_revision, created_at, updated_at)
        VALUES (@id, @title, @status, @jurisdiction, @asOfDate, @projection, @currentRevision, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, jurisdiction=excluded.jurisdiction,
          as_of_date=excluded.as_of_date, projection_json=excluded.projection_json,
          current_revision=excluded.current_revision, updated_at=excluded.updated_at
      `).run({ ...value, projection: JSON.stringify(value) });
      this.database.prepare(`
        INSERT INTO case_revisions(id, case_id, revision, previous_revision, snapshot_json, actor, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revision.id, revision.caseId, revision.revision, revision.previousRevision,
        JSON.stringify(revision.snapshot), revision.actor, revision.reason, revision.createdAt);
      for (const table of ["case_event_refs", "case_person_refs", "case_source_refs", "case_asset_refs"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE case_id = ?`).run(value.id);
      }
      const insertRefs = (table: string, column: string, refs: string[]) => {
        const statement = this.database.prepare(`INSERT INTO ${table}(case_id, ${column}) VALUES (?, ?)`);
        for (const id of refs) statement.run(value.id, id);
      };
      insertRefs("case_event_refs", "event_id", value.eventRefs);
      insertRefs("case_person_refs", "person_id", value.personRefs);
      insertRefs("case_source_refs", "source_item_id", value.sourceRefs);
      insertRefs("case_asset_refs", "asset_id", value.assetRefs);
      this.database.prepare("DELETE FROM case_evidence_links WHERE case_id = ?").run(value.id);
      const insertLink = this.database.prepare(`INSERT INTO case_evidence_links(
        id,case_id,asset_id,event_id,statement_ids_json,source_refs_json,notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const link of value.evidenceLinks) {
        insertLink.run(link.id, value.id, link.assetId, link.eventId ?? null, JSON.stringify(link.statementIds),
          JSON.stringify(link.sourceRefs), link.notes ?? null);
      }
      return value;
    })();
  }

  listEvidence(): EvidenceDetail[] {
    const ids = this.database.prepare("SELECT id FROM assets ORDER BY created_at DESC").all() as Array<{ id: string }>;
    return ids.map(({ id }) => this.getEvidence(id)!).filter(Boolean);
  }

  getEvidence(assetId: string): EvidenceDetail | undefined {
    const row = this.database.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const asset = assetFromRow(row);
    const sourceIds = (this.database.prepare(`
      SELECT source_item_id AS id FROM source_item_assets WHERE asset_id = ?
      UNION SELECT sv.source_item_id AS id FROM source_version_assets sva JOIN source_versions sv ON sv.id = sva.source_version_id WHERE sva.asset_id = ?
    `).all(assetId, assetId) as Array<{ id: string }>).map(({ id }) => id);
    const eventIds = (this.database.prepare("SELECT event_id AS id FROM event_assets WHERE asset_id = ?").all(assetId) as Array<{ id: string }>).map(({ id }) => id);
    const events = eventIds.flatMap((id) => this.memory.getEvent(id) ?? []);
    const cases = this.database.prepare(`
      SELECT c.id, c.title FROM case_asset_refs r JOIN cases c ON c.id = r.case_id WHERE r.asset_id = ? ORDER BY c.updated_at DESC
    `).all(assetId) as Array<{ id: string; title: string }>;
    const impact = this.getEvidenceImpact(assetId);
    return {
      asset, availabilityStatus: asset.availabilityStatus,
      ...(asset.supersededByAssetId ? { supersededByAssetId: asset.supersededByAssetId } : {}),
      ...(asset.deletedAt ? { deletedAt: asset.deletedAt } : {}),
      sources: sourceIds.flatMap((id) => this.memory.getSourceReference(id) ?? []), events,
      facts: events.flatMap((event) => event.facts.map((statement) => ({ eventId: event.id, statement }))),
      cases, derivedArtifacts: this.listDerivedArtifacts(assetId), impact
    };
  }

  getEvidenceImpact(assetId: string): EvidenceReferenceImpact {
    const ids = (sql: string, ...params: unknown[]) => (this.database.prepare(sql).all(...params) as Array<{ id: string }>).map(({ id }) => id);
    return {
      assetId,
      eventIds: ids("SELECT event_id AS id FROM event_assets WHERE asset_id = ?", assetId),
      sourceItemIds: ids(`SELECT source_item_id AS id FROM source_item_assets WHERE asset_id = ?
        UNION SELECT sv.source_item_id AS id FROM source_version_assets sva JOIN source_versions sv ON sv.id=sva.source_version_id WHERE sva.asset_id = ?`, assetId, assetId),
      importRunIds: ids(`SELECT id FROM import_runs WHERE archive_asset_id = ? UNION
        SELECT DISTINCT sv.import_run_id AS id FROM source_version_assets sva JOIN source_versions sv ON sv.id=sva.source_version_id WHERE sva.asset_id = ?`, assetId, assetId),
      caseIds: ids("SELECT case_id AS id FROM case_asset_refs WHERE asset_id = ?", assetId)
    };
  }

  setAssetAvailability(assetId: string, status: Asset["availabilityStatus"], now: string, supersededByAssetId?: string): void {
    const result = this.database.prepare(`
      UPDATE assets SET availability_status = ?, superseded_by_asset_id = ?, deleted_at = ? WHERE id = ?
    `).run(status, supersededByAssetId ?? null, status === "deleted" ? now : null, assetId);
    if (result.changes !== 1) throw new AppError("ASSET_NOT_FOUND", "The original no longer exists.");
  }

  listDerivedArtifacts(assetId?: string): DerivedArtifact[] {
    const rows = assetId
      ? this.database.prepare("SELECT * FROM derived_artifacts WHERE source_asset_id = ? ORDER BY created_at DESC").all(assetId)
      : this.database.prepare("SELECT * FROM derived_artifacts ORDER BY created_at DESC").all();
    return (rows as Record<string, unknown>[]).map(artifactFromRow);
  }

  saveDerivedArtifact(artifact: DerivedArtifact): DerivedArtifact {
    this.database.prepare(`INSERT INTO derived_artifacts(
      id,source_asset_id,kind,sha256,byte_size,mime_type,processor_identity,processor_version,input_hash,created_at
    ) VALUES (@id,@sourceAssetId,@kind,@sha256,@byteSize,@mimeType,@processorIdentity,@processorVersion,@inputHash,@createdAt)`)
      .run(artifact);
    return artifact;
  }

  createIntegrityScan(scan: IntegrityScan): IntegrityScan {
    this.database.prepare(`INSERT INTO integrity_scans(id,state,cursor,counts_json,last_error,created_at,updated_at,finished_at)
      VALUES (@id,@state,@cursor,@counts,@lastError,@createdAt,@updatedAt,@finishedAt)`)
      .run({ ...scan, cursor: scan.cursor ?? null, counts: JSON.stringify(scan.counts), lastError: scan.lastError ?? null, finishedAt: scan.finishedAt ?? null });
    return scan;
  }

  listIntegrityScans(): IntegrityScan[] {
    return (this.database.prepare("SELECT * FROM integrity_scans ORDER BY created_at DESC").all() as Record<string, unknown>[])
      .map((row) => scanFromRow(row, this.listIntegrityScanResults(String(row.id))));
  }

  getIntegrityScan(id: string): IntegrityScan | undefined {
    const row = this.database.prepare("SELECT * FROM integrity_scans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? scanFromRow(row, this.listIntegrityScanResults(id)) : undefined;
  }

  saveIntegrityScan(scan: IntegrityScan): IntegrityScan {
    this.database.prepare(`UPDATE integrity_scans SET state=@state,cursor=@cursor,counts_json=@counts,last_error=@lastError,
      updated_at=@updatedAt,finished_at=@finishedAt WHERE id=@id`)
      .run({ ...scan, cursor: scan.cursor ?? null, counts: JSON.stringify(scan.counts), lastError: scan.lastError ?? null, finishedAt: scan.finishedAt ?? null });
    return scan;
  }

  saveIntegrityScanResult(scanId: string, result: IntegrityScanItemResult): void {
    this.database.prepare(`INSERT INTO integrity_scan_results(
      scan_id,asset_id,result,expected_sha256,expected_byte_size,verified_at,error
    ) VALUES (@scanId,@assetId,@result,@expectedSha256,@expectedByteSize,@verifiedAt,@error)
    ON CONFLICT(scan_id,asset_id) DO UPDATE SET result=excluded.result,verified_at=excluded.verified_at,error=excluded.error`)
      .run({ scanId, ...result, error: result.error ?? null });
  }

  private listIntegrityScanResults(scanId: string): IntegrityScanItemResult[] {
    return (this.database.prepare("SELECT * FROM integrity_scan_results WHERE scan_id = ? ORDER BY asset_id").all(scanId) as Record<string, unknown>[])
      .map((row) => ({
        assetId: String(row.asset_id), result: row.result as IntegrityScanItemResult["result"],
        expectedSha256: String(row.expected_sha256), expectedByteSize: Number(row.expected_byte_size),
        verifiedAt: String(row.verified_at), ...(row.error ? { error: String(row.error) } : {})
      }));
  }

  getActiveCryptoMigration(): CryptoMigrationRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM crypto_migrations WHERE state IN ('queued','running','failed')
      ORDER BY created_at DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    return row ? cryptoMigrationFromRow(row) : undefined;
  }

  saveCryptoMigration(migration: CryptoMigrationRecord): CryptoMigrationRecord {
    this.database.prepare(`INSERT INTO crypto_migrations(
      id,from_key_id,to_key_id,state,cursor,processed_objects,total_objects,last_error,created_at,updated_at,finished_at
    ) VALUES (@id,@fromKeyId,@toKeyId,@state,@cursor,@processedObjects,@totalObjects,@lastError,@createdAt,@updatedAt,@finishedAt)
    ON CONFLICT(id) DO UPDATE SET state=excluded.state,cursor=excluded.cursor,processed_objects=excluded.processed_objects,
      total_objects=excluded.total_objects,last_error=excluded.last_error,updated_at=excluded.updated_at,finished_at=excluded.finished_at`)
      .run({ ...migration, cursor: migration.cursor ?? null, lastError: migration.lastError ?? null, finishedAt: migration.finishedAt ?? null });
    return migration;
  }

  saveLegalVerification(result: LegalVerificationResult): LegalVerificationResult {
    this.database.prepare(`INSERT INTO legal_verifications(id,case_id,case_revision,request_hash,result_json,created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(result.id, result.caseId, result.caseRevision, result.requestHash, JSON.stringify({ ...result, stale: false }), result.createdAt);
    return result;
  }

  getLatestLegalVerification(caseId: string): LegalVerificationResult | undefined {
    const row = this.database.prepare("SELECT result_json FROM legal_verifications WHERE case_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(caseId) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as LegalVerificationResult : undefined;
  }

  saveBinderExport(input: { id: string; caseId: string; caseRevision: number; profile: CaseBinderProfile; manifestSha256: string; generatedAt: string }): void {
    this.database.prepare(`INSERT INTO binder_exports(id,case_id,case_revision,profile_json,manifest_sha256,generated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.caseId, input.caseRevision, JSON.stringify(input.profile), input.manifestSha256, input.generatedAt);
  }
}
