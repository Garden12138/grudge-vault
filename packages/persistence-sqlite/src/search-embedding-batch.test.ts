import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@grudge-vault/shared";
import { runMigrations, SqliteRecordRepository } from "./index";

describe("bounded atomic search embedding writes", () => {
  function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "grudge-vault-embedding-batch-"));
    const database = new Database(join(directory, "synthetic.sqlite3"));
    database.pragma("journal_mode = WAL"); database.pragma("synchronous = FULL"); database.pragma("foreign_keys = ON");
    runMigrations(database);
    const other = new Database(join(directory, "synthetic.sqlite3"), { timeout: 0 });
    const repository = new SqliteRecordRepository(database, () => Buffer.alloc(32));
    const stamp = "2026-10-02T00:00:00Z";
    database.prepare(`INSERT INTO redesign_records(id, origin, categories_json, title, summary, revision,
      occurred_at_json, recorded_at, report_state, created_at, updated_at)
      VALUES ('synthetic-record', 'manual', '["rights"]', '合成批次', '', 1, '{"kind":"unknown"}', ?, 'queued', ?, ?)`)
      .run(stamp, stamp, stamp);
    const create = (id: string) => repository.createSearchGeneration({ id, adapterIdentity: "synthetic", adapterVersion: 1,
      dimensions: 2, normalization: "l2", inputModalities: ["text"], state: "building", fragmentCount: 0, createdAt: stamp });
    const item = (index: number) => ({ fragment: { id: `fragment-${String(index).padStart(3, "0")}`, recordId: "synthetic-record",
      recordRevision: 1, sourceVersion: "v1", modality: "text" as const, contentHash: "a".repeat(64), text: `合成片段 ${index}`,
      anchor: { sourceVersion: "v1" } }, vector: new Float32Array([1, 0]) });
    create("old"); repository.putSearchEmbedding("old", item(0).fragment, item(0).vector);
    repository.activateSearchGeneration("old", 1, stamp); create("new");
    return { database, other, repository, item, stamp,
      dispose() { vi.restoreAllMocks(); other.close(); database.close(); rmSync(directory, { recursive: true, force: true }); } };
  }

  it("writes a maximum-size batch in one writer transaction and never mutates the old active generation", () => {
    const test = fixture();
    try {
      const old = test.repository.listSearchEmbeddings("old"), rows = test.repository.putSearchEmbedding.bind(test.repository);
      const write = vi.spyOn(test.repository, "putSearchEmbedding").mockImplementation((...args) => {
        expect(test.database.inTransaction).toBe(true); rows(...args);
      });
      const transaction = vi.spyOn(test.database, "transaction");
      const fence = vi.fn(() => {
        expect(test.database.inTransaction).toBe(true);
        expect(() => test.other.prepare("INSERT INTO workspace_settings(key, value_json, updated_at) VALUES ('blocked', 'true', ?)")
          .run(test.stamp)).toThrow(/locked/);
        expect(test.other.prepare("SELECT count(*) FROM redesign_search_embeddings WHERE generation_id = 'new'").pluck().get()).toBe(0);
      });
      const items = Array.from({ length: 64 }, (_, index) => test.item(index));
      test.repository.putSearchEmbeddings("new", items, fence);
      expect(transaction).toHaveBeenCalledTimes(1); expect(fence).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(64);
      expect(test.database.inTransaction).toBe(false);
      expect(test.repository.listSearchEmbeddings("new")).toEqual(items);
      expect(test.other.prepare("SELECT count(*) FROM redesign_search_embeddings WHERE generation_id = 'new'").pluck().get()).toBe(64);
      expect(test.repository.listSearchEmbeddings("old")).toEqual(old);
      expect(test.repository.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe("old");
      expect(test.database.pragma("synchronous", { simple: true })).toBe(2);
    } finally { test.dispose(); }
  });

  it("rejects oversized batches before acquiring a writer lock or invoking the fence", () => {
    const test = fixture();
    try {
      const transaction = vi.spyOn(test.database, "transaction"), fence = vi.fn();
      expect(() => test.repository.putSearchEmbeddings("new", Array.from({ length: 65 }, (_, index) => test.item(index)), fence))
        .toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
      expect(transaction).not.toHaveBeenCalled(); expect(fence).not.toHaveBeenCalled();
      expect(test.repository.listSearchFragmentKeys("new")).toEqual([]);
    } finally { test.dispose(); }
  });

  it.each(["dimension", "duplicate", "foreign-key"] as const)("rolls back every row after a late %s failure", (failure) => {
    const test = fixture();
    try {
      const old = test.repository.listSearchEmbeddings("old"), second = test.item(1);
      if (failure === "dimension") second.vector = new Float32Array([1]);
      if (failure === "duplicate") second.fragment.id = test.item(0).fragment.id;
      if (failure === "foreign-key") second.fragment.recordId = "missing-synthetic-record";
      const fence = vi.fn();
      expect(() => test.repository.putSearchEmbeddings("new", [test.item(0), second], fence)).toThrow();
      expect(fence).toHaveBeenCalledTimes(1); expect(test.database.inTransaction).toBe(false);
      expect(test.repository.listSearchFragmentKeys("new")).toEqual([]);
      expect(test.repository.listSearchEmbeddings("old")).toEqual(old);
      expect(test.repository.listSearchGenerations().find(({ state }) => state === "active")?.id).toBe("old");
    } finally { test.dispose(); }
  });

  it.each(["active", "failed"] as const)("never writes into a %s generation", (state) => {
    const test = fixture();
    try {
      const id = state === "active" ? "old" : "new";
      if (state === "failed") test.repository.failSearchGeneration(id, "SYNTHETIC_FAILURE");
      const before = test.repository.listSearchEmbeddings(id);
      expect(() => test.repository.putSearchEmbeddings(id, [test.item(2)], () => {}))
        .toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
      expect(test.repository.listSearchEmbeddings(id)).toEqual(before);
    } finally { test.dispose(); }
  });

  it("executes the synchronous scope fence under the lock before any row can be written", () => {
    const test = fixture();
    try {
      const write = vi.spyOn(test.repository, "putSearchEmbedding"), stopped = new AppError("SOURCE_UNAVAILABLE", "Synthetic closed scope");
      expect(() => test.repository.putSearchEmbeddings("new", [test.item(0)], () => {
        expect(test.database.inTransaction).toBe(true); throw stopped;
      })).toThrow(stopped);
      expect(write).not.toHaveBeenCalled(); expect(test.repository.listSearchFragmentKeys("new")).toEqual([]);
      expect(test.database.inTransaction).toBe(false);
    } finally { test.dispose(); }
  });
});
