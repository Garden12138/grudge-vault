import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMigrations, SqliteRecordRepository } from "./index";

describe("bounded current search projection reads", () => {
  it("separates local writes from external commits and checks activation while holding the writer lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "grudge-vault-projection-versions-"));
    const database = new Database(join(directory, "synthetic.sqlite3")); database.pragma("journal_mode = WAL"); runMigrations(database);
    const other = new Database(join(directory, "synthetic.sqlite3"), { timeout: 0 });
    const repository = new SqliteRecordRepository(database, () => Buffer.alloc(32)), stamp = "2026-09-30T00:00:00Z";
    const writeOther = other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES (?, 'true', ?)");
    try {
      const initial = repository.getSearchProjectionVersion(), initialExternal = repository.getSearchExternalVersion();
      repository.createSearchGeneration({ id: "synthetic-old", adapterIdentity: "synthetic", adapterVersion: 1,
        dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: stamp });
      expect(repository.getSearchProjectionVersion()).not.toBe(initial);
      expect(repository.getSearchExternalVersion()).toBe(initialExternal);
      repository.activateSearchGeneration("synthetic-old", 0, stamp, initialExternal);
      repository.createSearchGeneration({ id: "synthetic-new", adapterIdentity: "synthetic", adapterVersion: 1,
        dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: stamp });
      writeOther.run("synthetic-external-commit", stamp);
      const changedExternal = repository.getSearchExternalVersion(); expect(changedExternal).not.toBe(initialExternal);
      expect(() => repository.activateSearchGeneration("synthetic-new", 0, stamp, initialExternal)).toThrow(/激活前更新/);
      expect(repository.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe("synthetic-old");
      const version = repository.getSearchExternalVersion.bind(repository);
      const guard = vi.spyOn(repository, "getSearchExternalVersion").mockImplementationOnce(() => {
        expect(database.inTransaction).toBe(true);
        expect(() => writeOther.run("synthetic-blocked-writer", stamp)).toThrow(/locked/);
        return version();
      });
      repository.activateSearchGeneration("synthetic-new", 0, stamp, changedExternal);
      expect(guard).toHaveBeenCalledTimes(1); guard.mockRestore();
      expect(repository.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe("synthetic-new");
      expect(other.prepare("SELECT count(*) FROM workspace_settings WHERE key = 'synthetic-blocked-writer'").pluck().get()).toBe(0);
    } finally { vi.restoreAllMocks(); other.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("matches individual details across batches, source ties, report states and revisions, attachments and overrides without writes", () => {
    const database = new Database(":memory:"); database.pragma("foreign_keys = ON"); runMigrations(database);
    const repository = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const stamp = "2026-09-29T00:00:00Z", later = "2026-09-29T01:00:00Z";
    const record = database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
      occurred_at_json, recorded_at, report_state, created_at, updated_at)
      VALUES (?, 'manual', '["rights"]', '合成批量读取', '', ?, '{"kind":"unknown"}', ?, 'complete', ?, ?)`);
    const source = database.prepare(`INSERT INTO redesign_sources(id, record_id, origin, source_version, content_hash,
      text, recorded_at, created_at) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)`);
    const report = database.prepare(`INSERT INTO redesign_reports(id, record_id, record_revision, input_hash, prompt_version,
      model_profile, content_json, state, created_at, updated_at, analysis_run_id)
      VALUES (?, ?, ?, ?, 'synthetic-batch-read', 'synthetic:no-network', ?, ?, ?, ?, ?)`);
    const asset = database.prepare(`INSERT INTO assets(id, sha256, byte_size, mime_type, original_file_name, vault_format,
      integrity_status, created_at) VALUES (?, ?, 1, 'image/png', 'synthetic.png', 2, 'verified', ?)`);
    const link = database.prepare("INSERT INTO redesign_record_assets(record_id, source_id, asset_id) VALUES (?, ?, ?)");
    const override = database.prepare(`INSERT INTO redesign_field_overrides(id, record_id, field_key, value_json, actor,
      revision, created_at, updated_at) VALUES (?, ?, 'location', '"合成补充地点"', 'user', 2, ?, ?)`);
    try {
      const ids: string[] = [];
      database.transaction(() => {
        for (let index = 0; index < 257; index++) {
          const id = `batch-${String(index).padStart(3, "0")}`, revision = index % 3 + 1;
          ids.push(id); record.run(id, revision, stamp, stamp, stamp);
          source.run(`${id}-old`, id, "old", "a".repeat(64), "旧合成来源", stamp, stamp);
          source.run(`${id}-current`, id, "current", "b".repeat(64), "当前合成来源", stamp, stamp);
          for (const version of ["old", "current"]) {
            const assetId = `${id}-${version}-asset`, hash = String(index * 2 + Number(version === "current")).padStart(64, "0");
            asset.run(assetId, hash, stamp); link.run(id, `${id}-${version}`, assetId);
          }
          if (index % 4 !== 0) for (const reportRevision of [1, 2, 3]) for (const state of ["complete", "partial", "failed"]) {
            const body = JSON.stringify({ summary: `${reportRevision}-${state}`, time: {
              source: "ai", value: { value: "2026-09", precision: "approximate" }
            } });
            report.run(`${id}-${reportRevision}-${state}`, id, reportRevision, "c".repeat(64), body, state,
              stamp, state === "complete" ? stamp : later, `${id}-${reportRevision}-${state}`);
          }
          if (index % 2 === 0) override.run(`${id}-override`, id, stamp, stamp);
        }
      })();
      // A malformed association must not leak another record's attachment into this projection.
      link.run("batch-001", "batch-000-current", "batch-001-old-asset");
      const expected = ids.map((id) => repository.getRecord(id)!);
      const changes = database.prepare("SELECT total_changes()").pluck().get();
      const singleRead = vi.spyOn(repository, "getRecord"), statements = vi.spyOn(database, "prepare");
      const actual = repository.listIndexableRecords();
      expect(actual).toEqual(expected);
      expect(actual.every(({ source, attachments, record }) => source.sourceVersion === "current" &&
        attachments.length === 1 && record.attachmentCount === 1 && attachments[0]!.id.endsWith("current-asset"))).toBe(true);
      expect(singleRead).not.toHaveBeenCalled();
      expect(statements.mock.calls.length).toBeLessThanOrEqual(11);
      statements.mockRestore(); singleRead.mockRestore();
      const batches = Array.from(repository.iterateIndexableRecordBatches());
      expect(batches.map((batch) => batch.length)).toEqual([256, 1]);
      expect(batches.flat()).toEqual(expected);
      expect(database.prepare("SELECT total_changes()").pluck().get()).toBe(changes);
    } finally { vi.restoreAllMocks(); database.close(); }
  });

  it("keeps the active generation immutable after reusing prepared embedding statements", () => {
    const database = new Database(":memory:"); runMigrations(database);
    const repository = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const stamp = "2026-09-29T00:00:00Z";
    try {
      database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, created_at, updated_at)
        VALUES ('synthetic-record', 'manual', '["rights"]', '合成索引记录', '', 1, '{"kind":"unknown"}', ?, 'queued', ?, ?)`)
        .run(stamp, stamp, stamp);
      repository.createSearchGeneration({ id: "synthetic-generation", adapterIdentity: "synthetic", adapterVersion: 1,
        dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: stamp });
      const fragment = { id: "synthetic-fragment", recordId: "synthetic-record", recordRevision: 1, sourceVersion: "v1",
        modality: "text" as const, contentHash: "a".repeat(64), anchor: { sourceVersion: "v1" } };
      repository.putSearchEmbedding("synthetic-generation", fragment, new Float32Array([1, 0]));
      repository.activateSearchGeneration("synthetic-generation", 1, stamp);
      expect(() => repository.putSearchEmbedding("synthetic-generation", { ...fragment, id: "late-fragment" },
        new Float32Array([1, 0]))).toThrow(/不可写入/);
      expect(repository.listSearchFragmentKeys("synthetic-generation")).toHaveLength(1);
    } finally { database.close(); }
  });

  it("pages every indexed key in stable order without reading vector BLOBs or holding a transaction across batches", () => {
    const database = new Database(":memory:"); runMigrations(database);
    const repository = new SqliteRecordRepository(database, () => Buffer.alloc(32)), stamp = "2026-10-01T00:00:00Z";
    try {
      database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
        occurred_at_json, recorded_at, report_state, created_at, updated_at)
        VALUES ('batch-key-record', 'manual', '["rights"]', '合成元数据分页', '', 1, '{"kind":"unknown"}', ?, 'queued', ?, ?)`)
        .run(stamp, stamp, stamp);
      repository.createSearchGeneration({ id: "batch-key-generation", adapterIdentity: "synthetic", adapterVersion: 1,
        dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: stamp });
      for (let index = 1024; index >= 0; index--) repository.putSearchEmbedding("batch-key-generation", {
        id: `fragment-${String(index).padStart(4, "0")}`, recordId: "batch-key-record", recordRevision: 1,
        sourceVersion: "v1", modality: "text", contentHash: "a".repeat(64), text: "合成片段正文",
        anchor: { sourceVersion: "v1", textRange: [0, 2] }
      }, new Float32Array([1, 0]));
      repository.activateSearchGeneration("batch-key-generation", 1025, stamp);
      const expected = repository.listSearchFragmentKeys("batch-key-generation"), baseline = database.serialize();
      const statements = vi.spyOn(database, "prepare"), batches = [];
      for (const batch of repository.iterateSearchFragmentKeyBatches("batch-key-generation")) {
        expect(database.inTransaction).toBe(false); batches.push(batch);
      }
      expect(batches.map((batch) => batch.length)).toEqual([512, 512, 1]);
      expect(batches.flat()).toEqual(expected);
      expect(statements.mock.calls).toHaveLength(3);
      expect(statements.mock.calls.every(([sql]) => !sql.includes("vector") && !sql.includes("SELECT *"))).toBe(true);
      statements.mockRestore();
      expect(repository.listSearchFragmentKeys("batch-key-generation", expected[511]!.id, 512)).toEqual(expected.slice(512, 1024));
      expect(repository.listSearchFragmentKeys("batch-key-generation", expected.at(-1)!.id, 512)).toEqual([]);
      expect(Array.from(repository.iterateSearchFragmentKeyBatches("missing-generation"))).toEqual([]);
      expect(database.serialize().equals(baseline)).toBe(true);
    } finally { vi.restoreAllMocks(); database.close(); }
  });
});
