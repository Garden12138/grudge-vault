import type Database from "better-sqlite3";
import type {
  AutomationRun, ImportFolderEntry, PhaseSixRepositoryPort
} from "@grudge-vault/application";
import type { DerivedArtifact, MediaProcessorKind, Reminder, SearchDocument } from "@grudge-vault/domain";
import { AppError } from "@grudge-vault/shared";
import type { SqliteMemoryRepository } from "./index";

function artifactFromRow(row: Record<string, unknown>): DerivedArtifact {
  return {
    id: String(row.id), sourceAssetId: String(row.source_asset_id), kind: row.kind as DerivedArtifact["kind"],
    sha256: String(row.sha256), byteSize: Number(row.byte_size), mimeType: String(row.mime_type),
    processorIdentity: String(row.processor_identity), processorVersion: Number(row.processor_version),
    configHash: String(row.config_hash), inputHash: String(row.input_hash), current: Boolean(row.is_current),
    createdAt: String(row.created_at)
  };
}

function reminderFromRow(row: Record<string, unknown>): Reminder {
  return {
    id: String(row.id), kind: row.kind as Reminder["kind"], scheduleKey: String(row.schedule_key),
    status: row.status as Reminder["status"], dueAt: String(row.due_at),
    ...(row.review_id ? { reviewId: String(row.review_id) } : {}),
    clarificationIds: JSON.parse(String(row.clarification_ids_json)) as string[],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

const ARTIFACT_SELECT = `SELECT da.*, EXISTS(
  SELECT 1 FROM current_derived_artifacts current WHERE current.artifact_id = da.id
) AS is_current FROM derived_artifacts da`;

export class SqlitePhaseSixRepository implements PhaseSixRepositoryPort {
  constructor(private readonly database: Database.Database, private readonly memory: SqliteMemoryRepository) {}

  findDerivedArtifact(sourceAssetId: string, kind: MediaProcessorKind, inputHash: string): DerivedArtifact | undefined {
    const row = this.database.prepare(`${ARTIFACT_SELECT}
      WHERE da.source_asset_id = ? AND da.kind = ? AND da.input_hash = ?`
    ).get(sourceAssetId, kind, inputHash) as Record<string, unknown> | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  getDerivedArtifact(id: string): DerivedArtifact | undefined {
    const row = this.database.prepare(`${ARTIFACT_SELECT} WHERE da.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  getCurrentDerivedArtifact(sourceAssetId: string, kind: MediaProcessorKind): DerivedArtifact | undefined {
    const row = this.database.prepare(`${ARTIFACT_SELECT} JOIN current_derived_artifacts current
      ON current.artifact_id = da.id WHERE current.source_asset_id = ? AND current.kind = ?`
    ).get(sourceAssetId, kind) as Record<string, unknown> | undefined;
    return row ? artifactFromRow(row) : undefined;
  }

  activateDerivedArtifact(artifact: DerivedArtifact, document: SearchDocument, now: string): DerivedArtifact {
    return this.database.transaction(() => {
      this.database.prepare(`INSERT INTO derived_artifacts(
        id,source_asset_id,kind,sha256,byte_size,mime_type,processor_identity,processor_version,
        config_hash,input_hash,created_at
      ) VALUES (@id,@sourceAssetId,@kind,@sha256,@byteSize,@mimeType,@processorIdentity,@processorVersion,
        @configHash,@inputHash,@createdAt)
      ON CONFLICT(source_asset_id,kind,input_hash) DO NOTHING`).run(artifact);
      const stored = this.findDerivedArtifact(artifact.sourceAssetId, artifact.kind as MediaProcessorKind, artifact.inputHash);
      if (!stored) throw new AppError("MEDIA_PROCESSING_FAILED", "The derived artifact could not be persisted.");
      this.database.prepare(`INSERT INTO current_derived_artifacts(source_asset_id,kind,artifact_id,activated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(source_asset_id,kind) DO UPDATE SET
          artifact_id=excluded.artifact_id,activated_at=excluded.activated_at`
      ).run(stored.sourceAssetId, stored.kind, stored.id, now);
      this.memory.upsertSearchDocument({ ...document, derivedArtifactId: stored.id }, now);
      return { ...stored, current: true };
    })();
  }

  hasImportFolderArchive(archiveSha256: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM import_folder_entries WHERE archive_sha256 = ?").get(archiveSha256));
  }

  saveImportFolderEntry(entry: ImportFolderEntry): ImportFolderEntry {
    this.database.prepare(`INSERT INTO import_folder_entries(
      id,archive_sha256,asset_id,import_run_id,file_name,created_at
    ) VALUES (@id,@archiveSha256,@assetId,@importRunId,@fileName,@createdAt)
    ON CONFLICT(archive_sha256) DO NOTHING`).run(entry);
    return entry;
  }

  countImportFolderEntries(): { imported: number; failed: number } {
    const row = this.database.prepare(`SELECT
      SUM(CASE WHEN run.state = 'succeeded' THEN 1 ELSE 0 END) AS imported,
      SUM(CASE WHEN run.state = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM import_folder_entries entry JOIN import_runs run ON run.id = entry.import_run_id`
    ).get() as { imported: number | null; failed: number | null };
    return { imported: Number(row.imported ?? 0), failed: Number(row.failed ?? 0) };
  }

  getAutomationRun(scheduleKey: string): AutomationRun | undefined {
    const row = this.database.prepare("SELECT * FROM automation_runs WHERE schedule_key = ?")
      .get(scheduleKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      scheduleKey: String(row.schedule_key), kind: row.kind as AutomationRun["kind"],
      ...(row.review_id ? { reviewId: String(row.review_id) } : {}),
      ...(row.from_date ? { from: String(row.from_date) } : {}),
      ...(row.to_date ? { to: String(row.to_date) } : {}), createdAt: String(row.created_at)
    };
  }

  saveAutomationRun(run: AutomationRun): AutomationRun {
    this.database.prepare(`INSERT INTO automation_runs(schedule_key,kind,review_id,from_date,to_date,created_at)
      VALUES (@scheduleKey,@kind,@reviewId,@from,@to,@createdAt) ON CONFLICT(schedule_key) DO NOTHING`
    ).run({ ...run, reviewId: run.reviewId ?? null, from: run.from ?? null, to: run.to ?? null });
    return this.getAutomationRun(run.scheduleKey) ?? run;
  }

  listReminders(): Reminder[] {
    return (this.database.prepare("SELECT * FROM reminders ORDER BY due_at DESC, created_at DESC").all() as Record<string, unknown>[])
      .map(reminderFromRow);
  }

  getReminder(id: string): Reminder | undefined {
    const row = this.database.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? reminderFromRow(row) : undefined;
  }

  saveReminder(reminder: Reminder): Reminder {
    this.database.prepare(`INSERT INTO reminders(
      id,kind,schedule_key,status,due_at,review_id,clarification_ids_json,created_at,updated_at
    ) VALUES (@id,@kind,@scheduleKey,@status,@dueAt,@reviewId,@clarificationIds,@createdAt,@updatedAt)
    ON CONFLICT(schedule_key) DO NOTHING`).run({
      ...reminder, reviewId: reminder.reviewId ?? null, clarificationIds: JSON.stringify(reminder.clarificationIds)
    });
    return this.database.prepare("SELECT * FROM reminders WHERE schedule_key = ?").get(reminder.scheduleKey)
      ? reminderFromRow(this.database.prepare("SELECT * FROM reminders WHERE schedule_key = ?").get(reminder.scheduleKey) as Record<string, unknown>)
      : reminder;
  }

  updateReminderStatus(id: string, status: Reminder["status"], now: string): Reminder {
    const result = this.database.prepare("UPDATE reminders SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    if (result.changes !== 1) throw new AppError("REMINDER_NOT_FOUND", "The reminder no longer exists.");
    return this.getReminder(id)!;
  }
}
